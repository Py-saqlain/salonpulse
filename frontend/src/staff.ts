import { normalizePhone } from './customers';
import type { Appointment } from './data';
export const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export type WorkingDay = { day: number; start: string; end: string };
export type Staff = { id: string; name: string; phone: string; specialty: string; active: boolean; hours: WorkingDay[] | null };
export type StaffInput = Omit<Staff, 'id'>;
export const seedStaff: Staff[] = ['Ali Raza', 'Sana Malik', 'Bilal Hassan'].map((name, i) => ({ id: `staff-${i}`, name, phone: '', specialty: ['Barber', 'Colour & skin care', 'Hair stylist'][i], active: true, hours: weekdays.map((_, day) => ({ day, start: '09:00', end: '20:00' })) }));
export function validateStaff(input: StaffInput, staff: Staff[], excludeId?: string): string | null {
  if (!input.name.trim()) return 'Enter an employee name.';
  if (input.name.trim().length > 200 || input.specialty.length > 200) return 'Use up to 200 characters for name and specialty.';
  const phone = normalizePhone(input.phone);
  if (phone === null) return 'Enter a valid Pakistani mobile, for example 0300 1234567.';
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
export function makeStaff(input: StaffInput, staff: Staff[], id: string = crypto.randomUUID()): Staff {
  const error = validateStaff(input, staff, id);
  if (error) throw new Error(error);
  return { ...input, id, name: input.name.trim(), phone: normalizePhone(input.phone)!, specialty: input.specialty.trim() };
}
export function availabilityError(member: Staff | undefined, date: string, time: string, minutes: number): string | null {
  if (!member) return 'Select a staff member.';
  if (!member.active) return 'This staff member is inactive. Select an active employee before saving this booking.';
  if (member.hours === null) return 'Working hours are not configured for this employee. Configure them on Staff before booking.';
  const day = new Date(`${date}T12:00:00+05:00`).getUTCDay();
  const shift = member.hours.find(item => item.day === day);
  if (!shift) return 'This staff member does not work on the selected day.';
  const minuteOfDay = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = minuteOfDay(time);
  if (start < minuteOfDay(shift.start) || start + minutes > minuteOfDay(shift.end)) return `The entire service must fit within ${shift.start}-${shift.end} PKT on ${weekdays[day]}.`;
  return null;
}
export function upcomingStaffBookings(id: string, appointments: Appointment[], now = Date.now()) {
  return appointments.filter(item => item.staffId === id && item.status !== 'Cancelled' && item.status !== 'Completed' && (item.endUTC ? Date.parse(item.endUTC) : new Date(`${item.date}T${item.time}:00+05:00`).getTime() + item.minutes * 60000) > now);
}
