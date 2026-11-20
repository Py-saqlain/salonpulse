import { seedStaff, validateStaff, availabilityError } from './staff';
import type { Staff } from './staff';
import { seedCustomers, normalizePhone } from './customers';
import type { Customer } from './customers';
export type Page = 'dashboard' | 'appointments' | 'customers' | 'staff' | 'services' | 'analytics';
export const services = [
  { name: 'Signature haircut & beard', minutes: 45, price: 2500 },
  { name: 'Hair colour & styling', minutes: 90, price: 8500 },
  { name: 'Haircut & wash', minutes: 30, price: 1800 },
  { name: 'Facial & skin care', minutes: 60, price: 4500 },
  { name: 'Beard trim & shaping', minutes: 30, price: 1200 },
];
export type Appointment = { id: string; bookingType?: 'Scheduled' | 'Walk-in'; customerId: string; customer: string; initials: string; service: string; staffId: string; staff: string; date: string; time: string; minutes: number; price: number; status: 'Confirmed' | 'In progress' | 'Completed' | 'Cancelled' };
export type BookingInput = { bookingType?: 'Scheduled' | 'Walk-in'; customerId: string; service: string; staffId: string; date: string; time: string };
export const STORAGE_KEY = 'salonpulse.demo.v3';
export type DemoStore = { customers: Customer[]; staff: Staff[]; appointments: Appointment[] };
export const formatPKR = (value: number) => `PKR ${value.toLocaleString('en-PK')}`;
export function lahoreDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export const startsAt = (item: { date: string; time: string }) => new Date(`${item.date}T${item.time}:00+05:00`).getTime();
export const formatTime = (item: Appointment) => new Intl.DateTimeFormat('en-PK', { timeZone: 'Asia/Karachi', hour: 'numeric', minute: '2-digit' }).format(startsAt(item));
export function seedAppointments(): Appointment[] {
  return services.map((service, i) => ({ id: `seed-${i}`, customerId: seedCustomers[i].id, customer: seedCustomers[i].name, initials: seedCustomers[i].name.split(' ').map(n => n[0]).join(''), service: service.name, staffId: seedStaff[[0, 1, 2, 1, 0][i]].id, staff: seedStaff[[0, 1, 2, 1, 0][i]].name, date: lahoreDate(), time: ['10:00', '11:00', '12:30', '14:00', '15:30'][i], minutes: service.minutes, price: service.price, status: i === 0 ? 'Completed' : 'Confirmed' }));
}
export function validateBooking(input: BookingInput, items: Appointment[], now = Date.now(), excludeId?: string, customers: Customer[] = seedCustomers, staff: Staff[] = seedStaff): string | null {
  if (input.bookingType !== undefined && !['Scheduled', 'Walk-in'].includes(input.bookingType)) return 'Choose a valid booking type.';
  const service = services.find(s => s.name === input.service);
  if (!customers.some(customer => customer.id === input.customerId) || !staff.some(member => member.id === input.staffId) || !service || !input.date || !input.time) return 'Choose a customer, service, staff member, date and start time.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) return 'Enter a valid date and start time.';
  const start = startsAt(input);
  if (!Number.isFinite(start) || lahoreDate(new Date(start)) !== input.date) return 'Enter a valid appointment date.';
  if (start < now) return 'Choose a future start time in Lahore (PKT).';
  const availability = availabilityError(staff.find(member => member.id === input.staffId), input.date, input.time, service.minutes);
  if (availability) return availability;
  const end = start + service.minutes * 60000;
  if (items.some(item => item.id !== excludeId && item.status !== 'Cancelled' && item.staffId === input.staffId && start < startsAt(item) + item.minutes * 60000 && end > startsAt(item))) return 'This staff member already has an overlapping appointment. Choose another time or staff member.';
  return null;
}
export function makeAppointment(input: BookingInput, customers: Customer[] = seedCustomers, staff: Staff[] = seedStaff): Appointment {
  const service = services.find(s => s.name === input.service)!;
  const customer = customers.find(item => item.id === input.customerId)!;
  return { ...input, staff: staff.find(member => member.id === input.staffId)!.name, customer: customer.name, id: crypto.randomUUID(), initials: customer.name.split(' ').map(n => n[0]).join(''), minutes: service.minutes, price: service.price, status: 'Confirmed' };
}
export function loadStore(): { store: DemoStore; warning: string } {
  const fallback = { staff: seedStaff.map(item => ({ ...item, hours: item.hours?.map(day => ({ ...day })) ?? null })), customers: seedCustomers.map(item => ({ ...item })), appointments: seedAppointments() };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    let store: DemoStore;
    const previous = raw === null ? localStorage.getItem('salonpulse.demo.v2') : null;
    if (raw !== null) store = JSON.parse(raw);
    else if (previous !== null) store = JSON.parse(previous);
    else {
      const legacy = localStorage.getItem('salonpulse.appointments.v1');
      if (legacy === null) return { store: fallback, warning: '' };
      const rows = JSON.parse(legacy);
      if (!Array.isArray(rows)) throw new Error('Invalid appointments');
      const customers = fallback.customers;
      const appointments = rows.map(item => {
        if (!item || typeof item.customer !== 'string' || !item.customer.trim()) throw new Error('Invalid customer');
        let customer = customers.find(customer => customer.name === item.customer);
        if (!customer) { customer = { id: crypto.randomUUID(), name: item.customer, phone: '', notes: '' }; customers.push(customer); }
        return { ...item, customerId: customer.id };
      });
      store = { customers, staff: fallback.staff, appointments };
    }
    if (!store || !Array.isArray(store.customers) || !Array.isArray(store.appointments)) throw new Error('Invalid store');
    if (raw === null) {
      store.staff = fallback.staff;
      for (const item of store.appointments) {
        if (!item || typeof item.staff !== 'string' || !item.staff.trim()) throw new Error('Invalid staff reference');
        let member = store.staff.find(member => member.name === item.staff);
        if (!member) { member = { id: crypto.randomUUID(), name: item.staff, phone: '', specialty: '', active: false, hours: null }; store.staff.push(member); }
        item.staffId = member.id;
      }
    }
    if (!Array.isArray(store.staff)) throw new Error('Invalid staff directory');
    const staffIds = new Set<string>();
    for (const member of store.staff) {
      if (!member || typeof member.id !== 'string' || !member.id || staffIds.has(member.id) || typeof member.name !== 'string' || typeof member.phone !== 'string' || typeof member.specialty !== 'string' || normalizePhone(member.phone) !== member.phone || validateStaff(member, store.staff, member.id)) throw new Error('Invalid staff');
      staffIds.add(member.id);
    }
    const ids = new Set<string>(); const phones = new Set<string>();
    for (const c of store.customers) {
      if (!c || typeof c.id !== 'string' || !c.id || ids.has(c.id) || typeof c.name !== 'string' || !c.name.trim() || typeof c.phone !== 'string' || normalizePhone(c.phone) !== c.phone || typeof c.notes !== 'string' || (c.phone && phones.has(c.phone))) throw new Error('Invalid customer');
      ids.add(c.id); if (c.phone) phones.add(c.phone);
    }
    const appointmentIds = new Set<string>();
    for (const item of store.appointments) {
      if (!item || typeof item.id !== 'string' || appointmentIds.has(item.id) || !ids.has(item.customerId) || !staffIds.has(item.staffId) || !services.some(s => s.name === item.service && s.minutes === item.minutes && s.price === item.price) || !/^\d{4}-\d{2}-\d{2}$/.test(item.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.time) || !Number.isFinite(startsAt(item)) || lahoreDate(new Date(startsAt(item))) !== item.date || !['Confirmed', 'Completed', 'In progress', 'Cancelled'].includes(item.status)) throw new Error('Invalid appointment');
      appointmentIds.add(item.id);
    }
    if (raw === null) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); }
      catch { return { store, warning: 'Existing bookings were migrated in memory, but browser storage could not save the upgrade. Original storage is unchanged. Enable storage before making changes.' }; }
    }
    return { store, warning: '' };
  } catch {
    return { store: fallback, warning: 'Saved demo data could not be loaded or migrated. Sample data is shown. Existing storage is unchanged until you save a change.' };
  }
}
