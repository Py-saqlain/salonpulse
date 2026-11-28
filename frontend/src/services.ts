import type { Appointment } from './data';
export type Service = { upcomingCount?:number; id: string; name: string; category: string; description: string; minutes: number; price: number; active: boolean };
export type ServiceInput = Omit<Service, 'id'>;
export const normalizeServiceName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
export function validateService(input: ServiceInput, services: Service[], excludeId?: string): string | null {
  if (!input.name.trim()) return 'Enter a service name.';
  if (input.name.trim().length > 200 || input.category.length > 100 || input.description.length > 2000) return 'Use up to 200 characters for the name, 100 for category and 2,000 for description.';
  if (!Number.isSafeInteger(input.minutes) || input.minutes <= 0 || input.minutes > 1440) return 'Duration must be a whole number from 1 to 1,440 minutes.';
  if (!Number.isFinite(input.price) || input.price < 0 || input.price > 9999999999.99 || Number(input.price.toFixed(2)) !== input.price) return 'Price must be between PKR 0 and 9,999,999,999.99, with at most two decimal places.';
  if (typeof input.active !== 'boolean') return 'Choose an active status.';
  if (input.active && services.some(service => service.active && service.id !== excludeId && normalizeServiceName(service.name) === normalizeServiceName(input.name))) return 'An active service already uses this name. Choose a different name or edit the existing service.';
  return null;
}
export function bookingService(input: { serviceId: string; recalculateService?: boolean }, services: Service[], existing?: Appointment): { name: string; minutes: number; price: number } | string {
  const service = services.find(service => service.id === input.serviceId);
  if (!service) return 'Choose a service.';
  if (existing?.serviceId === input.serviceId && !input.recalculateService) return { name: existing.service, minutes: existing.minutes, price: existing.price };
  if (!service.active) return 'This service is inactive. Keep the original booked terms or choose an active service.';
  if (existing && !input.recalculateService) return 'Confirm using current catalog price and duration for the selected service.';
  return { name: service.name, minutes: service.minutes, price: service.price };
}
export function upcomingServiceBookings(id: string, appointments: Appointment[], now = Date.now()) {
  return appointments.filter(item => item.serviceId === id && item.status !== 'Completed' && item.status !== 'Cancelled' && Date.parse(item.endUTC) > now);
}
