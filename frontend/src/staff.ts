import { normalizePhone } from './customers';
import type { Appointment } from './data';
export const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export type WorkingDay = { day: number; start: string; end: string };
export type Staff = { id: string; name: string; phone: string; specialty: string; active: boolean; hours: WorkingDay[] | null; todayCount?: number; upcomingCount?:number };
export type StaffInput = Omit<Staff, 'id'>;
export function validateStaff(input: StaffInput, staff: Staff[], excludeId?: string): string | null {
  if (!input.name.trim()) return 'Enter an employee name.';
  if (input.name.trim().length > 200 || input.specialty.length > 200) return 'Use up to 200 characters for name and specialty.';
  const phone = normalizePhone(input.phone);
  if (phone === null) return 'Enter a valid Pakistani mobile, for example 0300 8672095.';
  if (phone && staff.some(item => item.id !== excludeId && item.phone === phone)) return 'This mobile number already belongs to a staff member.';
  if (typeof input.active !== 'boolean') return 'Choose an active status.';
  if (input.hours !== null) {
    if (!Array.isArray(input.hours) || !input.hours.length) return 'Select at least one working day or choose hours not configured.';
    const days = new Set<number>();
    for (const shift of input.hours) {
      if (!shift || !Number.isInteger(shift.day) || shift.day < 0 || shift.day > 6 || days.has(shift.day)) return 'Choose each working day only once.';
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(shift.start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(shift.end) || shift.end <= shift.start) return 'Each working day needs an end time later than its start time. Overnight shifts are not supported.';
      days.add(shift.day);
    }
  }
  return null;
}
export function upcomingStaffBookings(id: string, appointments: Appointment[], now = Date.now()) {
  return appointments.filter(item => item.staffId === id && item.status !== 'Cancelled' && item.status !== 'Completed' && Date.parse(item.endUTC) > now);
}
