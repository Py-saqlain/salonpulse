import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Customer, CustomerInput } from './customers';
export type SaveCustomer = (input: CustomerInput, id?: string) => Customer | string;
export function CustomerEditor({ editing, onSave, onDone }: { editing?: Customer; onSave: SaveCustomer; onDone: (customer?: Customer) => void }) {
  const [input, setInput] = useState<CustomerInput>(editing ?? { name: '', phone: '', notes: '' });
  const [error, setError] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    const result = onSave(input, editing?.id);
    if (typeof result === 'string') setError(result); else onDone(result);
  }
  return <form className="customer-editor booking-fields" onSubmit={submit}>
    <h2>{editing ? 'Edit customer' : 'Add customer'}</h2><p className="booking-description">Demo business directory. Session-only demo; cleared on logout or refresh.</p>
    <label>Name<input autoFocus required maxLength={100} autoComplete="name" value={input.name} onChange={e => setInput({ ...input, name: e.target.value })} /></label>
    <label>Pakistani mobile (optional)<input type="tel" inputMode="tel" autoComplete="tel" placeholder="0300 1234567" value={input.phone} onChange={e => setInput({ ...input, phone: e.target.value })} aria-describedby="phone-help" /></label><p id="phone-help" className="field-help">Use 03xx xxxxxxx or +92 3xx xxxxxxx. Duplicate numbers are not allowed.</p>
    <label>Notes (optional)<textarea rows={3} maxLength={2000} value={input.notes} onChange={e => setInput({ ...input, notes: e.target.value })} /></label>
    {error && <p className="booking-error" role="alert">{error}</p>}
    <div className="booking-actions"><button type="button" className="secondary-button" onClick={() => onDone()}>Cancel</button><button type="submit" className="primary-button">{editing ? 'Save customer' : 'Add customer'}</button></div>
  </form>;
}
