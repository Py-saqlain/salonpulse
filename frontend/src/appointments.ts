import type { Appointment, BookingInput } from './data';
import type { Customer } from './customers';
import type { Staff } from './staff';
import type { Service } from './services';
import { bookingService } from './services';
import type { TenantDTO } from './catalog';

export type AppointmentStatus = 'confirmed' | 'in_progress' | 'completed' | 'cancelled';
export type AppointmentDTO = TenantDTO & { customer_id: string; staff_id: string; service_id: string; starts_at: string; ends_at: string; status: AppointmentStatus; booking_type: 'scheduled' | 'walk_in'; booked_price: string; booked_duration_minutes: number; customer_name?: string; staff_name?: string; service_name?: string; payment_summary?: import('./paymentLedger').PaymentSummary };
export type BookingRecords = { customers: Customer[]; staff: Staff[]; services: Service[]; appointments: Appointment[] };
export const statusLabels: Record<AppointmentStatus, Appointment['status']> = { confirmed: 'Confirmed', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };

const dateFormatters=new Map<string,Intl.DateTimeFormat>();
export function localDateTime(value: string | number, zone: string): { date: string; time: string } {
  if(dateFormatters.size>8)dateFormatters.clear();
  const formatter=dateFormatters.get(zone)??new Intl.DateTimeFormat('en-CA', { timeZone: zone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  dateFormatters.set(zone,formatter);
  const parts=formatter.formatToParts(new Date(value));
  const part = (name: string) => parts.find(item => item.type === name)!.value;
  return { date: `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

export function wallTimeToUTC(date: string, time: string, zone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Enter a valid date and start time.');
  const naive = Date.parse(`${date}T${time}:00Z`);
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 16) !== `${date}T${time}`) throw new Error('Enter a valid appointment date.');
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 12) {
    const probe = naive + hours * 3600000;
    const local = localDateTime(probe, zone);
    offsets.add(Date.parse(`${local.date}T${local.time}:00Z`) - probe);
  }
  const candidates = [...offsets].map(offset => naive - offset).filter(value => {
    const local = localDateTime(value, zone); return local.date === date && local.time === time;
  });
  if (candidates.length !== 1) throw new Error('This local time is missing or ambiguous because of a timezone clock change. Choose another time.');
  return new Date(candidates[0]).toISOString();
}

export function appointmentFromAPI(item: AppointmentDTO, records: Pick<BookingRecords, 'customers' | 'staff' | 'services'>, zone: string): Appointment {
  const customer = records.customers.find(record => record.id === item.customer_id) ?? (item.customer_name ? { id: item.customer_id, name: item.customer_name } : undefined);
  const staff = records.staff.find(record => record.id === item.staff_id) ?? (item.staff_name ? { id:item.staff_id, name:item.staff_name } : undefined);
  const service = records.services.find(record => record.id === item.service_id) ?? (item.service_name ? { id:item.service_id, name:item.service_name } : undefined);
  if (!customer || !staff || !service) throw new Error('Booking references changed while loading. Refresh the business records.');
  const start = Date.parse(item.starts_at), end = Date.parse(item.ends_at), price = Number(item.booked_price);
  if (!Number.isFinite(start) || !Number.isFinite(end) || !statusLabels[item.status] || !['scheduled', 'walk_in'].includes(item.booking_type)
    || !/^\d+(?:\.\d{1,2})?$/.test(item.booked_price) || price > 9999999999.99 || !Number.isInteger(item.booked_duration_minutes)
    || item.booked_duration_minutes <= 0 || end - start !== item.booked_duration_minutes * 60000) throw new Error('The server returned an invalid booking.');
  return { id: item.id, customerId: customer.id, customer: customer.name, initials: customer.name.split(/\s+/).map(part => part[0]).join(''),
    staffId: staff.id, staff: staff.name, serviceId: service.id, service: service.name, ...localDateTime(item.starts_at, zone),
    startUTC: item.starts_at, endUTC: item.ends_at, timeZone: zone, minutes: item.booked_duration_minutes, price,
    paymentSummary: item.payment_summary, status: statusLabels[item.status], bookingType: item.booking_type === 'walk_in' ? 'Walk-in' : 'Scheduled' };
}

export function bookingPayload(input: BookingInput, zone: string, original?: Appointment): Record<string, unknown> | null {
  if (!original) return { customer_id: input.customerId, staff_id: input.staffId, service_id: input.serviceId,
    booking_type: input.bookingType === 'Walk-in' ? 'walk_in' : 'scheduled',
    ...(input.bookingType === 'Walk-in' ? {} : { starts_at: wallTimeToUTC(input.date, input.time, zone) }) };
  const body: Record<string, unknown> = {};
  if (input.customerId !== original.customerId) body.customer_id = input.customerId;
  if (input.staffId !== original.staffId) body.staff_id = input.staffId;
  if (input.serviceId !== original.serviceId) body.service_id = input.serviceId;
  if (input.date !== original.date || input.time !== original.time) body.starts_at = wallTimeToUTC(input.date, input.time, zone);
  if (input.recalculateService) body.recalculate_service = true;
  return Object.keys(body).length ? body : null;
}

export function validateAppointment(input: BookingInput, records: BookingRecords, zone: string, original?: Appointment, now = Date.now()): string | null {
  try {
    if (original && original.status !== 'Confirmed') return 'Only confirmed appointments can be edited.';
    const member = records.staff.find(record => record.id === input.staffId);
    const service = records.services.find(record => record.id === input.serviceId);
    if (!records.customers.some(record => record.id === input.customerId) || !member || !service) return 'Choose a customer, service and staff member.';
    if (!member.active || !service.active) return 'Select active staff and service records.';
    const terms = bookingService(input, records.services, original);
    if (typeof terms === 'string') return terms;
    const start = !original && input.bookingType === 'Walk-in' ? now
      : original && input.date === original.date && input.time === original.time && original.startUTC ? Date.parse(original.startUTC)
      : Date.parse(wallTimeToUTC(input.date, input.time, zone));
    if (start < now) return 'Choose a future start time in the business timezone.';
    const end = start + terms.minutes * 60000;
    if (member.hours === null) return 'Working hours are not configured for this employee.';
    const local = localDateTime(start, zone), day = new Date(local.date + 'T12:00:00Z').getUTCDay();
    const shift = member.hours.find(item => item.day === day);
    if (!shift || start < Date.parse(wallTimeToUTC(local.date, shift.start, zone)) || end > Date.parse(wallTimeToUTC(local.date, shift.end, zone))) return 'The entire service must fit within the employee working hours in the business timezone.';
    if (records.appointments.some(item => item.id !== original?.id && item.staffId === member.id && ['Confirmed', 'In progress'].includes(item.status)
      && Date.parse(item.startUTC!) < end && Date.parse(item.endUTC!) > start)) return 'Staff member already has an overlapping appointment.';
    return null;
  } catch (error) { return error instanceof Error ? error.message : 'Check the booking date and timezone.'; }
}
