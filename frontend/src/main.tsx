import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LayoutDashboard, CalendarDays, Users, UserRound, Scissors, ChartNoAxesCombined, Plus, Clock3, Menu, X, Sparkles, Banknote, CalendarCheck, MapPin, ChevronRight, Leaf } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { appointments, formatPKR } from './data';
import type { Page } from './data';
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
function AppointmentList() {
  return <div className="appointment-list">{appointments.map(item => <article className="appointment" key={item.id}>
    <div className="appointment-time"><strong>{item.time}</strong><span>{item.duration}</span></div>
    <span className="avatar customer-avatar" aria-hidden="true">{item.initials}</span>
    <div className="appointment-person"><h3>{item.customer}</h3><p>{item.service}</p><span className="mobile-staff">with {item.staff}</span></div>
    <div className="appointment-staff"><span>Team member</span><strong>{item.staff}</strong></div>
    <div className="appointment-end"><strong>{formatPKR(item.price)}</strong><span className={`status status-${item.status.toLowerCase().replaceAll(' ', '-')}`}>{item.status}</span></div>
  </article>)}</div>;
}
function KpiCard({ label, value, detail, icon }: { label: string; value: string; detail: string; icon: LucideIcon }) {
  return <article className="kpi"><div className="flex items-center justify-between gap-3"><p>{label}</p><span className="kpi-icon"><Icon icon={icon} /></span></div><strong className="kpi-value">{value}</strong><span className="kpi-detail">{detail}</span></article>;
}
function App() {
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
  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to content</a>
    {menuOpen && <button className="nav-overlay" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`} id="navigation" inert={mobile && !menuOpen}>
      <a className="brand" href="#dashboard"><span className="brand-icon"><Icon icon={Scissors} size={25} /></span>Salon<span className="brand-light">Pulse</span></a>
      <div className="workspace"><span className="workspace-icon"><Icon icon={Leaf} /></span><div><strong>The Grooming Studio</strong><span><Icon icon={MapPin} size={13} /> Gulberg, Lahore</span></div><span className="demo-tag">Demo</span></div>
      <p className="nav-caption">WORKSPACE</p>
      <nav aria-label="Main navigation">{navigation.map(item => <a key={item.id} href={`#${item.id}`} onClick={() => setMenuOpen(false)} className={`nav-item ${page === item.id ? 'nav-active' : ''}`} aria-current={page === item.id ? 'page' : undefined}><Icon icon={item.icon} /><span>{item.label}</span>{item.id === 'appointments' && <span className="nav-count">18</span>}</a>)}</nav>
      <div className="sidebar-bottom"><div className="demo-note"><Icon icon={Sparkles} /><strong>A little more flow.<br />A lot less busywork.</strong><p>Your salon, beautifully organised.</p></div><div className="owner"><span className="avatar owner-avatar">AR</span><div><strong>Ahmed Raza</strong><span>Salon owner | Demo profile</span></div></div></div>
    </aside>
    <div className="workspace-main">
      <header className="topbar"><div className="flex items-center gap-3"><button className="icon-button mobile-menu" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} aria-controls="navigation" onClick={() => setMenuOpen(!menuOpen)}><Icon icon={menuOpen ? X : Menu} /></button><span className="breadcrumb">Workspace <ChevronRight size={14} aria-hidden="true" /> <strong>{active.label}</strong></span></div><span className="preview-badge"><span /> Demo workspace</span></header>
      <main id="main-content" tabIndex={-1}>
        <div className="page-heading"><div><p className="eyebrow">YOUR SALON AT A GLANCE</p><h1>{page === 'dashboard' ? 'A good day starts here.' : active.label}</h1><p className="page-description">{page === 'dashboard' ? 'Welcome back, Ahmed. Your salon today.' : 'A little more clarity for your everyday workflow.'}</p></div><button className="primary-button" onClick={() => setNotice(true)}><Icon icon={Plus} size={18} /> New appointment</button></div>
        <div className="demo-banner"><Icon icon={Sparkles} size={17} /><span><strong>Mock data preview.</strong> Fictional data. Changes are not saved.</span></div>
        {notice && <div role="status" className="action-notice"><span>Appointment creation coming soon. Demo only.</span><button className="icon-button" aria-label="Dismiss message" onClick={() => setNotice(false)}><Icon icon={X} size={18} /></button></div>}
        {page === 'dashboard' ? <>
          <div className="section-date"><span><Icon icon={CalendarDays} size={17} /> Thursday, 19 November 2026</span><span>Today | Lahore (PKT, UTC+05:00)</span></div>
          <section aria-label="Salon key metrics" className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Today's appointments" value="18" detail="12 completed / 6 remaining" icon={CalendarCheck} />
            <KpiCard label="Today's revenue" value={formatPKR(32500)} detail="Mock collected revenue for today" icon={Banknote} />
            <KpiCard label="Total customers" value="248" detail="Across your demo customer base" icon={Users} />
            <KpiCard label="Upcoming appointments" value="6" detail="Scheduled for the rest of today" icon={Clock3} />
          </section>
          <div className="dashboard-columns"><section className="panel"><div className="panel-heading"><div><h2>Today's appointments</h2><p>A snapshot of your salon&#39;s schedule.</p></div><a className="text-link" href="#appointments">View schedule</a></div><AppointmentList /><div className="panel-footer">Showing 5 of 18 mock appointments</div></section><aside className="day-panel"><span className="day-icon"><Icon icon={Leaf} size={25} /></span><p className="eyebrow">ROOM TO SHINE</p><h2>Keep the day<br />running smoothly.</h2><p>Six appointments ahead. A quick look at your schedule helps everyone stay a step ahead.</p><a href="#appointments" className="secondary-button"><Icon icon={CalendarDays} size={18} /> Open schedule</a><div className="team-summary"><span className="avatar">AR</span><span className="avatar">SM</span><span className="avatar">BH</span><span>3 team members<br /><strong>on today&#39;s demo roster</strong></span></div><span className="day-footnote">Thoughtfully made for your everyday.</span></aside></div>
        </> : page === 'appointments' ? <section className="panel appointments-page"><div className="panel-heading"><div><h2>Appointment preview</h2><p>Thursday, 19 November 2026 | Mock schedule</p></div><span className="count-badge">5 appointments</span></div><AppointmentList /></section> : <section className="placeholder panel"><span className="placeholder-icon"><Icon icon={active.icon} size={32} /></span><span className="eyebrow">TAKING SHAPE</span><h2>Your {active.label.toLowerCase()}, all in one place.</h2><p>{({ customers: 'A clear view of the people who keep coming back.', staff: 'A shared space for your team and their schedules.', services: 'Your treatments, durations and prices, neatly organised.', analytics: 'Useful insights into how your salon is growing.' } as Partial<Record<Page, string>>)[page]}</p><span className="count-badge">Coming soon</span><a className="text-link" href="#dashboard">Back to dashboard</a></section>}
        <footer className="page-footer"><span>SalonPulse <span aria-hidden="true">|</span> Made for the rhythm of your salon.</span><span>Frontend preview | Mock data only</span></footer>
      </main>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

