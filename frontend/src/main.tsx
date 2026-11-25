import { AppointmentList } from './AppointmentList';
import { AppointmentsPage } from './AppointmentsPage';
import { localDateTime } from './appointments';
import { AuthProvider, useAuth } from './AuthContext';
import { AuthPage } from './AuthPage';
import { useCatalog } from './useCatalog';
import { ServicesPage } from './ServicesPage';
import { StaffPage } from './StaffPage';
import { CustomersPage } from './CustomersPage';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutDashboard, CalendarDays, Users, UserRound, Scissors, ChartNoAxesCombined, Plus, Clock3, Menu, X, Sparkles, Banknote, CalendarCheck, MapPin, ChevronRight, Leaf } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatPKR, startsAt } from './data';
import { AppointmentForm } from './AppointmentForm';
import type { Page, Appointment, BookingInput } from './data';
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
function KpiCard({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: LucideIcon }) {
  return <article className="kpi"><div className="flex items-center justify-between gap-3"><p>{label}</p><span className="kpi-icon"><Icon icon={icon} /></span></div><strong className="kpi-value">{value}</strong><span className="kpi-detail">{detail}</span></article>;
}
function App() {
  const { session, logout } = useAuth();
  const catalog = useCatalog();
  const { customers, staff, services, saveCustomer } = catalog;
  const appointments = catalog.appointments;
  const [actionError, setActionError] = useState('');
  const [editing, setEditing] = useState<Appointment | undefined>();
  const [formOpen, setFormOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  const today = localDateTime(now, session!.business.timezone).date;
  const sorted = [...appointments].sort((a, b) => startsAt(a) - startsAt(b));
  const todaysAppointments = sorted.filter(item => item.date === today);
  const activeToday = todaysAppointments.filter(item => item.status !== 'Cancelled');
  const completed = todaysAppointments.filter(item => item.status === 'Completed').length;
  const upcoming = sorted.filter(item => startsAt(item) >= now && item.status !== 'Completed' && item.status !== 'Cancelled').length;
  const remainingToday = todaysAppointments.filter(item => startsAt(item) >= now && item.status !== 'Completed' && item.status !== 'Cancelled').length;
  const revenue = todaysAppointments.filter(item => item.status === 'Completed').reduce((sum, item) => sum + item.price, 0);
  async function saveBooking(input: BookingInput): Promise<string | null> {
    const error = await catalog.saveAppointment(input, editing);
    if (!error) { setFormOpen(false); setEditing(undefined); }
    return error;
  }
  async function changeStatus(item: Appointment, status: 'In progress' | 'Completed' | 'Cancelled') {
    setActionError('');
    const value = status === 'In progress' ? 'in_progress' : status === 'Completed' ? 'completed' : 'cancelled';
    const error = await catalog.changeAppointment(item, value);
    if (error) setActionError(error);
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
  useEffect(() => {
    const update = () => { setPage(currentPage()); setMenuOpen(false); };
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
      <div className="workspace"><span className="workspace-icon"><Icon icon={Leaf} /></span><div><strong>{business.name}</strong><span><Icon icon={MapPin} size={13} /> {business.timezone}</span></div><span className="demo-tag">Connected</span></div>
      <p className="nav-caption">WORKSPACE</p>
      <nav aria-label="Main navigation">{navigation.map(item => <a key={item.id} href={`#${item.id}`} onClick={() => setMenuOpen(false)} className={`nav-item ${page === item.id ? 'nav-active' : ''}`} aria-current={page === item.id ? 'page' : undefined}><Icon icon={item.icon} /><span>{item.label}</span>{item.id === 'appointments' && <span className="nav-count">{appointments.length}</span>}</a>)}</nav>
      <div className="sidebar-bottom"><div className="demo-note"><Icon icon={Sparkles} /><strong>A little more flow.<br />A lot less busywork.</strong><p>Your salon, beautifully organised.</p></div><div className="owner"><span className="avatar owner-avatar" aria-hidden="true">{user.full_name.split(/\s+/).map(part => part[0]).join('').slice(0, 2)}</span><div><strong>{user.full_name}</strong><span>{user.role === 'owner' ? 'Salon owner' : 'Team member'}</span></div></div></div>
    </aside>
    <div className="workspace-main">
      <header className="topbar"><div className="flex items-center gap-3"><button className="icon-button mobile-menu" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} aria-controls="navigation" onClick={() => setMenuOpen(!menuOpen)}><Icon icon={menuOpen ? X : Menu} /></button><span className="breadcrumb">Workspace <ChevronRight size={14} aria-hidden="true" /> <strong>{active.label}</strong></span></div><div className="session-account"><span className="session-account-name">{user.full_name}</span><button className="account-logout" onClick={logout}>Log out</button></div></header>
      <main id="main-content" tabIndex={-1}>
        <div className="page-heading"><div><p className="eyebrow">YOUR SALON AT A GLANCE</p><h1>{page === 'dashboard' ? 'A good day starts here.' : active.label}</h1><p className="page-description">{page === 'dashboard' ? `Welcome back, ${user.full_name.split(/\s+/)[0]}. Your salon today.` : 'A little more clarity for your everyday workflow.'}</p></div><button className="primary-button" disabled={!catalog.ready || catalog.loading || catalog.busy} onClick={() => { setEditing(undefined); setFormOpen(true); }}><Icon icon={Plus} size={18} /> New appointment</button></div>
        <div className="demo-banner"><Icon icon={Sparkles} size={17} /><span><strong>Connected workspace.</strong> Bookings and customer history are saved to your business. Times use {business.timezone}; revenue uses completed bookings and their saved prices.</span></div>
        <div className="directory-toolbar"><button className="filter-reset" disabled={catalog.loading || catalog.busy} onClick={() => void catalog.refresh()}>Refresh directories</button>{catalog.loading && <span role="status">Loading business records...</span>}{catalog.notice && !catalog.loading && <span role="status">{catalog.notice}</span>}</div>
        {catalog.error && <p className="booking-error" role="alert">{catalog.error} Previously loaded records may be out of date. Use Refresh directories to retry. A submitted change may already have been saved; refresh before submitting it again.</p>}
        {actionError && <p className="action-notice" role="alert">{actionError}</p>}
        {page === 'dashboard' ? <>
          <div className="section-date"><span><Icon icon={CalendarDays} size={17} /> {new Intl.DateTimeFormat('en-PK', { timeZone: business.timezone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now)}</span><span>Today | {business.timezone}</span></div>
          <section aria-label="Salon key metrics" className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Today's appointments" value={catalog.ready ? String(activeToday.length) : "--"} detail={`${completed} completed / ${remainingToday} upcoming; cancellations excluded`} icon={CalendarCheck} />
            <KpiCard label="Today's revenue" value={catalog.ready ? formatPKR(revenue) : "--"} detail="Completed bookings at saved prices" icon={Banknote} />
            <KpiCard label="Total customers" value={catalog.ready ? String(customers.length) : "--"} detail="Customers saved to your business" icon={Users} />
            <KpiCard label="Upcoming appointments" value={catalog.ready ? String(upcoming) : "--"} detail="Future bookings across all dates" icon={Clock3} />
          </section>
          <div className="dashboard-columns"><section className="panel"><div className="panel-heading"><div><h2>Today's appointments</h2><p>A snapshot of your salon&#39;s schedule.</p></div><a className="text-link" href="#appointments">View schedule</a></div><AppointmentList appointments={todaysAppointments} /><div className="panel-footer">{todaysAppointments.length} saved appointments today</div></section><aside className="day-panel"><span className="day-icon"><Icon icon={Leaf} size={25} /></span><p className="eyebrow">ROOM TO SHINE</p><h2>Keep the day<br />running smoothly.</h2><p>{remainingToday} appointments ahead today. A quick look at your schedule helps everyone stay a step ahead.</p><a href="#appointments" className="secondary-button"><Icon icon={CalendarDays} size={18} /> Open schedule</a><div className="team-summary">{staff.filter(member => member.active).slice(0, 3).map(member => <span className="avatar" key={member.id} aria-hidden="true">{member.name.split(/\s+/).map(part => part[0]).join('').slice(0, 2)}</span>)}<span>{staff.filter(member => member.active).length} team members<br /><strong>active in your business</strong></span></div><span className="day-footnote">Thoughtfully made for your everyday.</span></aside></div>
        </> : !catalog.loaded ? <section className="panel empty-appointments"><h2>{catalog.loading ? 'Loading your business records...' : 'Records unavailable'}</h2><p>{catalog.loading ? 'Please wait.' : 'Refresh the business records to try again.'}</p></section> : page === 'appointments' ? <AppointmentsPage appointments={sorted} staff={staff} timezone={business.timezone} disabled={!catalog.ready || catalog.loading || catalog.busy} onEdit={item => { setEditing(item); setFormOpen(true); }} onStatus={(item, status) => void changeStatus(item, status)} /> : page === 'customers' ? <CustomersPage customers={customers} appointments={appointments} onSave={saveCustomer} onDelete={id => catalog.remove('customers', id)} disabled={!catalog.ready || catalog.loading || catalog.busy} /> : page === 'staff' ? <StaffPage staff={staff} appointments={appointments} onSave={catalog.saveStaff} now={now} onDelete={id => catalog.remove('staff', id)} owner={catalog.owner} timezone={business.timezone} disabled={!catalog.ready || catalog.loading || catalog.busy} /> : page === 'services' ? <ServicesPage services={services} appointments={appointments} onSave={catalog.saveService} onDelete={id => catalog.remove('services', id)} owner={catalog.owner} disabled={!catalog.ready || catalog.loading || catalog.busy} /> : <section className="placeholder panel"><span className="placeholder-icon"><Icon icon={active.icon} size={32} /></span><span className="eyebrow">TAKING SHAPE</span><h2>Your {active.label.toLowerCase()}, all in one place.</h2><p>{({ customers: 'A clear view of the people who keep coming back.', staff: 'A shared space for your team and their schedules.', services: 'Your treatments, durations and prices, neatly organised.', analytics: 'Useful insights into how your salon is growing.' } as Partial<Record<Page, string>>)[page]}</p><span className="count-badge">Coming soon</span><a className="text-link" href="#dashboard">Back to dashboard</a></section>}
        <footer className="page-footer"><span>SalonPulse <span aria-hidden="true">|</span> Made for the rhythm of your salon.</span><span>Connected business workspace</span></footer>
      </main>
    </div>
    {formOpen && <AppointmentForm timezone={business.timezone} disabled={!catalog.ready || catalog.loading || catalog.busy} services={services} staff={staff} customers={customers} onSaveCustomer={saveCustomer} editing={editing} appointments={appointments} onSave={saveBooking} onClose={() => { setFormOpen(false); setEditing(undefined); }} />}
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

