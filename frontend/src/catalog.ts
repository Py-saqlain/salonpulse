import { appointmentFromAPI } from './appointments';
import type { AppointmentDTO } from './appointments';
import type { Appointment } from './data';
import { ApiError } from './api';
import type { ApiClient } from './api';
import type { Customer, CustomerInput } from './customers';
import { normalizePhone } from './customers';
import type { Staff, StaffInput, WorkingDay } from './staff';
import type { Service, ServiceInput } from './services';

export type Resource = 'customers' | 'staff' | 'services';
export type TenantDTO = { id: string; business_id: string; created_at: string; updated_at: string };
type RecordDTO = TenantDTO & { name: string };
export type CustomerDTO = RecordDTO & { phone: string | null; notes: string | null };
export type StaffDTO = RecordDTO & { phone: string | null; specialty: string | null; active: boolean; hours: WorkingDay[] | null };
export type ServiceDTO = RecordDTO & { category: string | null; description: string; duration_minutes: number; price: string; active: boolean };
export type Catalog = { customers: Customer[]; staff: Staff[]; services: Service[]; appointments: Appointment[] };
type PageDTO<T> = { items: T[]; total: number; limit: number; offset: number };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkRecord<T extends TenantDTO>(record: T, businessId: string): T {
  if (!uuid.test(record.id) || record.business_id !== businessId) throw new Error('The server returned an unexpected business record. Refresh before continuing.');
  return record;
}
export const customerFromAPI = (item: CustomerDTO): Customer => ({ id: item.id, name: item.name, phone: item.phone ?? '', notes: item.notes ?? '' });
export const staffFromAPI = (item: StaffDTO): Staff => ({ id: item.id, name: item.name, phone: item.phone ?? '', specialty: item.specialty ?? '', active: item.active, hours: item.hours });
export function serviceFromAPI(item: ServiceDTO): Service {
  if (!/^\d+(?:\.\d{1,2})?$/.test(item.price) || !Number.isFinite(Number(item.price)) || Number(item.price) > 9999999999.99) throw new Error('The server returned an invalid service price.');
  return { id: item.id, name: item.name, category: item.category ?? '', description: item.description, minutes: item.duration_minutes, price: Number(item.price), active: item.active };
}
export const customerToAPI = (input: CustomerInput) => ({ name: input.name.trim(), phone: normalizePhone(input.phone) || null, notes: input.notes.trim() || null });
export const staffToAPI = (input: StaffInput) => ({ name: input.name.trim(), phone: normalizePhone(input.phone) || null, specialty: input.specialty.trim() || null, active: input.active, hours: input.hours });
export const serviceToAPI = (input: ServiceInput) => ({ name: input.name.trim(), category: input.category.trim() || null, description: input.description.trim(), duration_minutes: input.minutes, price: input.price.toFixed(2), active: input.active });

export async function readAll<T extends TenantDTO>(api: ApiClient, resource: Resource | 'appointments', businessId: string, signal: AbortSignal): Promise<T[]> {
  const records: T[] = []; const ids = new Set<string>(); let total: number | undefined;
  do {
    if (signal.aborted) throw new Error('Request cancelled');
    const page = await api.request<PageDTO<T>>(`/api/${resource}?limit=100&offset=${records.length}`, { signal });
    if (signal.aborted) throw new Error('Request cancelled');
    if (!Number.isSafeInteger(page.total) || page.total < 0 || page.offset !== records.length || page.limit !== 100 || !Array.isArray(page.items)
      || page.items.length > 100 || (total !== undefined && total !== page.total)) throw new Error('The directory changed while loading. Please refresh.');
    total = page.total;
    for (const item of page.items) {
      checkRecord(item, businessId);
      if (ids.has(item.id)) throw new Error('The directory changed while loading. Please refresh.');
      ids.add(item.id); records.push(item);
    }
    if (records.length > total || (!page.items.length && records.length < total)) throw new Error('The server returned an incomplete directory. Please refresh.');
  } while (records.length < total);
  return records;
}

export async function readCatalog(api: ApiClient, businessId: string, signal: AbortSignal, zone = 'Asia/Karachi'): Promise<Catalog> {
  const [customers, staff, services, appointments] = await Promise.all([
    readAll<CustomerDTO>(api, 'customers', businessId, signal), readAll<StaffDTO>(api, 'staff', businessId, signal), readAll<ServiceDTO>(api, 'services', businessId, signal), readAll<AppointmentDTO>(api, 'appointments', businessId, signal),
  ]);
  const records = { customers: customers.map(customerFromAPI), staff: staff.map(staffFromAPI), services: services.map(serviceFromAPI) };
  return { ...records, appointments: appointments.map(item => appointmentFromAPI(item, records, zone)) };
}

export function resourceError(error: unknown): string {
  if (error instanceof ApiError && Object.keys(error.fields).length) return Object.entries(error.fields).map(([field, message]) => `${field}: ${message}`).join(' ');
  return error instanceof Error ? error.message : 'The change could not be saved. Please try again.';
}

export function requiresDeactivationConfirmation(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.message.includes('confirm_upcoming=true');
}
