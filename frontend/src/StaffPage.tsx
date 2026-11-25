import { Pagination, usePagination } from './Pagination';
import './staff.css';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { weekdays, upcomingStaffBookings } from './staff';
import type { Staff, StaffInput } from './staff';
import type { Appointment } from './data';
import { lahoreDate } from './data';
export type SaveStaff = (input: StaffInput, id?: string) => Promise<string | null>;
function StaffEditor({ member, onSave, onClose, appointments, timezone }: { timezone: string; member?: Staff; onSave: SaveStaff; onClose: () => void; appointments: Appointment[] }) {
  const [input, setInput] = useState<StaffInput>(member ?? { name: '', phone: '', specialty: '', active: true, hours: null });
  const [error, setError] = useState('');
  const [pendingSave, setPendingSave] = useState(false);
  const pending = member ? upcomingStaffBookings(member.id, appointments).length : 0;
  async function submit(event: FormEvent) { event.preventDefault(); if (pendingSave) return; setPendingSave(true); setError(''); try { const error = await onSave(input, member?.id); if (error) setError(error); else onClose(); } finally { setPendingSave(false); } }
  return <form data-catalog-editor className="booking-fields staff-editor" onSubmit={submit} aria-busy={pendingSave}><fieldset className="editor-fields" disabled={pendingSave}><h2>{member ? 'Edit employee' : 'Add employee'}</h2><p className="field-help">Saved to your business. Working times use {timezone}.</p>
    <label>Name<input autoFocus required maxLength={200} value={input.name} onChange={e => setInput({ ...input, name: e.target.value })} /></label>
    <label>Mobile (optional)<input type="tel" inputMode="tel" placeholder="0300 1234567" value={input.phone} onChange={e => setInput({ ...input, phone: e.target.value })} /></label>
    <label>Role / specialty (optional)<input maxLength={200} value={input.specialty} onChange={e => setInput({ ...input, specialty: e.target.value })} /></label>
    <label className="staff-checkbox"><input type="checkbox" checked={input.active} onChange={e => setInput({ ...input, active: e.target.checked })} />Active employee</label>
    {!input.active && pending > 0 && <p className="booking-error">{pending} upcoming or ongoing bookings will remain assigned. Saving requires confirmation; arrange reassignment or cancellation separately.</p>}
    <fieldset className="working-hours"><legend>Working hours</legend><label className="staff-checkbox"><input type="checkbox" checked={input.hours !== null} onChange={e => setInput({ ...input, hours: e.target.checked ? [{ day: 1, start: '09:00', end: '18:00' }] : null })} />Configure weekly hours</label>
    {input.hours === null ? <p className="field-help">Not configured. New appointments are blocked until hours are set.</p> : <><p className="field-help">Choose working days and one same-day shift per day. The entire service must fit.</p>{weekdays.map((name, day) => {
      const shift = input.hours?.find(shift => shift.day === day);
      const updateTime = (field: 'start' | 'end', value: string) => setInput({ ...input, hours: input.hours!.map(shift => shift.day === day ? { ...shift, [field]: value } : shift) });
      return <div className="shift-row" key={day}><label className="staff-checkbox"><input type="checkbox" checked={!!shift} onChange={e => setInput({ ...input, hours: e.target.checked ? [...input.hours!, { day, start: '09:00', end: '18:00' }] : input.hours!.filter(shift => shift.day !== day) })} />{name}</label>{shift ? <><label>Start<input type="time" required value={shift.start} onChange={e => updateTime('start', e.target.value)} /></label><label>End<input type="time" required value={shift.end} onChange={e => updateTime('end', e.target.value)} /></label></> : <span className="field-help">Day off</span>}</div>;
    })}</>}
    </fieldset>{member && <p className="field-help">Changes do not cancel or move existing appointments. Existing bookings may require review after changing hours.</p>}
    {error && <p role="alert" className="booking-error">{error}</p>}<div className="booking-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">{pendingSave ? 'Saving...' : 'Save employee'}</button></div>
  </fieldset></form>;
}
export function StaffPage({ staff, appointments, onSave, now, onDelete, owner, disabled, timezone }: { timezone: string; onDelete: (id: string) => Promise<string | null>; owner: boolean; disabled: boolean; staff: Staff[]; appointments: Appointment[]; onSave: SaveStaff; now: number }) {
  const [error, setError] = useState('');
  const [query, setQuery] = useState(''); const [status, setStatus] = useState('');
  const [editor, setEditor] = useState<{ member?: Staff } | null>(null);
  const filtered = staff.filter(member => `${member.name} ${member.phone} ${member.specialty}`.toLowerCase().includes(query.trim().toLowerCase()) && (!status || member.active === (status === 'active')));
  const pagination = usePagination(filtered, query + '\0' + status);
  async function remove(id: string) { setError(await onDelete(id) ?? ''); }
  return <section><div className="customer-toolbar panel-heading"><div><h2>Your salon team</h2><p>{staff.length} employees | Saved business directory</p></div>{owner && <button className="primary-button" disabled={disabled} onClick={() => setEditor({})}>Add employee</button>}</div>
    <p className="field-help">{owner ? 'New employees start with hours not configured. Set working hours before taking bookings.' : 'Read-only team directory. Only the business owner can make changes.'}</p>
    {error && <p role="alert" className="booking-error">{error}</p>}
    {editor && owner && <section className="panel customer-edit-panel"><StaffEditor key={editor.member?.id ?? 'new'} member={editor.member} timezone={timezone} appointments={appointments} onSave={onSave} onClose={() => setEditor(null)} /></section>}
    <div className="staff-filters"><label className="customer-search">Search staff<input type="search" value={query} placeholder="Name, phone or specialty" onChange={e => setQuery(e.target.value)} /></label><label className="customer-search">Status<select value={status} onChange={e => setStatus(e.target.value)}><option value="">All employees</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label></div>
    <p className="filter-summary" role="status">{filtered.length} matching employees. Counts are local appointment previews, excluding cancellations.</p>
    <div className="staff-grid">{pagination.visible.map(member => <article key={member.id} className="panel customer-card"><div className="staff-card-heading"><h3>{member.name}</h3><span className={`status ${member.active ? 'status-completed' : 'status-cancelled'}`}>{member.active ? 'Active' : 'Inactive'}</span></div><p>{member.specialty || 'Specialty not set'}</p><p>{member.phone || 'No mobile number'}</p><dl><div><dt>Today's preview bookings (PKT)</dt><dd>{appointments.filter(item => item.staffId === member.id && item.date === lahoreDate(new Date(now)) && item.status !== 'Cancelled').length}</dd></div></dl><div className="staff-hours"><strong>Working hours ({timezone})</strong>{member.hours === null ? <p>Not configured - booking unavailable</p> : member.hours.map(shift => <p key={shift.day}>{weekdays[shift.day]}: {shift.start}-{shift.end}</p>)}</div><div className="appointment-actions">{owner && <><button disabled={disabled} onClick={() => setEditor({ member })}>Edit employee / hours</button><button disabled={disabled} className="cancel-booking" onClick={() => void remove(member.id)}>Delete employee</button></>}</div></article>)}</div>
    {!filtered.length && <div className="panel empty-appointments"><h3>{staff.length ? 'No matching employees' : 'Build your salon team'}</h3><p>{staff.length ? 'Try another search or status filter.' : 'Add an employee, then configure hours before taking bookings.'}</p></div>}
    <Pagination {...pagination} />
  </section>;
}
