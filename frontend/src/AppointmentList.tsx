import type { Appointment } from './data';
import { formatPKR, formatTime, startsAt } from './data';

export type AppointmentActions = { onEdit?: (item: Appointment) => void; onStatus?: (item: Appointment, status: 'In progress' | 'Completed' | 'Cancelled') => void; disabled?: boolean };
export function AppointmentList({ appointments, showDates = false, onEdit, onStatus, disabled }: AppointmentActions & { appointments: Appointment[]; showDates?: boolean }) {
  if (!appointments.length) return <p className="empty-appointments">No appointments yet. Create a booking to get started.</p>;
  return <div className="appointment-list">{appointments.map(item => <article className="appointment" key={item.id} data-appointment-id={item.id}>
    <div className="appointment-time"><strong>{formatTime(item)}</strong>{showDates && <span>{item.date}</span>}<span>{item.minutes} min</span></div>
    <span className="avatar customer-avatar" aria-hidden="true">{item.initials}</span>
    <div className="appointment-person"><h3>{item.customer}</h3><p>{item.service}</p><span className="booking-kind">{item.bookingType}</span><span className="mobile-staff">with {item.staff}</span></div>
    <div className="appointment-staff"><span>Team member</span><strong>{item.staff}</strong></div>
    <div className="appointment-end"><strong>{formatPKR(item.price)}</strong><span className={`status status-${item.status.toLowerCase().replaceAll(' ', '-')}`}>{item.status}</span></div>
    {onStatus && ['Confirmed', 'In progress'].includes(item.status) && <div className="appointment-actions">
      {item.status === 'Confirmed' && <><button disabled={disabled} onClick={() => onEdit?.(item)}>Edit</button><button disabled={disabled || startsAt(item) > Date.now()} onClick={() => onStatus(item, 'In progress')}>Start appointment</button></>}
      {item.status === 'In progress' && <button disabled={disabled} onClick={() => onStatus(item, 'Completed')}>Complete</button>}
      <button disabled={disabled} className="cancel-booking" onClick={() => onStatus(item, 'Cancelled')}>Cancel appointment</button>
    </div>}
  </article>)}</div>;
}
