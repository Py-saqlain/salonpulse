import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Customer, CustomerInput } from './customers';
export type SaveCustomer = (input: CustomerInput, id?: string) => Promise<Customer | string>;
export function CustomerEditor({ editing, onSave, onDone }: { editing?: Customer; onSave: SaveCustomer; onDone: (customer?: Customer) => void }) {
  const [input, setInput] = useState<CustomerInput>(editing ?? { name: '', phone: '', notes: '' });
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError('');
    try { const result = await onSave(input, editing?.id); if (typeof result === 'string') setError(result); else onDone(result); }
    finally { setPending(false); }
  }
  return <form data-catalog-editor className="customer-editor booking-fields" onSubmit={submit} aria-busy={pending}><fieldset disabled={pending} className="editor-fields">
    <h2>{editing ? 'Edit customer' : 'Add customer'}</h2><p className="booking-description">Saved securely to your business directory.</p>
    <label>Name<input autoFocus required maxLength={200} autoComplete="name" value={input.name} onChange={e => setInput({ ...input, name: e.target.value })} /></label>
    <label>Pakistani mobile (optional)<input type="tel" inputMode="tel" autoComplete="tel" placeholder="0300 8672095" value={input.phone} onChange={e => setInput({ ...input, phone: e.target.value })} aria-describedby="phone-help" /></label><p id="phone-help" className="field-help">Use 03xx xxxxxxx or +92 3xx xxxxxxx. Duplicate numbers are not allowed.</p>
    <label>Notes (optional)<textarea rows={3} maxLength={4000} value={input.notes} onChange={e => setInput({ ...input, notes: e.target.value })} /></label>
    {error && <p className="booking-error" role="alert">{error}</p>}
    <div className="booking-actions"><button type="button" className="secondary-button" onClick={() => onDone()}>Cancel</button><button type="submit" className="primary-button">{pending ? 'Saving...' : editing ? 'Save customer' : 'Add customer'}</button></div>
  </fieldset></form>;
}
