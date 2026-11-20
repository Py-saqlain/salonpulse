import './staff.css';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { weekdays, upcomingStaffBookings } from './staff';
import type { Staff, StaffInput } from './staff';
import type { Appointment } from './data';
import { lahoreDate } from './data';
export type SaveStaff = (input: StaffInput, id?: string) => string | null;
function StaffEditor({ member, onSave, onClose, appointments }: { member?: Staff; onSave: SaveStaff; onClose: () => void; appointments: Appointment[] }) {
  const [input, setInput] = useState<StaffInput>(member ?? { name: '', phone: '', specialty: '', active: true, hours: null });
  const [error, setError] = useState('');
  const pending = member ? upcomingStaffBookings(member.id, appointments).length : 0;
  function submit(event: FormEvent) { event.preventDefault(); const error = onSave(input, member?.id); if (error) setError(error); else onClose(); }
  return <form className="booking-fields staff-editor" onSubmit={submit}><h2>{member ? 'Edit employee' : 'Add employee'}</h2><p className="field-help">Local demo business. Working times use Lahore time (PKT).</p>
    <label>Name<input autoFocus required maxLength={100} value={input.name} onChange={e => setInput({ ...input, name: e.target.value })} /></label>
    <label>Mobile (optional)<input type="tel" inputMode="tel" placeholder="0300 1234567" value={input.phone} onChange={e => setInput({ ...input, phone: e.target.value })} /></label>
    <label>Role / specialty (optional)<input maxLength={100} value={input.specialty} onChange={e => setInput({ ...input, specialty: e.target.value })} /></label>
    <label className="staff-checkbox"><input type="checkbox" checked={input.active} onChange={e => setInput({ ...input, active: e.target.checked })} />Active employee</label>
    {!input.active && pending > 0 && <p className="booking-error">{pending} upcoming or ongoing bookings will remain assigned. Saving requires confirmation; arrange reassignment or cancellation separately.</p>}
    <fieldset className="working-hours"><legend>Working hours</legend><label className="staff-checkbox"><input type="checkbox" checked={input.hours !== null} onChange={e => setInput({ ...input, hours: e.target.checked ? [{ day: 1, start: '09:00', end: '18:00' }] : null })} />Configure weekly hours</label>
    {input.hours === null ? <p className="field-help">Not configured. New appointments are blocked until hours are set.</p> : <><p className="field-help">Choose working days and one same-day shift per day. The entire service must fit.</p>{weekdays.map((name, day) => {
      const shift = input.hours?.find(shift => shift.day === day);
      const updateTime = (field: 'start' | 'end', value: string) => setInput({ ...input, hours: input.hours!.map(shift => shift.day === day ? { ...shift, [field]: value } : shift) });
      return <div className="shift-row" key={day}><label className="staff-checkbox"><input type="checkbox" checked={!!shift} onChange={e => setInput({ ...input, hours: e.target.checked ? [...input.hours!, { day, start: '09:00', end: '18:00' }] : input.hours!.filter(shift => shift.day !== day) })} />{name}</label>{shift ? <><label>Start<input type="time" required value={shift.start} onChange={e => updateTime('start', e.target.value)} /></label><label>End<input type="time" required value={shift.end} onChange={e => updateTime('end', e.target.value)} /></label></> : <span className="field-help">Day off</span>}</div>;
    })}</>}
    </fieldset>{member && <p className="field-help">Changes do not cancel or move existing appointments. Existing bookings may require review after changing hours.</p>}
    {error && <p role="alert" className="booking-error">{error}</p>}<div className="booking-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">Save employee</button></div>
  </form>;
}
export function StaffPage({ staff, appointments, onSave, now }: { staff: Staff[]; appointments: Appointment[]; onSave: SaveStaff; now: number }) {
  const [query, setQuery] = useState(''); const [status, setStatus] = useState('');
  const [editor, setEditor] = useState<{ member?: Staff } | null>(null);
  const filtered = staff.filter(member => `${member.name} ${member.phone} ${member.specialty}`.toLowerCase().includes(query.trim().toLowerCase()) && (!status || member.active === (status === 'active')));
  return <section><div className="customer-toolbar panel-heading"><div><h2>Your salon team</h2><p>{staff.length} employees | Local demo business</p></div><button className="primary-button" onClick={() => setEditor({})}>Add employee</button></div>
    <p className="field-help">Seed demo employees have sample hours of 09:00-20:00 daily. Review these for your salon. New employees start with hours not configured.</p>
    {editor && <section className="panel customer-edit-panel"><StaffEditor key={editor.member?.id ?? 'new'} member={editor.member} appointments={appointments} onSave={onSave} onClose={() => setEditor(null)} /></section>}
    <div className="staff-filters"><label className="customer-search">Search staff<input type="search" value={query} placeholder="Name, phone or specialty" onChange={e => setQuery(e.target.value)} /></label><label className="customer-search">Status<select value={status} onChange={e => setStatus(e.target.value)}><option value="">All employees</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label></div>
    <p className="filter-summary" role="status">{filtered.length} matching employees. Today's counts exclude cancellations.</p>
    <div className="staff-grid">{filtered.map(member => <article key={member.id} className="panel customer-card"><div className="staff-card-heading"><h3>{member.name}</h3><span className={`status ${member.active ? 'status-completed' : 'status-cancelled'}`}>{member.active ? 'Active' : 'Inactive'}</span></div><p>{member.specialty || 'Specialty not set'}</p><p>{member.phone || 'No mobile number'}</p><dl><div><dt>Today's appointments (PKT)</dt><dd>{appointments.filter(item => item.staffId === member.id && item.date === lahoreDate(new Date(now)) && item.status !== 'Cancelled').length}</dd></div></dl><div className="staff-hours"><strong>Working hours (PKT)</strong>{member.hours === null ? <p>Not configured - booking unavailable</p> : member.hours.map(shift => <p key={shift.day}>{weekdays[shift.day]}: {shift.start}-{shift.end}</p>)}</div><div className="appointment-actions"><button onClick={() => setEditor({ member })}>Edit employee / hours</button></div></article>)}</div>
    {!filtered.length && <div className="panel empty-appointments"><h3>{staff.length ? 'No matching employees' : 'Build your salon team'}</h3><p>{staff.length ? 'Try another search or status filter.' : 'Add an employee, then configure hours before taking bookings.'}</p></div>}
  </section>;
}
