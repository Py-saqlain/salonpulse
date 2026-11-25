import { bookingPayload, validateAppointment } from './appointments';
import type { AppointmentDTO, AppointmentStatus } from './appointments';
import type { Appointment, BookingInput } from './data';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { checkRecord, customerFromAPI, customerToAPI, readCatalog, requiresDeactivationConfirmation, resourceError, serviceToAPI, staffToAPI } from './catalog';
import type { Catalog, CustomerDTO, Resource, ServiceDTO, StaffDTO } from './catalog';
import type { CustomerInput } from './customers';
import { validateCustomer } from './customers';
import type { StaffInput } from './staff';
import { validateStaff } from './staff';
import type { ServiceInput } from './services';
import { validateService } from './services';

const empty = (): Catalog => ({ customers: [], staff: [], services: [], appointments: [] });

export function useCatalog() {
  const { api, session } = useAuth();
  const businessId = session!.business.id;
  const zone = session!.business.timezone;
  const owner = session!.user.role === 'owner';
  const [data, setData] = useState<Catalog>(empty);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [loaded, setLoaded] = useState(false);
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
    setLoading(true); setReady(false);
    try {
      const next = await readCatalog(api, businessId, abort.signal, zone);
      if (alive.current && request === version.current && !abort.signal.aborted) { setData(next); setReady(true); setLoaded(true); setError(''); }
    } catch (reason) {
      if (alive.current && request === version.current && !abort.signal.aborted) { abort.abort(); setError(resourceError(reason)); }
    } finally { if (alive.current && request === version.current) { refreshing.current = false; setLoading(false); } }
  }, [api, businessId, zone]);

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

  async function write<T>(action: () => Promise<T>): Promise<T | string> {
    if (!alive.current || writing.current || refreshing.current || !ready || loading) return 'Please wait for the directory to finish loading.';
    writing.current = true; setBusy(true); setNotice('');
    try {
      const result = await action();
      if (!alive.current) return 'Your session has ended.';
      if (result === false) return result;
      setNotice('Saved to your business.');
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
    const result = await write(async () => { await api.request<void>(`/api/${resource}/${id}`, { method: 'DELETE' }); return true; });
    return typeof result === 'string' ? result : null;
  }
  async function saveAppointment(input: BookingInput, original?: Appointment) {
    if (!ready || loading) return 'Wait for business records to finish loading.';
    const validation = validateAppointment(input, data, zone, original); if (validation) return validation;
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
  return { ...data, loading, ready, loaded, busy, error, notice, owner, refresh, saveCustomer, saveStaff, saveService, remove, saveAppointment, changeAppointment };
}
