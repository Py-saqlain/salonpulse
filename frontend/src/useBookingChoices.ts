import {useEffect,useRef,useState} from 'react';
import {useAuth} from './AuthContext';
import {bookingOptions} from './workspace';
import {checkRecord} from './catalog';
import type {Resource,TenantDTO} from './catalog';
export function useBookingChoices<T extends {id:string},D extends TenantDTO>(resource:Resource,initial:T[],selected:string,convert:(value:D)=>T) {
 const {api,session}=useAuth();const business=session!.business.id;
 const [items,setItems]=useState<T[]>(initial.slice(0,20)),[q,setQ]=useState(''),[page,setPage]=useState(0),[total,setTotal]=useState(0);
 const [loading,setLoading]=useState(true),[selecting,setSelecting]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 const selectedRef=useRef(selected);selectedRef.current=selected;
 const itemsRef=useRef(items);itemsRef.current=items;
 const rowsRef=useRef(initial.slice(0,20)),pinned=useRef<T|undefined>(undefined);
 function combine(rows:T[],item?:T){return item&&!rows.some(row=>row.id===item.id)?[...rows,item]:rows;}
 useEffect(()=>{
  const abort=new AbortController();setLoading(true);setError('');
  const timer=setTimeout(()=>{void (async()=>{
   const value=await bookingOptions(api,business,resource,q,page*20,abort.signal);
   const rows=value.items.map(item=>convert(item as unknown as D));
   const id=selectedRef.current;
   let item=rows.find(row=>row.id===id)??(pinned.current?.id===id?pinned.current:undefined);
   if(id&&!item){const dto=await api.request<D>(`/api/${resource}/${id}`,{signal:abort.signal});item=convert(checkRecord(dto,business));}
   if(!abort.signal.aborted){rowsRef.current=rows;pinned.current=item;setItems(combine(rows,item));setTotal(value.total);}
  })().catch(reason=>{if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:'Options unavailable.');}).finally(()=>{if(!abort.signal.aborted)setLoading(false);});},q?250:0);
  return()=>{clearTimeout(timer);abort.abort();};
 },[api,business,resource,q,page,convert,revision]);
 useEffect(()=>{
  const abort=new AbortController(),known=itemsRef.current.find(row=>row.id===selected);
  if(!selected||known){pinned.current=known;setSelecting(false);return()=>abort.abort();}
  setSelecting(true);setError('');
  void api.request<D>(`/api/${resource}/${selected}`,{signal:abort.signal}).then(dto=>{if(!abort.signal.aborted){const item=convert(checkRecord(dto,business));pinned.current=item;setItems(combine(rowsRef.current,item));}})
   .catch(reason=>{if(!abort.signal.aborted)setError(reason instanceof Error?reason.message:'Selected record unavailable.');}).finally(()=>{if(!abort.signal.aborted)setSelecting(false);});
  return()=>abort.abort();
 },[api,business,resource,selected,convert]);
 return {items,include:(item:T)=>{pinned.current=item;setItems(combine(rowsRef.current,item));},retry:()=>setRevision(n=>n+1),q,search:(value:string)=>{setQ(value);setPage(0);},page,setPage,total,loading:loading||selecting,error};
}
export type ChoiceControls=Pick<ReturnType<typeof useBookingChoices>,'q'|'search'|'page'|'setPage'|'total'|'loading'|'error'|'retry'>;
export function choicePages(value:ChoiceControls){return Math.max(1,Math.ceil(value.total/20));}
