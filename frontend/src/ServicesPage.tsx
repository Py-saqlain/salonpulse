import { Pagination, usePagination } from './Pagination';
import './services.css';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Service, ServiceInput } from './services';
import type { Appointment } from './data';
import { formatPKR } from './data';
import { upcomingServiceBookings } from './services';
export type SaveService = (input: ServiceInput, id?: string) => Promise<string | null>;
function ServiceEditor({ service, onSave, onClose, appointments }: { service?: Service; onSave: SaveService; onClose: () => void; appointments: Appointment[] }) {
  const [input, setInput] = useState(service ?? { name: '', category: '', description: '', active: true });
  const [minutes, setMinutes] = useState(service ? String(service.minutes) : '');
  const [price, setPrice] = useState(service ? String(service.price) : '');
  const [error, setError] = useState('');
  const [pendingSave, setPendingSave] = useState(false);
  const pending = service ? upcomingServiceBookings(service.id, appointments).length : 0;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!minutes.trim() || !price.trim()) { setError('Enter a duration and price. Use 0 for a free service.'); return; }
    if (pendingSave) return;
    setPendingSave(true); setError('');
    const result = await onSave({ ...input, minutes: Number(minutes), price: Number(price) }, service?.id);
    setPendingSave(false);
    if (result) setError(result); else onClose();
  }
  return <form data-catalog-editor className="booking-fields" onSubmit={submit} aria-busy={pendingSave}><fieldset className="editor-fields" disabled={pendingSave}><h2>{service ? 'Edit service' : 'Add service'}</h2><p className="field-help">Saved business catalog. Changes never update existing booked prices or durations.</p>
    <label>Service name<input autoFocus required maxLength={200} value={input.name} onChange={e => setInput({ ...input, name: e.target.value })} /></label>
    <div className="booking-date-time"><label>Duration (minutes)<input type="number" required min={1} max={1440} step={1} inputMode="numeric" value={minutes} onChange={e => setMinutes(e.target.value)} /></label><label>Price (PKR)<input type="number" required min={0} max={9999999999.99} step="0.01" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} /></label></div>
    <label>Category (optional)<input maxLength={100} value={input.category} onChange={e => setInput({ ...input, category: e.target.value })} /></label>
    <label>Description (optional)<textarea className="service-description-input" rows={3} maxLength={2000} value={input.description} onChange={e => setInput({ ...input, description: e.target.value })} /></label>
    <label className="staff-checkbox"><input type="checkbox" checked={input.active} onChange={e => setInput({ ...input, active: e.target.checked })} />Active service</label>
    {!input.active && pending > 0 && <p className="booking-error">{pending} upcoming or ongoing appointments keep this service. Saving deactivation requires confirmation; bookings are not cancelled.</p>}
    {error && <p className="booking-error" role="alert">{error}</p>}<div className="booking-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button">{pendingSave ? 'Saving...' : 'Save service'}</button></div>
  </fieldset></form>;
}
export function ServicesPage({ services, appointments, onSave, onDelete, owner, disabled }: { onDelete: (id: string) => Promise<string | null>; owner: boolean; disabled: boolean; services: Service[]; appointments: Appointment[]; onSave: SaveService }) {
  const [error, setError] = useState('');
  const [query, setQuery] = useState(''); const [status, setStatus] = useState(''); const [category, setCategory] = useState('');
  const [editor, setEditor] = useState<{ service?: Service } | null>(null);
  const categories = [...new Set(services.map(service => service.category).filter(Boolean))].sort();
  const filtered = services.filter(service => `${service.name} ${service.category} ${service.description}`.toLowerCase().includes(query.trim().toLowerCase()) && (!status || service.active === (status === 'active')) && (!category || (category === 'uncategorized' ? !service.category : `category:${service.category}` === category)));
  const pagination = usePagination(filtered, query + '\0' + status + '\0' + category);
  async function remove(id: string) { setError(await onDelete(id) ?? ''); }
  return <section><div className="customer-toolbar panel-heading"><div><h2>Your service menu</h2><p>{services.length} services | Saved business catalog</p></div>{owner && <button disabled={disabled} className="primary-button" onClick={() => setEditor({})}>Add service</button>}</div>
    {!owner && <p className="field-help">Read-only catalog. Only the business owner can make changes.</p>}
    {error && <p role="alert" className="booking-error">{error}</p>}
    {editor && owner && <section className="panel customer-edit-panel"><ServiceEditor key={editor.service?.id ?? 'new'} service={editor.service} onSave={onSave} onClose={() => setEditor(null)} appointments={appointments} /></section>}
    <div className="service-filters"><label className="customer-search">Search services<input type="search" placeholder="Name, category or description" value={query} onChange={e => setQuery(e.target.value)} /></label><label className="customer-search">Status<select value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label><label className="customer-search">Category<select value={category} onChange={e => setCategory(e.target.value)}><option value="">All categories</option><option value="uncategorized">Uncategorized</option>{categories.map(name => <option key={name} value={`category:${name}`}>{name}</option>)}</select></label></div>
    <p className="filter-summary" role="status">{filtered.length} matching services</p>
    <div className="staff-grid">{pagination.visible.map(service => <article className="panel customer-card" key={service.id}><div className="staff-card-heading"><h3>{service.name}</h3><span className={`status ${service.active ? 'status-completed' : 'status-cancelled'}`}>{service.active ? 'Active' : 'Inactive'}</span></div><p>{service.category || 'Uncategorized'}</p><dl><div><dt>Duration</dt><dd>{service.minutes} minutes</dd></div><div><dt>Current price</dt><dd>{formatPKR(service.price)}</dd></div></dl>{service.description && <p className="service-description">{service.description}</p>}<div className="appointment-actions">{owner && <><button disabled={disabled} onClick={() => setEditor({ service })}>Edit service</button><button disabled={disabled} className="cancel-booking" onClick={() => void remove(service.id)}>Delete service</button></>}</div></article>)}</div>
    {!filtered.length && <div className="panel empty-appointments"><h3>{services.length ? 'No matching services' : 'Build your service menu'}</h3><p>{services.length ? 'Adjust search, status or category to find a service.' : 'Add a service to begin taking bookings.'}</p>{!!services.length && <button className="filter-reset" onClick={() => { setQuery(''); setStatus(''); setCategory(''); }}>Clear filters</button>}</div>}
    <Pagination {...pagination} />
  </section>;
}
