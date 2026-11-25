import { AuthProvider, useAuth } from './AuthContext';
import { AuthPage } from './AuthPage';
import { emptyWorkspace } from './session';
import { ServicesPage } from './ServicesPage';
import { makeService, validateService, upcomingServiceBookings } from './services';
import type { ServiceInput } from './services';
import { StaffPage } from './StaffPage';
import { makeStaff, validateStaff, upcomingStaffBookings } from './staff';
import type { StaffInput } from './staff';
import { CustomersPage } from './CustomersPage';
import { createCustomer, normalizePhone, validateCustomer } from './customers';
import type { CustomerInput } from './customers';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutDashboard, CalendarDays, Users, UserRound, Scissors, ChartNoAxesCombined, Plus, Clock3, Menu, X, Sparkles, Banknote, CalendarCheck, MapPin, ChevronRight, Leaf } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatPKR, formatTime, lahoreDate, startsAt, makeAppointment, validateBooking } from './data';
import { AppointmentForm } from './AppointmentForm';
import type { Page, Appointment, BookingInput, DemoStore } from './data';
import './styles.css';

const navigation: { id: Page; label: string; icon: LucideIcon }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'appointments', label: 'Appointments', icon: CalendarDays },
  { id: 'customers', label: 'Customers', icon: Users },
  { id: 'staff', label: 'Staff', icon: UserRound },
  { id: 'services', label: 'Services', icon: Scissors },
  { id: 'analytics', label: 'Analytics', icon: ChartNoAxesCombined },
];
function currentPage(): Page {
  const hash = window.location.hash.slice(1);
  return navigation.find(item => item.id === hash)?.id ?? 'dashboard';
}
function Icon({ icon: IconComponent, size = 20 }: { icon: LucideIcon; size?: number }) {
  return <IconComponent size={size} aria-hidden="true" strokeWidth={1.8} />;
}
function AppointmentList({ appointments, showDates = false, onEdit, onStatus }: { appointments: Appointment[]; showDates?: boolean; onEdit?: (item: Appointment) => void; onStatus?: (item: Appointment, status: 'Cancelled' | 'Completed') => void }) {
  if (!appointments.length) return <p className="empty-appointments">No appointments yet. Create a local demo booking to get started.</p>;
  return <div className="appointment-list">{appointments.map(item => <article className="appointment" key={item.id}>
    <div className="appointment-time"><strong>{formatTime(item)}</strong>{showDates && <span>{item.date}</span>}<span>{item.minutes} min</span></div>
    <span className="avatar customer-avatar" aria-hidden="true">{item.initials}</span>
    <div className="appointment-person"><h3>{item.customer}</h3><p>{item.service}</p><span className="booking-kind">{item.bookingType ?? 'Scheduled'}</span><span className="mobile-staff">with {item.staff}</span></div>
    <div className="appointment-staff"><span>Team member</span><strong>{item.staff}</strong></div>
    <div className="appointment-end"><strong>{formatPKR(item.price)}</strong><span className={`status status-${item.status.toLowerCase().replaceAll(' ', '-')}`}>{item.status}</span></div>
    {onEdit && item.status !== 'Completed' && item.status !== 'Cancelled' && <div className="appointment-actions"><button onClick={() => onEdit(item)} aria-label={`Edit appointment for ${item.customer}`}>Edit</button><button onClick={() => onStatus?.(item, 'Completed')} aria-label={`Complete appointment for ${item.customer}`}>Complete</button><button className="cancel-booking" onClick={() => onStatus?.(item, 'Cancelled')} aria-label={`Cancel appointment for ${item.customer}`}>Cancel</button></div>}
  </article>)}</div>;
}
function KpiCard({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: LucideIcon }) {
  return <article className="kpi"><div className="flex items-center justify-between gap-3"><p>{label}</p><span className="kpi-icon"><Icon icon={icon} /></span></div><strong className="kpi-value">{value}</strong><span className="kpi-detail">{detail}</span></article>;
}
function App() {
  const { session, logout } = useAuth();
  const [store, setStore] = useState(emptyWorkspace);
  const customers = store.customers;
  const staff = store.staff;
  const services = store.services;
  const appointments = store.appointments.map(item => {
    const customer = customers.find(customer => customer.id === item.customerId)!;
    return { ...item, staff: staff.find(member => member.id === item.staffId)?.name ?? item.staff, customer: customer.name, initials: customer.name.split(' ').map(part => part[0]).join('') };
  });
  const [storageWarning, setStorageWarning] = useState('');
  const [editing, setEditing] = useState<Appointment | undefined>();
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  const today = lahoreDate(new Date(now));
  const sorted = [...appointments].sort((a, b) => startsAt(a) - startsAt(b));
  const todaysAppointments = sorted.filter(item => item.date === today);
  const activeToday = todaysAppointments.filter(item => item.status !== 'Cancelled');
  const filtered = sorted.filter(item => item.customer.toLowerCase().includes(search.trim().toLowerCase()) && (!dateFilter || item.date === dateFilter) && (!statusFilter || item.status === statusFilter));
  const completed = todaysAppointments.filter(item => item.status === 'Completed').length;
  const upcoming = sorted.filter(item => startsAt(item) >= now && item.status !== 'Completed' && item.status !== 'Cancelled').length;
  const remainingToday = todaysAppointments.filter(item => startsAt(item) >= now && item.status !== 'Completed' && item.status !== 'Cancelled').length;
  const revenue = todaysAppointments.filter(item => item.status === 'Completed').reduce((sum, item) => sum + item.price, 0);
  function persistStore(next: DemoStore): string | null {
    setStore(next); setStorageWarning(''); setNow(Date.now()); setNotice(true);
    return null;
  }
  function persist(next: Appointment[]): string | null { return persistStore({ ...store, appointments: next }); }
  function saveCustomer(input: CustomerInput, id?: string) {
    if (id && !customers.some(customer => customer.id === id)) return 'This customer no longer exists.';
    const error = validateCustomer(input, customers, id);
    if (error) return error;
    const customer = id ? { id, name: input.name.trim(), phone: normalizePhone(input.phone)!, notes: input.notes.trim() } : createCustomer(input, customers);
    const next = id ? customers.map(item => item.id === id ? customer : item) : [...customers, customer];
    const storageError = persistStore({ ...store, customers: next });
    return storageError ?? customer;
  }
  function saveStaff(input: StaffInput, id?: string): string | null {
    const existing = staff.find(member => member.id === id);
    if (id && !existing) return 'This employee no longer exists.';
    const error = validateStaff(input, staff, id);
    if (error) return error;
    const pending = id ? upcomingStaffBookings(id, appointments) : [];
    if (existing?.active && !input.active && pending.length && !window.confirm(`Deactivate ${existing.name}? ${pending.length} upcoming or ongoing appointments remain assigned. They will not be cancelled or reassigned. Continue?`)) return 'Deactivation was not saved. Existing bookings are unchanged.';
    const member = makeStaff(input, staff, id);
    return persistStore({ ...store, staff: existing ? staff.map(item => item.id === id ? member : item) : [...staff, member] });
  }
  function saveService(input: ServiceInput, id?: string): string | null {
    const existing = services.find(service => service.id === id);
    if (id && !existing) return 'This service no longer exists.';
    const error = validateService(input, services, id);
    if (error) return error;
    const pending = id ? upcomingServiceBookings(id, appointments) : [];
    if (existing?.active && !input.active && pending.length && !window.confirm(`Deactivate ${existing.name}? ${pending.length} upcoming or ongoing appointments will keep their booked service, duration and price. They will not be cancelled. Continue?`)) return 'Deactivation was not saved. Bookings are unchanged.';
    const service = makeService(input, services, id);
    return persistStore({ ...store, services: existing ? services.map(item => item.id === id ? service : item) : [...services, service] });
  }
  function saveBooking(input: BookingInput): string | null {
    const error = validateBooking(input, appointments, Date.now(), editing?.id, customers, staff, services);
    if (error) return error;
    const booking = makeAppointment(input, customers, staff, services, editing);
    const next = editing ? appointments.map(item => item.id === editing.id ? { ...booking, id: item.id, status: item.status } : item) : [...appointments, booking];
    const storageError = persist(next);
    if (storageError) return storageError;
    setFormOpen(false); setEditing(undefined);
    return null;
  }
  function changeStatus(item: Appointment, status: 'Cancelled' | 'Completed') {
    if (item.status === 'Completed' || item.status === 'Cancelled') return;
    if (status === 'Cancelled' && !window.confirm(`Cancel the appointment for ${item.customer} on ${item.date} at ${formatTime(item)}? This frees the staff member's time.`)) return;
    const error = persist(appointments.map(booking => booking.id === item.id ? { ...booking, status } : booking));
    if (error) setStorageWarning(error);
  }
  const [page, setPage] = useState<Page>(currentPage);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const update = () => { setMobile(query.matches); setMenuOpen(false); };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const [notice, setNotice] = useState(false);
  useEffect(() => {
    const update = () => { setPage(currentPage()); setMenuOpen(false); setNotice(false); };
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menuOpen]);
  const active = navigation.find(item => item.id === page)!;
  if (!session) return null;
  const { user, business } = session;
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    {menuOpen && <button className="nav-overlay" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`} id="navigation" inert={mobile && !menuOpen}>
      <a className="brand" href="#dashboard"><span className="brand-icon"><Icon icon={Scissors} size={25} /></span>Salon<span className="brand-light">Pulse</span></a>
      <div className="workspace"><span className="workspace-icon"><Icon icon={Leaf} /></span><div><strong>{business.name}</strong><span><Icon icon={MapPin} size={13} /> {business.timezone}</span></div><span className="demo-tag">Demo</span></div>
      <p className="nav-caption">WORKSPACE</p>
      <nav aria-label="Main navigation">{navigation.map(item => <a key={item.id} href={`#${item.id}`} onClick={() => setMenuOpen(false)} className={`nav-item ${page === item.id ? 'nav-active' : ''}`} aria-current={page === item.id ? 'page' : undefined}><Icon icon={item.icon} /><span>{item.label}</span>{item.id === 'appointments' && <span className="nav-count">{appointments.length}</span>}</a>)}</nav>
      <div className="sidebar-bottom"><div className="demo-note"><Icon icon={Sparkles} /><strong>A little more flow.<br />A lot less busywork.</strong><p>Your salon, beautifully organised.</p></div><div className="owner"><span className="avatar owner-avatar" aria-hidden="true">{user.full_name.split(/\s+/).map(part => part[0]).join('').slice(0, 2)}</span><div><strong>{user.full_name}</strong><span>{user.role === 'owner' ? 'Salon owner' : 'Team member'}</span></div></div></div>
    </aside>
    <div className="workspace-main">
      <header className="topbar"><div className="flex items-center gap-3"><button className="icon-button mobile-menu" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} aria-controls="navigation" onClick={() => setMenuOpen(!menuOpen)}><Icon icon={menuOpen ? X : Menu} /></button><span className="breadcrumb">Workspace <ChevronRight size={14} aria-hidden="true" /> <strong>{active.label}</strong></span></div><div className="session-account"><span className="session-account-name">{user.full_name}</span><button className="account-logout" onClick={logout}>Log out</button></div></header>
      <main id="main-content" tabIndex={-1}>
        <div className="page-heading"><div><p className="eyebrow">YOUR SALON AT A GLANCE</p><h1>{page === 'dashboard' ? 'A good day starts here.' : active.label}</h1><p className="page-description">{page === 'dashboard' ? `Welcome back, ${user.full_name.split(/\s+/)[0]}. Your salon today.` : 'A little more clarity for your everyday workflow.'}</p></div><button className="primary-button" onClick={() => { setEditing(undefined); setFormOpen(true); }}><Icon icon={Plus} size={18} /> New appointment</button></div>
        <div className="demo-banner"><Icon icon={Sparkles} size={17} /><span><strong>Session-only demo.</strong> Your account is connected. Salon records below are temporary and start empty each login. They are not saved to the backend and clear on logout or refresh.</span></div>
        {notice && <div role="status" className="action-notice"><span>Demo changes kept for this session only. They clear on logout or refresh.</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setNotice(false)}><Icon icon={X} size={18} /></button></div>}
        {storageWarning && <p className="action-notice" role="alert">{storageWarning}</p>}
        {page === 'dashboard' ? <>
          <div className="section-date"><span><Icon icon={CalendarDays} size={17} /> {new Intl.DateTimeFormat('en-PK', { timeZone: 'Asia/Karachi', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now)}</span><span>Today | Lahore (PKT, UTC+05:00)</span></div>
          <section aria-label="Salon key metrics" className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Today's appointments" value={String(activeToday.length)} detail={`${completed} completed / ${remainingToday} upcoming; cancellations excluded`} icon={CalendarCheck} />
            <KpiCard label="Today's revenue" value={formatPKR(revenue)} detail="Completed demo appointments only" icon={Banknote} />
            <KpiCard label="Total customers" value={String(customers.length)} detail="Customers in your demo directory" icon={Users} />
            <KpiCard label="Upcoming appointments" value={String(upcoming)} detail="Future demo bookings across all dates" icon={Clock3} />
          </section>
          <div className="dashboard-columns"><section className="panel"><div className="panel-heading"><div><h2>Today's appointments</h2><p>A snapshot of your salon&#39;s schedule.</p></div><a className="text-link" href="#appointments">View schedule</a></div><AppointmentList appointments={todaysAppointments} /><div className="panel-footer">{todaysAppointments.length} local demo appointments today</div></section><aside className="day-panel"><span className="day-icon"><Icon icon={Leaf} size={25} /></span><p className="eyebrow">ROOM TO SHINE</p><h2>Keep the day<br />running smoothly.</h2><p>{remainingToday} appointments ahead today. A quick look at your schedule helps everyone stay a step ahead.</p><a href="#appointments" className="secondary-button"><Icon icon={CalendarDays} size={18} /> Open schedule</a><div className="team-summary">{staff.filter(member => member.active).slice(0, 3).map(member => <span className="avatar" key={member.id} aria-hidden="true">{member.name.split(/\s+/).map(part => part[0]).join('').slice(0, 2)}</span>)}<span>{staff.filter(member => member.active).length} team members<br /><strong>active in the demo directory</strong></span></div><span className="day-footnote">Thoughtfully made for your everyday.</span></aside></div>
        </> : page === 'appointments' ? <section className="panel appointments-page"><div className="panel-heading"><div><h2>Manage appointments</h2><p>All dates | Lahore time (PKT) | Local demo schedule</p></div><span className="count-badge">{appointments.length} appointments</span></div><div className="appointment-filters"><label>Search customer<input type="search" placeholder="Customer name" value={search} onChange={e => setSearch(e.target.value)} /></label><label>Date<input type="date" value={dateFilter} onChange={e => setDateFilter(e.target.value)} /></label><label>Status<select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}><option value="">All statuses</option>{['Confirmed', 'In progress', 'Completed', 'Cancelled'].map(status => <option key={status}>{status}</option>)}</select></label><button className="filter-reset" onClick={() => { setSearch(''); setDateFilter(''); setStatusFilter(''); }}>Clear filters</button></div><p className="filter-summary" role="status">Showing {filtered.length} of {appointments.length} local demo appointments</p>{filtered.length ? <AppointmentList appointments={filtered} showDates onEdit={item => { setEditing(item); setFormOpen(true); }} onStatus={changeStatus} /> : <div className="empty-appointments"><h3>{appointments.length ? 'No matching appointments' : 'No appointments yet'}</h3><p>{appointments.length ? 'Try another customer, date or status, or clear the filters.' : 'Create your first local demo appointment using New appointment.'}</p></div>}</section> : page === 'customers' ? <CustomersPage customers={customers} appointments={appointments} onSave={saveCustomer} /> : page === 'staff' ? <StaffPage staff={staff} appointments={appointments} onSave={saveStaff} now={now} /> : page === 'services' ? <ServicesPage services={services} appointments={appointments} onSave={saveService} /> : <section className="placeholder panel"><span className="placeholder-icon"><Icon icon={active.icon} size={32} /></span><span className="eyebrow">TAKING SHAPE</span><h2>Your {active.label.toLowerCase()}, all in one place.</h2><p>{({ customers: 'A clear view of the people who keep coming back.', staff: 'A shared space for your team and their schedules.', services: 'Your treatments, durations and prices, neatly organised.', analytics: 'Useful insights into how your salon is growing.' } as Partial<Record<Page, string>>)[page]}</p><span className="count-badge">Coming soon</span><a className="text-link" href="#dashboard">Back to dashboard</a></section>}
        <footer className="page-footer"><span>SalonPulse <span aria-hidden="true">|</span> Made for the rhythm of your salon.</span><span>Frontend preview | Mock data only</span></footer>
      </main>
    </div>
    {formOpen && <AppointmentForm services={services} staff={staff} customers={customers} onSaveCustomer={saveCustomer} editing={editing} appointments={appointments} onSave={saveBooking} onClose={() => { setFormOpen(false); setEditing(undefined); }} />}
  </div>;
}
function AuthGate() {
  const { session } = useAuth();
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const update = () => {
      const value = window.location.hash;
      if (!session && value !== '#login' && value !== '#register') window.location.replace('#login');
      else if (session && (value === '#login' || value === '#register' || !value)) window.location.replace('#dashboard');
      setHash(window.location.hash);
    };
    update(); window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, [session]);
  return session ? <App key={session.key} /> : <AuthPage key={hash === '#register' ? 'register' : 'login'} register={hash === '#register'} />;
}
createRoot(document.getElementById('root')!).render(<StrictMode><AuthProvider><AuthGate /></AuthProvider></StrictMode>);

