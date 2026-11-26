import { Dashboard } from './Dashboard';
import { AppointmentsPage } from './AppointmentsPage';
import { AuthProvider, useAuth } from './AuthContext';
import { AuthPage } from './AuthPage';
import { PaymentProvider } from './PaymentContext';
import { useCatalog } from './useCatalog';
import { ServicesPage } from './ServicesPage';
import { StaffPage } from './StaffPage';
import { CustomersPage } from './CustomersPage';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutDashboard, CalendarDays, Users, UserRound, Scissors, ChartNoAxesCombined, Plus, Menu, X, Sparkles, MapPin, ChevronRight, Leaf } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
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
      <div className="workspace"><span className="workspace-icon"><Icon icon={Leaf} /></span><div><strong>{business.name}</strong><span><Icon icon={MapPin} size={13} /> {business.timezone}</span></div><span className="connected-tag">Connected</span></div>
      <p className="nav-caption">WORKSPACE</p>
      <nav aria-label="Main navigation">{navigation.map(item => <a key={item.id} href={`#${item.id}`} onClick={() => setMenuOpen(false)} className={`nav-item ${page === item.id ? 'nav-active' : ''}`} aria-current={page === item.id ? 'page' : undefined}><Icon icon={item.icon} /><span>{item.label}</span>{item.id === 'appointments' && <span className="nav-count">{appointments.length}</span>}</a>)}</nav>
      <div className="sidebar-bottom"><div className="brand-note"><Icon icon={Sparkles} /><strong>A little more flow.<br />A lot less busywork.</strong><p>Your salon, beautifully organised.</p></div><div className="owner"><span className="avatar owner-avatar" aria-hidden="true">{user.full_name.split(/\s+/).map(part => part[0]).join('').slice(0, 2)}</span><div><strong>{user.full_name}</strong><span>{user.role === 'owner' ? 'Salon owner' : 'Team member'}</span></div></div></div>
    </aside>
    <div className="workspace-main">
      <header className="topbar"><div className="flex items-center gap-3"><button className="icon-button mobile-menu" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} aria-controls="navigation" onClick={() => setMenuOpen(!menuOpen)}><Icon icon={menuOpen ? X : Menu} /></button><span className="breadcrumb">Workspace <ChevronRight size={14} aria-hidden="true" /> <strong>{active.label}</strong></span></div><div className="session-account"><span className="session-account-name">{user.full_name}</span><button className="account-logout" onClick={logout}>Log out</button></div></header>
      <main id="main-content" tabIndex={-1}>
        <div className="page-heading"><div><p className="eyebrow">YOUR SALON AT A GLANCE</p><h1>{page === 'dashboard' ? 'A good day starts here.' : active.label}</h1><p className="page-description">{page === 'dashboard' ? `Welcome back, ${user.full_name.split(/\s+/)[0]}. Your salon today.` : 'A little more clarity for your everyday workflow.'}</p></div><button className="primary-button" disabled={!catalog.ready || catalog.loading || catalog.busy} onClick={() => { setEditing(undefined); setFormOpen(true); }}><Icon icon={Plus} size={18} /> New appointment</button></div>
        <div className="workspace-banner"><Icon icon={Sparkles} size={17} /><span><strong>Connected workspace.</strong> Bookings and customer history are saved to your business. Times use {business.timezone}; revenue uses completed bookings and their saved prices.</span></div>
        <div className="directory-toolbar"><button className="filter-reset" disabled={catalog.loading || catalog.busy} onClick={() => void catalog.refresh()}>Refresh directories</button>{catalog.loading && <span role="status">Loading business records...</span>}{catalog.notice && !catalog.loading && <span role="status">{catalog.notice}</span>}</div>
        {catalog.error && <p className="booking-error" role="alert">{catalog.error} Previously loaded records may be out of date. Use Refresh directories to retry. A submitted change may already have been saved; refresh before submitting it again.</p>}
        {actionError && <p className="action-notice" role="alert">{actionError}</p>}
        {page === 'dashboard' ? <Dashboard appointments={appointments} staff={staff} customerCount={customers.length} timezone={business.timezone} now={now} ready={catalog.ready} loading={catalog.loading} /> : !catalog.loaded ? <section className="panel empty-appointments"><h2>{catalog.loading ? 'Loading your business records...' : 'Records unavailable'}</h2><p>{catalog.loading ? 'Please wait.' : 'Refresh the business records to try again.'}</p></section> : page === 'appointments' ? <AppointmentsPage appointments={appointments} staff={staff} timezone={business.timezone} disabled={!catalog.ready || catalog.loading || catalog.busy} onEdit={item => { setEditing(item); setFormOpen(true); }} onStatus={(item, status) => void changeStatus(item, status)} /> : page === 'customers' ? <CustomersPage customers={customers} appointments={appointments} onSave={saveCustomer} onDelete={id => catalog.remove('customers', id)} disabled={!catalog.ready || catalog.loading || catalog.busy} /> : page === 'staff' ? <StaffPage staff={staff} appointments={appointments} onSave={catalog.saveStaff} now={now} onDelete={id => catalog.remove('staff', id)} owner={catalog.owner} timezone={business.timezone} disabled={!catalog.ready || catalog.loading || catalog.busy} /> : page === 'services' ? <ServicesPage services={services} appointments={appointments} onSave={catalog.saveService} onDelete={id => catalog.remove('services', id)} owner={catalog.owner} disabled={!catalog.ready || catalog.loading || catalog.busy} /> : <section className="placeholder panel"><span className="placeholder-icon"><Icon icon={active.icon} size={32} /></span><span className="eyebrow">TAKING SHAPE</span><h2>Your {active.label.toLowerCase()}, all in one place.</h2><p>{({ customers: 'A clear view of the people who keep coming back.', staff: 'A shared space for your team and their schedules.', services: 'Your treatments, durations and prices, neatly organised.', analytics: 'Useful insights into how your salon is growing.' } as Partial<Record<Page, string>>)[page]}</p><span className="count-badge">Coming soon</span><a className="text-link" href="#dashboard">Back to dashboard</a></section>}
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
  return session ? <PaymentProvider key={session.key}><App /></PaymentProvider> : <AuthPage key={hash === '#register' ? 'register' : 'login'} register={hash === '#register'} />;
}
createRoot(document.getElementById('root')!).render(<StrictMode><AuthProvider><AuthGate /></AuthProvider></StrictMode>);

