import { CustomerEditor } from './CustomerEditor';
import type { SaveCustomer } from './CustomerEditor';
import type { Customer } from './customers';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { X, CalendarPlus } from 'lucide-react';
import { staffMembers, services, formatPKR, lahoreDate, validateBooking } from './data';
import type { Appointment, BookingInput } from './data';

export function AppointmentForm({ appointments, onSave, onClose, editing, customers, onSaveCustomer }: { appointments: Appointment[]; customers: Customer[]; onSaveCustomer: SaveCustomer; editing?: Appointment; onSave: (input: BookingInput) => string | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [input, setInput] = useState<BookingInput>(editing ?? { bookingType: 'Scheduled', customerId: '', service: '', staff: '', date: lahoreDate(), time: '' });
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [error, setError] = useState('');
  const errorRef = useRef<HTMLParagraphElement>(null);
  const service = services.find(s => s.name === input.service);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { element.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  function update(field: keyof BookingInput, value: string) { setInput(previous => ({ ...previous, [field]: value })); setError(''); }
  function chooseType(type: 'Scheduled' | 'Walk-in') {
    if (type === 'Walk-in') {
      const start = new Date((Math.floor(Date.now() / 60000) + 1) * 60000);
      const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(start);
      setInput(previous => ({ ...previous, bookingType: type, date: lahoreDate(start), time }));
    } else setInput(previous => ({ ...previous, bookingType: type }));
    setError('');
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const message = validateBooking(input, appointments, Date.now(), editing?.id, customers) ?? onSave(input);
    if (message) { setError(message); requestAnimationFrame(() => errorRef.current?.focus()); }
  }
  return <dialog ref={dialog} className="booking-dialog" aria-labelledby="booking-title" aria-describedby="booking-description" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="booking-heading"><div><span className="eyebrow">LOCAL DEMO BOOKING</span><h2 id="booking-title">{editing ? 'Edit appointment' : 'New appointment'}</h2></div><button type="button" className="icon-button" aria-label="Close appointment form" onClick={onClose}><X size={20} /></button></div>
    <p id="booking-description" className="booking-description">Saved only in this browser. No backend storage. All times are Lahore time (PKT, UTC+05:00).</p>
    <div hidden={!addingCustomer}>{addingCustomer && <CustomerEditor onSave={onSaveCustomer} onDone={customer => { setAddingCustomer(false); if (customer) update('customerId', customer.id); }} />}</div>
    <form onSubmit={submit} hidden={addingCustomer}>
      <div className="booking-fields"><fieldset className="booking-type"><legend>Appointment type</legend>{(['Scheduled', 'Walk-in'] as const).map(type => <label key={type}><input type="radio" name="bookingType" value={type} checked={(input.bookingType ?? 'Scheduled') === type} onChange={() => chooseType(type)} />{type}</label>)}</fieldset>{input.bookingType === 'Walk-in' && <p className="walkin-note">Start time is prefilled for the next minute in Lahore. Adjust it if the customer needs to wait; staff availability is checked on save.</p>}
        <label>Customer<select required autoFocus value={input.customerId} onChange={e => update('customerId', e.target.value)}><option value="">Select a customer</option>{customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}{customer.phone ? ` (${customer.phone})` : ''}</option>)}</select></label><button type="button" className="quick-customer" onClick={() => setAddingCustomer(true)}>+ Add customer</button>
        <label>Service<select required value={input.service} onChange={e => update('service', e.target.value)}><option value="">Select a service</option>{services.map(s => <option key={s.name}>{s.name}</option>)}</select></label>
        <div className="booking-service" aria-live="polite">{service ? <><span>{service.minutes} minutes</span><strong>{formatPKR(service.price)}</strong></> : <span>Select a service to see duration and price.</span>}</div>
        <label>Staff member<select required value={input.staff} onChange={e => update('staff', e.target.value)}><option value="">Select a staff member</option>{staffMembers.map(name => <option key={name}>{name}</option>)}</select></label>
        <div className="booking-date-time"><label>Appointment date<input type="date" required min={lahoreDate()} value={input.date} onChange={e => update('date', e.target.value)} /></label><label>Start time (PKT)<input type="time" required value={input.time} onChange={e => update('time', e.target.value)} /></label></div>
      </div>
      {error && <p role="alert" tabIndex={-1} ref={errorRef} className="booking-error">{error}</p>}
      <div className="booking-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit"><CalendarPlus size={18} aria-hidden="true" /> Save appointment</button></div>
    </form>
  </dialog>;
}
