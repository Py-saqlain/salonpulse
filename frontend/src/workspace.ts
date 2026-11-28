import type { ApiClient } from './api';
import type { CustomerDTO,StaffDTO,ServiceDTO,Resource } from './catalog';
import {checkRecord,customerFromAPI,staffFromAPI,serviceFromAPI} from './catalog';
import {appointmentFromAPI} from './appointments';
import type {AppointmentDTO} from './appointments';
import type {Appointment} from './data';
export type Query = {page?:number;q?:string;status?:string;category?:string;day?:string;staff_id?:string;customer_id?:string;history_page?:number};
export type Remote = {total:number;page:number;pages:number;setPage:(page:number)=>void;filter:(query:Query)=>void;history:Appointment[];historyTotal:number;historyPage:number;selectCustomer:(id:string)=>void;setHistoryPage:(page:number)=>void};
export type Stats = {today:string;statuses:Record<Appointment['status'],number>;total:number;active:number;remainingToday:number;upcoming:Appointment[];upcomingTotal:number;workload:{id:string;name:string;active:boolean;appointments:number;minutes:number}[];staffTotal:number;activeStaff:number;customerTotal:number;appointmentTotal:number};
type DTO = {business_id:string;appointmentTotal:number;customers:CustomerDTO[];staff:StaffDTO[];services:ServiceDTO[];appointments:AppointmentDTO[];total:number;history:{items:AppointmentDTO[];total:number}|null;dashboard:(Omit<Stats,'upcoming'>&{upcoming:AppointmentDTO[]})|null};
export async function readWorkspace(api:ApiClient,business:string,view:string,query:Query,signal:AbortSignal,zone:string) {
 if(signal.aborted)throw new Error('Request cancelled');
 const params=new URLSearchParams({view});for(const [key,value] of Object.entries(query))if(value!==''&&value!==undefined)params.set(key,String(value));
 const value=await api.request<DTO>('/api/workspace?'+params,{signal});
 if(signal.aborted)throw new Error('Request cancelled');
 if(value.business_id!==business||!Number.isSafeInteger(value.total)||value.total<0)throw new Error('Workspace identity could not be verified.');
 for(const rows of [value.customers,value.staff,value.services,value.appointments,value.history?.items??[],value.dashboard?.upcoming??[]]) {
  if(!Array.isArray(rows)||rows.length>20)throw new Error('Workspace page exceeded its limit.');
  for(const row of rows)checkRecord(row,business);
 }
 const data={customers:value.customers.map(customerFromAPI),staff:value.staff.map(staffFromAPI),services:value.services.map(serviceFromAPI)};
 const map=(a:AppointmentDTO)=>appointmentFromAPI(a,data,zone);
 return {...data,appointmentTotal:value.appointmentTotal,appointments:value.appointments.map(map),total:value.total,history:value.history?.items.map(map)??[],historyTotal:value.history?.total??0,stats:value.dashboard?{...value.dashboard,upcoming:value.dashboard.upcoming.map(map)}:null};
}
export async function bookingOptions(api:ApiClient,business:string,resource:Resource,q:string,offset:number,signal:AbortSignal) {
 if(signal.aborted)throw new Error('Request cancelled');
 const value=await api.request<{items:(CustomerDTO|StaffDTO|ServiceDTO)[];total:number;limit:number;offset:number}>(`/api/booking-options/${resource}?`+new URLSearchParams({q,offset:String(offset)}),{signal});
 if(signal.aborted)throw new Error('Request cancelled');
 if(!Array.isArray(value.items)||value.items.length>20||value.limit!==20||value.offset!==offset||!Number.isSafeInteger(value.total)||value.total<0)throw new Error('Booking options could not be verified.');
 return {...value,items:value.items.map(item=>checkRecord(item,business))};
}
