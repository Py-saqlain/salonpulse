import type { Appointment } from './data';
export type Service = { id: string; name: string; category: string; description: string; minutes: number; price: number; active: boolean };
export type ServiceInput = Omit<Service, 'id'>;
export const seedServices: Service[] = [
  { name: 'Signature haircut & beard', minutes: 45, price: 2500, category: 'Hair & grooming' },
  { name: 'Hair colour & styling', minutes: 90, price: 8500, category: 'Hair & grooming' },
  { name: 'Haircut & wash', minutes: 30, price: 1800, category: 'Hair & grooming' },
  { name: 'Facial & skin care', minutes: 60, price: 4500, category: 'Skin care' },
  { name: 'Beard trim & shaping', minutes: 30, price: 1200, category: 'Hair & grooming' },
].map((service, i) => ({ ...service, id: `service-${i}`, description: '', active: true }));
export const normalizeServiceName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
export function validateService(input: ServiceInput, services: Service[], excludeId?: string): string | null {
  if (!input.name.trim()) return 'Enter a service name.';
  if (input.name.trim().length > 100 || input.category.length > 100 || input.description.length > 2000) return 'Use up to 100 characters for name/category and 2,000 for description.';
  if (!Number.isSafeInteger(input.minutes) || input.minutes <= 0 || input.minutes > 1440) return 'Duration must be a whole number from 1 to 1,440 minutes.';
  if (!Number.isFinite(input.price) || input.price < 0 || input.price > 10000000 || Math.abs(input.price * 100 - Math.round(input.price * 100)) > 0.000001) return 'Price must be between PKR 0 and 10,000,000, with at most two decimal places.';
  if (typeof input.active !== 'boolean') return 'Choose an active status.';
  if (input.active && services.some(service => service.active && service.id !== excludeId && normalizeServiceName(service.name) === normalizeServiceName(input.name))) return 'An active service already uses this name. Choose a different name or edit the existing service.';
  return null;
}
export function makeService(input: ServiceInput, services: Service[], id: string = crypto.randomUUID()): Service {
  const error = validateService(input, services, id);
  if (error) throw new Error(error);
  return { ...input, id, name: input.name.trim(), category: input.category.trim(), description: input.description.trim() };
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
  return appointments.filter(item => item.serviceId === id && item.status !== 'Completed' && item.status !== 'Cancelled' && new Date(`${item.date}T${item.time}:00+05:00`).getTime() + item.minutes * 60000 > now);
}
