import type { Appointment } from './data';
import type { Staff } from './staff';
import { localDateTime } from './appointments';

export function dashboardStats(appointments: Appointment[], staff: Staff[], timezone: string, now: number) {
  const today = localDateTime(now, timezone).date;
  // The backend date filter also assigns a booking to its local start date.
  const daily = appointments.filter(item => localDateTime(item.startUTC, timezone).date === today);
  const statuses = { Confirmed: 0, 'In progress': 0, Completed: 0, Cancelled: 0 };
  for (const item of daily) statuses[item.status]++;
  const upcoming = appointments.filter(item => item.status === 'Confirmed' && Date.parse(item.startUTC) >= now)
    .sort((a, b) => Date.parse(a.startUTC) - Date.parse(b.startUTC) || a.id.localeCompare(b.id));
  const workload = staff.map(member => {
    const bookings = daily.filter(item => item.staffId === member.id && item.status !== 'Cancelled');
    return { id: member.id, name: member.name, active: member.active, appointments: bookings.length, minutes: bookings.reduce((total, item) => total + item.minutes, 0) };
  }).sort((a, b) => b.appointments - a.appointments || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { today, daily, statuses, total: daily.length, active: daily.length - statuses.Cancelled, upcoming, workload,
    remainingToday: upcoming.filter(item => localDateTime(item.startUTC, timezone).date === today).length,
    // Preserve the existing completed-booking revenue definition; no payment logic.
    revenue: daily.filter(item => item.status === 'Completed').reduce((total, item) => total + item.price, 0) };
}
