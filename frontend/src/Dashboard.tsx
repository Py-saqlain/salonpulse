import { useMemo } from 'react';
import { Banknote, CalendarCheck, CalendarDays, Clock3, Leaf, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Appointment } from './data';
import { formatPKR } from './data';
import type { Staff } from './staff';
import { AppointmentList } from './AppointmentList';
import { dashboardStats } from './dashboardMetrics';
import { Pagination, usePagination } from './Pagination';

function KpiCard({ label, value, detail, icon: Icon }: { label: string; value: string; detail: string; icon: LucideIcon }) {
  return <article className="kpi"><div className="flex items-center justify-between gap-3"><p>{label}</p><span className="kpi-icon"><Icon size={20} aria-hidden="true" /></span></div><strong className="kpi-value">{value}</strong><span className="kpi-detail">{detail}</span></article>;
}

export function Dashboard({ appointments, staff, customerCount, timezone, now, ready, loading }: { appointments: Appointment[]; staff: Staff[]; customerCount: number; timezone: string; now: number; ready: boolean; loading: boolean }) {
  const stats = useMemo(() => dashboardStats(appointments, staff, timezone, now), [appointments, staff, timezone, now]);
  const workload = usePagination(stats.workload, 'workload');
  const unavailable = loading ? 'Loading business records...' : 'Statistics unavailable. Refresh business records to retry.';
  return <>
    <div className="section-date"><span><CalendarDays size={17} aria-hidden="true" />{new Intl.DateTimeFormat('en-PK', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now)}</span><span>Today | {timezone}</span></div>
    <section aria-label="Salon key metrics" className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 xl:grid-cols-4">
      <KpiCard label="Today's appointments" value={ready ? String(stats.active) : '--'} detail={ready ? `${stats.statuses.Completed} completed / ${stats.remainingToday} upcoming; cancellations excluded` : unavailable} icon={CalendarCheck} />
      <KpiCard label="Today's revenue" value={ready ? formatPKR(stats.revenue) : '--'} detail={ready ? 'Completed bookings at saved prices' : unavailable} icon={Banknote} />
      <KpiCard label="Total customers" value={ready ? String(customerCount) : '--'} detail={ready ? 'Customers saved to your business' : unavailable} icon={Users} />
      <KpiCard label="Upcoming appointments" value={ready ? String(stats.upcoming.length) : '--'} detail={ready ? 'Future confirmed bookings across all dates' : unavailable} icon={Clock3} />
    </section>
    <section className="dashboard-status-summary" aria-label="Today's appointment status totals" aria-live="polite">{ready ? <><strong>{stats.total} total today</strong>{Object.entries(stats.statuses).map(([status, count]) => <span key={status} data-daily-status={status}>{status}: {count}</span>)}</> : <span>{unavailable}</span>}</section>
    <div className="dashboard-columns"><div className="dashboard-main-panels">
      <section className="panel" aria-label="Upcoming appointments"><div className="panel-heading"><div><h2>Upcoming appointments</h2><p>Next five confirmed bookings | {timezone}</p></div><a className="text-link" href="#appointments">View schedule</a></div>{ready ? stats.upcoming.length ? <AppointmentList appointments={stats.upcoming.slice(0, 5)} showDates /> : <p className="empty-appointments">No upcoming confirmed appointments.</p> : <p role="status" className="empty-appointments">{unavailable}</p>}<div className="panel-footer">{ready ? `${stats.upcoming.length} upcoming across all dates` : unavailable}</div></section>
      <section className="panel" aria-label="Today's staff workload"><div className="panel-heading"><div><h2>Today's staff workload</h2><p>Bookings starting today | Cancellations excluded | {timezone}</p></div><a className="text-link" href="#staff">View team</a></div>
        {ready ? <>{workload.visible.map(member => <article className="workload-row" key={member.id} data-workload-id={member.id}><div><strong>{member.name}</strong><p>{member.active ? 'Active' : 'Inactive - existing bookings retained'}</p></div><span>{member.appointments} appointments</span><span>{member.minutes} min booked</span></article>)}{!staff.length && <p className="empty-appointments">No staff yet. Add employees to start taking bookings.</p>}<Pagination {...workload} label="Staff workload pagination" /></> : <p role="status" className="empty-appointments">{unavailable}</p>}
      </section>
    </div><aside className="day-panel"><span className="day-icon"><Leaf size={25} aria-hidden="true" /></span><p className="eyebrow">ROOM TO SHINE</p><h2>Keep the day<br />running smoothly.</h2><p>{ready ? `${stats.remainingToday} appointments ahead today. A quick look at your schedule helps everyone stay a step ahead.` : unavailable}</p><a href="#appointments" className="secondary-button"><CalendarDays size={18} aria-hidden="true" />Open schedule</a><div className="team-summary"><span>{ready ? staff.filter(member => member.active).length : '--'} team members<br /><strong>active in your business</strong></span></div><span className="day-footnote">Thoughtfully made for your everyday.</span></aside></div>
  </>;
}
