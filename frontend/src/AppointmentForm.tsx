import { bookingService } from './services';
import type { Service } from './services';
import type { Staff } from './staff';
import { CustomerEditor } from './CustomerEditor';
import type { SaveCustomer } from './CustomerEditor';
import type { Customer } from './customers';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { X, CalendarPlus } from 'lucide-react';
import { formatPKR } from './data';
import { localDateTime, validateAppointment } from './appointments';
import type { Appointment, BookingInput } from './data';

export function AppointmentForm({ appointments, onSave, onClose, editing, customers, onSaveCustomer, staff, services, timezone, disabled }: { timezone: string; disabled: boolean; appointments: Appointment[]; services: Service[]; staff: Staff[]; customers: Customer[]; onSaveCustomer: SaveCustomer; editing?: Appointment; onSave: (input: BookingInput) => Promise<string | null>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [input, setInput] = useState<BookingInput>(editing ?? { bookingType: 'Scheduled', customerId: '', serviceId: '', staffId: '', date: localDateTime(Date.now(), timezone).date, time: '' });
  const [addingCustomer, setAddingCustomer] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const service = services.find(service => service.id === input.serviceId);
  const terms = bookingService(input, services, editing);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    element.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { element.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  function update(field: keyof BookingInput, value: string) { setInput(previous => ({ ...previous, [field]: value })); setError(''); }
  function chooseType(type: 'Scheduled' | 'Walk-in') { setInput(previous => ({ ...previous, bookingType: type })); setError(''); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (pending || disabled) return;
    setPending(true); setError('');
    try {
      const message = validateAppointment(input, { customers, staff, services, appointments }, timezone, editing) ?? await onSave(input);
      if (message) { setError(message); requestAnimationFrame(() => errorRef.current?.focus()); }
    } catch { setError('The booking could not be saved. Refresh records before trying again; the request may already have succeeded.'); }
    finally { setPending(false); }
  }
  return <dialog data-catalog-editor ref={dialog} className="booking-dialog" aria-labelledby="booking-title" aria-describedby="booking-description" onCancel={event => { if (pending) event.preventDefault(); else onClose(); }} onClick={event => { if (!pending && event.target === event.currentTarget) onClose(); }}>
    <div className="booking-heading"><div><span className="eyebrow">BUSINESS BOOKING</span><h2 id="booking-title">{editing ? 'Edit appointment' : 'New appointment'}</h2></div><button type="button" className="icon-button" aria-label="Close appointment form" disabled={pending} onClick={onClose}><X size={20} /></button></div>
    <p id="booking-description" className="booking-description">Saved to your business. All dates and working hours use {timezone}.</p>
    <div hidden={!addingCustomer}>{addingCustomer && <CustomerEditor onSave={onSaveCustomer} onDone={customer => { setAddingCustomer(false); if (customer) update('customerId', customer.id); }} />}</div>
    <form onSubmit={submit} hidden={addingCustomer} aria-busy={pending}><fieldset className="editor-fields" disabled={pending || disabled}>
      <div className="booking-fields"><fieldset className="booking-type" disabled={!!editing}><legend>Appointment type</legend>{(['Scheduled', 'Walk-in'] as const).map(type => <label key={type}><input type="radio" name="bookingType" value={type} checked={(input.bookingType ?? 'Scheduled') === type} onChange={() => chooseType(type)} />{type}</label>)}</fieldset>{input.bookingType === 'Walk-in' && <p className="walkin-note">Starts now using server time and enters In progress. Staff working hours and booking conflicts are checked again by the server.</p>}
        <label>Customer<select required autoFocus value={input.customerId} onChange={e => update('customerId', e.target.value)}><option value="">Select a customer</option>{customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}{customer.phone ? ` (${customer.phone})` : ''}</option>)}</select></label><button type="button" className="quick-customer" onClick={() => setAddingCustomer(true)}>+ Add customer</button>
        <label>Service<select required value={input.serviceId} onChange={e => { setInput(previous => ({ ...previous, serviceId: e.target.value, recalculateService: false })); setError(''); }}><option value="">Select a service</option>{services.filter(service => service.active || service.id === editing?.serviceId).map(service => <option key={service.id} value={service.id} disabled={!service.active}>{service.name}{!service.active ? ' (inactive - choose an active service)' : ''}</option>)}</select></label>
        <div className="booking-service" aria-live="polite">{typeof terms !== 'string' ? <><span>{terms.minutes} minutes</span><strong>{formatPKR(terms.price)}</strong></> : <span>{service ? terms : 'Select a service to see duration and price.'}</span>}</div>
        {editing && <div className="booking-terms"><p className="field-help">Original booking: {editing.service}, {editing.minutes} minutes, {formatPKR(editing.price)}. Saved terms are kept unless you explicitly choose current catalog values. Changing service requires this choice.</p><label className="staff-checkbox"><input type="checkbox" checked={!!input.recalculateService} onChange={e => { setInput(previous => ({ ...previous, recalculateService: e.target.checked })); setError(''); }} />Use current catalog price and duration</label>{service && <p className="field-help">Current catalog: {service.minutes} minutes, {formatPKR(service.price)}{!service.active ? ' (inactive; recalculation unavailable)' : ''}. Shift and overlap checks will run again on save.</p>}</div>}
        <label>Staff member<select required value={input.staffId} onChange={e => update('staffId', e.target.value)}><option value="">Select a staff member</option>{staff.filter(member => member.active || member.id === editing?.staffId).map(member => <option key={member.id} value={member.id} disabled={!member.active}>{member.name}{!member.active ? ' (inactive - reassign to save)' : member.hours === null ? ' (hours not configured)' : ''}</option>)}</select></label><p className="field-help">Only active employees can receive new bookings. Working hours must be configured on Staff. Edits are checked against current availability; existing assignments remain until saved.</p>
        <div className="booking-date-time" hidden={!editing && input.bookingType === 'Walk-in'}><label>Appointment date<input type="date" required={!!editing || input.bookingType !== 'Walk-in'} min={localDateTime(Date.now(), timezone).date} value={input.date} onChange={e => update('date', e.target.value)} /></label><label>Start time ({timezone})<input type="time" required={!!editing || input.bookingType !== 'Walk-in'} value={input.time} onChange={e => update('time', e.target.value)} /></label></div>
      </div>
      {error && <p role="alert" tabIndex={-1} ref={errorRef} className="booking-error">{error}</p>}
      <div className="booking-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit"><CalendarPlus size={18} aria-hidden="true" /> {pending ? 'Saving...' : 'Save appointment'}</button></div>
    </fieldset></form>
  </dialog>;
}
