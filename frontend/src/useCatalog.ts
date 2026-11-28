import { readWorkspace } from './workspace';
import type {Query, Stats} from './workspace';
import { bookingPayload, validateAppointment } from './appointments';
import type { AppointmentDTO, AppointmentStatus } from './appointments';
import type { Appointment, BookingInput } from './data';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { checkRecord, staffFromAPI, serviceFromAPI, customerFromAPI, customerToAPI, requiresDeactivationConfirmation, resourceError, serviceToAPI, staffToAPI } from './catalog';
import type { Catalog, CustomerDTO, Resource, ServiceDTO, StaffDTO } from './catalog';
import type { CustomerInput } from './customers';
import { validateCustomer } from './customers';
import type { StaffInput } from './staff';
import { validateStaff } from './staff';
import type { ServiceInput } from './services';
import { validateService } from './services';

const empty = () => ({ customers: [], staff: [], services: [], appointments: [], appointmentTotal:0,total:0,history:[],historyTotal:0,stats:null } as Catalog & {appointmentTotal:number;total:number;history:Appointment[];historyTotal:number;stats:Stats|null});

export function useCatalog(view: string) {
  const { api, session } = useAuth();
  const businessId = session!.business.id;
  const zone = session!.business.timezone;
  const owner = session!.user.role === 'owner';
  const [data, setData] = useState(empty);
  const [selection,setSelection]=useState<{view:string;query:Query}>({view,query:{}});
  const query=selection.view===view?selection.query:{};
  const requestKey=JSON.stringify(query);
  const [loading, setLoading] = useState(true);
  const [startedKey,setStartedKey]=useState('');
  const [readyKey,setReadyKey]=useState('');
  const targetKey=view+'|'+requestKey;
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadedView,setLoadedView]=useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(false); const writing = useRef(false); const refreshing = useRef(false);
  const version = useRef(0); const controller = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    // Coalesce clicks/focus events before React has rendered the loading state.
    if (!alive.current || refreshing.current) return;
    refreshing.current = true;
    const request = ++version.current;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setStartedKey(targetKey);setLoading(true); setReady(false);
    try {
      if (JSON.parse(requestKey).q) await new Promise(resolve=>setTimeout(resolve,250));
      if(abort.signal.aborted)return;
      const next = await readWorkspace(api, businessId, view, JSON.parse(requestKey), abort.signal, zone);
      const lastPage=Math.max(0,Math.ceil(next.total/20)-1);
      if((query.page??0)>lastPage){setSelection({view,query:{...query,page:lastPage}});return;}
      if (alive.current && request === version.current && !abort.signal.aborted) { setData(next);setReadyKey(targetKey); setReady(true); setLoaded(true);setLoadedView(view); setError(''); }
    } catch (reason) {
      if (alive.current && request === version.current && !abort.signal.aborted) { abort.abort(); setError(resourceError(reason)); }
    } finally { if (alive.current && request === version.current) { refreshing.current = false; setLoading(false); } }
  }, [api, businessId, zone, view, requestKey]);

  useEffect(() => {
    alive.current = true; void refresh();
    const focus = () => {
      // Returning from a native confirmation or another window must not unmount
      // an editor that owns a draft or validation feedback. Revalidate after it
      // closes (on the next focus or an explicit directory refresh).
      const editorOpen = document.querySelector('[data-catalog-editor]') !== null;
      if (!writing.current && !editorOpen && document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', focus);
    return () => { alive.current = false; version.current++; controller.current?.abort(); refreshing.current = false; window.removeEventListener('focus', focus); };
  }, [refresh]);

  async function write<T>(action: () => Promise<T>, nextQuery?:Query): Promise<T | string> {
    if (!alive.current || writing.current || refreshing.current || !ready || loading) return 'Please wait for the directory to finish loading.';
    writing.current = true; setBusy(true); setNotice('');
    try {
      const result = await action();
      if (!alive.current) return 'Your session has ended.';
      if (result === false) return result;
      setNotice('Saved to your business.');
      if(nextQuery){setReady(false);setSelection({view,query:nextQuery});return result;}
      await refresh();
      return result;
    } catch (reason) { return resourceError(reason); }
    finally { writing.current = false; if (alive.current) setBusy(false); }
  }

  async function saveCustomer(input: CustomerInput, id?: string) {
    const validation = validateCustomer(input, data.customers, id); if (validation) return validation;
    return write(async () => customerFromAPI(checkRecord(await api.request<CustomerDTO>(`/api/customers${id ? '/' + id : ''}`, { method: id ? 'PATCH' : 'POST', body: customerToAPI(input) }), businessId)));
  }
  async function saveCatalog(resource: 'staff' | 'services', body: object, id?: string) {
    if (!owner) return 'Only the business owner can change staff or services.';
    const result = await write(async () => {
      const send = (confirmed = false) => api.request<StaffDTO | ServiceDTO>(`/api/${resource}${id ? '/' + id : ''}`, { method: id ? 'PATCH' : 'POST', body: confirmed ? { ...body, confirm_upcoming: true } : body });
      let record;
      try { record = await send(); }
      catch (reason) {
        if (!alive.current || !requiresDeactivationConfirmation(reason)) throw reason;
        if (!window.confirm('Upcoming or ongoing appointments remain assigned. Deactivate without cancelling or reassigning these bookings?')) return false;
        if (!alive.current) return false;
        record = await send(true);
      }
      checkRecord(record, businessId);
      return true;
    });
    return typeof result === 'string' ? result : result ? null : 'Deactivation was not saved. Existing bookings are unchanged.';
  }
  async function saveStaff(input: StaffInput, id?: string) {
    const validation = validateStaff(input, data.staff, id); if (validation) return validation;
    return saveCatalog('staff', staffToAPI(input), id);
  }
  async function saveService(input: ServiceInput, id?: string) {
    const validation = validateService(input, data.services, id); if (validation) return validation;
    return saveCatalog('services', serviceToAPI(input), id);
  }
  async function remove(resource: Resource, id: string) {
    if (resource !== 'customers' && !owner) return 'Only the business owner can delete staff or services.';
    if (!window.confirm('Permanently delete this record? Records referenced by appointments cannot be deleted.')) return null;
    const result = await write(async () => { await api.request<void>(`/api/${resource}/${id}`, { method: 'DELETE' }); return true; }, resource==='customers' && query.customer_id===id?{...query,customer_id:undefined,history_page:undefined}:undefined);
    return typeof result === 'string' ? result : null;
  }
  async function saveAppointment(input: BookingInput, original?: Appointment) {
    if (!ready || loading) return 'Wait for business records to finish loading.';
    const records={...data};
    try {
      const [customer,member,service]=await Promise.all([
        data.customers.find(x=>x.id===input.customerId)??api.request<CustomerDTO>('/api/customers/'+input.customerId).then(x=>customerFromAPI(checkRecord(x,businessId))),
        data.staff.find(x=>x.id===input.staffId)??api.request<StaffDTO>('/api/staff/'+input.staffId).then(x=>staffFromAPI(checkRecord(x,businessId))),
        data.services.find(x=>x.id===input.serviceId)??api.request<ServiceDTO>('/api/services/'+input.serviceId).then(x=>serviceFromAPI(checkRecord(x,businessId))),
      ]);records.customers=[customer];records.staff=[member];records.services=[service];
    }catch(reason){return resourceError(reason);}
    const validation = validateAppointment(input, records, zone, original); if (validation) return validation;
    const body = bookingPayload(input, zone, original); if (body === null) return null;
    const result = await write(async () => {
      checkRecord(await api.request<AppointmentDTO>(`/api/appointments${original ? '/' + original.id : ''}`, { method: original ? 'PATCH' : 'POST', body }), businessId);
      return true;
    });
    return typeof result === 'string' ? result : null;
  }
  async function changeAppointment(item: Appointment, status: AppointmentStatus) {
    if (status === 'cancelled' && !window.confirm('Cancel this appointment? It remains in customer history and the staff slot becomes available.')) return null;
    const result = await write(async () => {
      await api.request(`/api/appointments/${item.id}`, status === 'cancelled' ? { method: 'DELETE' } : { method: 'PATCH', body: { status } });
      return true;
    });
    return typeof result === 'string' ? result : null;
  }
  const updateQuery=(patch:Query)=>setSelection(old=>({view,query:Object.fromEntries(Object.entries({...old.view===view?old.query:{},...patch}).filter(([,value])=>value!==''&&value!==0&&value!==undefined).sort(([a],[b])=>a.localeCompare(b)))}));
  const remote={total:data.total,page:query.page??0,pages:Math.max(1,Math.ceil(data.total/20)),setPage:(page:number)=>updateQuery({page}),filter:(patch:Query)=>updateQuery({...patch,page:0}),history:data.history,historyTotal:data.historyTotal,historyPage:query.history_page??0,selectCustomer:(id:string)=>{setData(old=>({...old,history:[],historyTotal:0}));updateQuery({customer_id:id,history_page:0});},setHistoryPage:(page:number)=>updateQuery({history_page:page})};
  return { ...data, remote, loading:loading||startedKey!==targetKey, ready:ready&&readyKey===targetKey, loaded:loaded&&loadedView===view, busy, error, notice, owner, refresh, saveCustomer, saveStaff, saveService, remove, saveAppointment, changeAppointment };
}
