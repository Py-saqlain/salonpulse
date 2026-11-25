import { Pagination, usePagination } from './Pagination';
import { useState } from 'react';
import type { Appointment } from './data';
import { formatPKR, formatTime } from './data';
import { customerHistory } from './customers';
import type { Customer } from './customers';
import { CustomerEditor } from './CustomerEditor';
import type { SaveCustomer } from './CustomerEditor';
export function CustomersPage({ customers, appointments, onSave, onDelete, disabled }: { onDelete: (id: string) => Promise<string | null>; disabled: boolean; customers: Customer[]; appointments: Appointment[]; onSave: SaveCustomer }) {
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [editor, setEditor] = useState<{ customer?: Customer } | null>(null);
  const selected = customers.find(customer => customer.id === selectedId);
  const query = search.trim().toLowerCase();
  const digits = query.replace(/\D/g, '');
  const filtered = customers.filter(customer => customer.name.toLowerCase().includes(query) || customer.phone.includes(query) || (digits.length > 0 && customer.phone.replace(/\D/g, '').includes(digits.replace(/^0/, ''))));
  const pagination = usePagination(filtered, search);
  async function remove(id: string) { setError(await onDelete(id) ?? ''); }
  return <section className="customer-page">
    <div className="panel-heading customer-toolbar"><div><h2>Your customer directory</h2><p>{customers.length} customers | Saved business directory</p></div><button className="primary-button" disabled={disabled} onClick={() => setEditor({})}>Add customer</button></div>
    {error && <p role="alert" className="booking-error">{error}</p>}
    {editor && <section className="panel customer-edit-panel"><CustomerEditor key={editor.customer?.id ?? 'new'} editing={editor.customer} onSave={onSave} onDone={customer => { setEditor(null); if (customer) { setSelectedId(customer.id); setSearch(''); } }} /></section>}
    <label className="customer-search">Search customers<input type="search" placeholder="Name or mobile number" value={search} onChange={e => setSearch(e.target.value)} /></label>
    <p className="filter-summary" role="status">{filtered.length} matching customers</p>
    <div className="customer-layout"><div className="customer-cards">{pagination.visible.map(customer => {
      const history = customerHistory(customer.id, appointments);
      return <article className="panel customer-card" key={customer.id}><h3>{customer.name}</h3><p>{customer.phone || 'No mobile number'}</p><dl><div><dt>Preview completed visits</dt><dd>{history.completedVisits}</dd></div><div><dt>Last preview visit</dt><dd>{history.lastCompleted?.date ?? 'No completed visits'}</dd></div></dl><div className="appointment-actions"><button aria-pressed={selectedId === customer.id} onClick={() => setSelectedId(customer.id)}>View history</button><button disabled={disabled} onClick={() => setEditor({ customer })}>Edit customer</button><button disabled={disabled} className="cancel-booking" onClick={() => void remove(customer.id)}>Delete customer</button></div></article>;
    })}{!filtered.length && <div className="panel empty-appointments"><h3>{customers.length ? 'No matching customers' : 'Your directory is empty'}</h3><p>{customers.length ? 'Try another name or number.' : 'Add a customer to start booking appointments.'}</p></div>}</div>
    <section className="panel customer-history" aria-label="Customer appointment history">{selected ? <><div className="panel-heading"><div><h2>{selected.name}</h2><p>Local preview history | Backend history not connected</p></div></div><div className="customer-notes"><strong>Notes</strong><p>{selected.notes || 'No notes added.'}</p></div>{customerHistory(selected.id, appointments).history.map(item => <article className="history-item" key={item.id}><div><strong>{item.service}</strong><p>{item.date} at {formatTime(item)} | {item.staff}</p><p>{item.bookingType ?? 'Scheduled'} | {formatPKR(item.price)}</p></div><span className={`status status-${item.status.toLowerCase().replaceAll(' ', '-')}`}>{item.status}</span></article>)}{!customerHistory(selected.id, appointments).history.length && <p className="empty-appointments">No local preview appointments. Backend appointment history will be connected next.</p>}</> : <div className="empty-appointments"><h2>A customer story, all in one place.</h2><p>Select View history to see their bookings, including completed visits and cancellations.</p></div>}</section></div>
    <Pagination {...pagination} />
  </section>;
}
