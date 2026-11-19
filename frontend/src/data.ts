export type Page = 'dashboard' | 'appointments' | 'customers' | 'staff' | 'services' | 'analytics';
export const customers = ['Hamza Ahmed', 'Ayesha Khan', 'Usman Tariq', 'Fatima Noor', 'Zain Shah'];
export const staffMembers = ['Ali Raza', 'Sana Malik', 'Bilal Hassan'];
export const services = [
  { name: 'Signature haircut & beard', minutes: 45, price: 2500 },
  { name: 'Hair colour & styling', minutes: 90, price: 8500 },
  { name: 'Haircut & wash', minutes: 30, price: 1800 },
  { name: 'Facial & skin care', minutes: 60, price: 4500 },
  { name: 'Beard trim & shaping', minutes: 30, price: 1200 },
];
export type Appointment = { id: string; bookingType?: 'Scheduled' | 'Walk-in'; customer: string; initials: string; service: string; staff: string; date: string; time: string; minutes: number; price: number; status: 'Confirmed' | 'In progress' | 'Completed' | 'Cancelled' };
export type BookingInput = { bookingType?: 'Scheduled' | 'Walk-in'; customer: string; service: string; staff: string; date: string; time: string };
export const STORAGE_KEY = 'salonpulse.appointments.v1';
export const formatPKR = (value: number) => `PKR ${value.toLocaleString('en-PK')}`;
export function lahoreDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export const startsAt = (item: { date: string; time: string }) => new Date(`${item.date}T${item.time}:00+05:00`).getTime();
export const formatTime = (item: Appointment) => new Intl.DateTimeFormat('en-PK', { timeZone: 'Asia/Karachi', hour: 'numeric', minute: '2-digit' }).format(startsAt(item));
export function seedAppointments(): Appointment[] {
  return services.map((service, i) => ({ id: `seed-${i}`, customer: customers[i], initials: customers[i].split(' ').map(n => n[0]).join(''), service: service.name, staff: staffMembers[[0, 1, 2, 1, 0][i]], date: lahoreDate(), time: ['10:00', '11:00', '12:30', '14:00', '15:30'][i], minutes: service.minutes, price: service.price, status: i === 0 ? 'Completed' : 'Confirmed' }));
}
export function validateBooking(input: BookingInput, items: Appointment[], now = Date.now(), excludeId?: string): string | null {
  if (input.bookingType !== undefined && !['Scheduled', 'Walk-in'].includes(input.bookingType)) return 'Choose a valid booking type.';
  const service = services.find(s => s.name === input.service);
  if (!customers.includes(input.customer) || !staffMembers.includes(input.staff) || !service || !input.date || !input.time) return 'Choose a customer, service, staff member, date and start time.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)) return 'Enter a valid date and start time.';
  const start = startsAt(input);
  if (!Number.isFinite(start) || lahoreDate(new Date(start)) !== input.date) return 'Enter a valid appointment date.';
  if (start < now) return 'Choose a future start time in Lahore (PKT).';
  const end = start + service.minutes * 60000;
  if (items.some(item => item.id !== excludeId && item.status !== 'Cancelled' && item.staff === input.staff && start < startsAt(item) + item.minutes * 60000 && end > startsAt(item))) return 'This staff member already has an overlapping appointment. Choose another time or staff member.';
  return null;
}
export function makeAppointment(input: BookingInput): Appointment {
  const service = services.find(s => s.name === input.service)!;
  return { ...input, id: crypto.randomUUID(), initials: input.customer.split(' ').map(n => n[0]).join(''), minutes: service.minutes, price: service.price, status: 'Confirmed' };
}
export function loadAppointments(): { items: Appointment[]; warning: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { items: seedAppointments(), warning: '' };
    const items: unknown = JSON.parse(raw);
    if (!Array.isArray(items) || !items.every(item => item && typeof item.id === 'string' && customers.includes(item.customer) && staffMembers.includes(item.staff) && services.some(s => s.name === item.service && s.minutes === item.minutes && s.price === item.price) && typeof item.initials === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && /^([01]\d|2[0-3]):[0-5]\d$/.test(item.time) && Number.isFinite(startsAt(item)) && ['Confirmed', 'Completed', 'In progress', 'Cancelled'].includes(item.status))) throw new Error('Invalid stored data');
    return { items, warning: '' };
  } catch {
    return { items: seedAppointments(), warning: 'Saved demo data could not be loaded. Showing sample appointments; saving may replace the previous local data.' };
  }
}
