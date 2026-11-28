import {useBookingChoices,choicePages} from './useBookingChoices';
import {staffFromAPI} from './catalog';
import type {Remote} from './workspace';
import {useEffect} from 'react';
import { useState } from 'react';
import { AppointmentList } from './AppointmentList';
import type { AppointmentActions } from './AppointmentList';
import type { Appointment } from './data';
import type { Staff } from './staff';
import { Pagination, usePagination } from './Pagination';

export function AppointmentsPage({ remote, appointments, staff, timezone, ...actions }: AppointmentActions & { remote?:Remote; appointments: Appointment[]; staff: Staff[]; timezone: string }) {
  const [search, setSearch] = useState(''), [date, setDate] = useState(''), [status, setStatus] = useState(''), [staffId, setStaffId] = useState('');
  const staffChoices=useBookingChoices('staff',staff,staffId,staffFromAPI);
  const filtered = appointments.filter(item => item.customer.toLowerCase().includes(search.trim().toLowerCase()) && (!date || item.date === date) && (!status || item.status === status) && (!staffId || item.staffId === staffId));
  const localPagination = usePagination(filtered, JSON.stringify([search, date, status, staffId]));
  const pagination=remote?{...remote,visible:appointments}:localPagination;
  useEffect(()=>{if(remote)remote.filter({q:search,day:date,status,staff_id:staffId});},[search,date,status,staffId]);
  return <section className="panel appointments-page"><div className="panel-heading"><div><h2>Manage appointments</h2><p>Saved business bookings | {timezone}</p></div><span className="count-badge">{remote?.total ?? appointments.length} appointments</span></div>
    <div className="appointment-filters"><label>Search customer<input type="search" placeholder="Customer name" value={search} onChange={event => setSearch(event.target.value)} /></label>
      <label>Date<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
      <label>Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{['Confirmed', 'In progress', 'Completed', 'Cancelled'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Search staff<input type="search" value={staffChoices.q} onChange={e=>staffChoices.search(e.target.value)} /></label><label>Staff member<select value={staffId} onChange={event => setStaffId(event.target.value)}><option value="">All staff</option>{staffChoices.items.map(member => <option key={member.id} value={member.id}>{member.name}{!member.active ? ' (inactive)' : ''}</option>)}</select></label>
      {staffChoices.total>20 && <Pagination page={staffChoices.page} pages={choicePages(staffChoices)} setPage={staffChoices.setPage} label="Staff filter options pagination" />}
      <button className="filter-reset" onClick={() => { setSearch(''); setDate(''); setStatus(''); setStaffId(''); }}>Clear filters</button>
    </div><p className="filter-summary" role="status">Showing {filtered.length} of {remote?.total ?? appointments.length} appointments</p>
    {(remote?.total ?? filtered.length) ? <AppointmentList appointments={pagination.visible} showDates showPayments {...actions} /> : <div className="empty-appointments"><h3>{appointments.length ? 'No matching appointments' : 'No appointments yet'}</h3><p>{appointments.length ? 'Adjust the filters or clear them.' : 'Create your first booking using New appointment.'}</p></div>}
    <Pagination {...pagination} />
  </section>;
}
