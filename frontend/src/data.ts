export type Page = 'dashboard' | 'appointments' | 'customers' | 'staff' | 'services' | 'analytics' | 'audit';
export type Appointment = { startUTC: string; endUTC: string; timeZone: string; id: string; bookingType: 'Scheduled' | 'Walk-in'; customerId: string; customer: string; initials: string; serviceId: string; service: string; staffId: string; staff: string; date: string; time: string; minutes: number; price: number; status: 'Confirmed' | 'In progress' | 'Completed' | 'Cancelled' };
export type BookingInput = { bookingType?: 'Scheduled' | 'Walk-in'; recalculateService?: boolean; customerId: string; serviceId: string; staffId: string; date: string; time: string };
export const formatPKR = (value: number) => `PKR ${value.toLocaleString('en-PK')}`;
export const startsAt = (item: Pick<Appointment, 'startUTC'>) => Date.parse(item.startUTC);
export const formatTime = (item: Appointment) => new Intl.DateTimeFormat('en-PK', { timeZone: item.timeZone, hour: 'numeric', minute: '2-digit' }).format(startsAt(item));
