import type { Appointment } from './data';
export type Customer = { id: string; name: string; phone: string; notes: string; completedVisits?: number; lastCompleted?: string | null };
export type CustomerInput = Pick<Customer, 'name' | 'phone' | 'notes'>;
export function normalizePhone(phone: string): string | null {
  if (!phone.trim()) return '';
  const value = phone.trim().replace(/[\s()-]/g, '');
  if (!value) return null;
  if (/^03\d{9}$/.test(value)) return '+92' + value.slice(1);
  if (/^923\d{9}$/.test(value)) return '+' + value;
  if (/^00923\d{9}$/.test(value)) return '+' + value.slice(2);
  if (/^\+923\d{9}$/.test(value)) return value;
  return null;
}
export function validateCustomer(input: CustomerInput, customers: Customer[], excludeId?: string): string | null {
  if (!input.name.trim()) return 'Enter a customer name.';
  if (input.name.trim().length > 200 || input.notes.length > 4000) return 'Use up to 200 characters for the name and 4,000 for notes.';
  const phone = normalizePhone(input.phone);
  if (phone === null) return 'Enter a Pakistani mobile number, such as 0300 8672095 or +92 300 8672095.';
  if (phone && customers.some(customer => customer.id !== excludeId && customer.phone === phone)) return 'This mobile number already belongs to a customer in this business.';
  return null;
}
export function customerHistory(customerId: string, appointments: Appointment[]) {
  const history = appointments.filter(item => item.customerId === customerId).sort((a, b) => Date.parse(b.startUTC) - Date.parse(a.startUTC));
  const completed = history.filter(item => item.status === 'Completed');
  return { history, completedVisits: completed.length, lastCompleted: completed[0] };
}
