import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Banknote, X } from 'lucide-react';
import { ApiError } from './api';
import { useAuth } from './AuthContext';
import type { Appointment } from './data';
import { Pagination } from './Pagination';
import { usePayments } from './PaymentContext';
import { paymentLabels, paymentMethods, paymentMoney, validatePayment } from './paymentLedger';
import type { PaymentDraft, PaymentHistory, PaymentMethod, PaymentSummary } from './paymentLedger';

function failure(reason: unknown): string {
  if (reason instanceof ApiError && Object.keys(reason.fields).length) return Object.values(reason.fields).join(' ');
  return reason instanceof Error ? reason.message : 'Payment information is unavailable. Please retry.';
}
function Totals({ summary }: { summary: PaymentSummary }) {
  return <><span className={`payment-status payment-${summary.state}`}>{paymentLabels[summary.state]}</span><dl className="payment-totals">
    <div><dt>Booked price</dt><dd data-payment-total="price">{paymentMoney(summary.booked_price)}</dd></div>
    <div><dt>Paid amount</dt><dd data-payment-total="paid">{paymentMoney(summary.total_paid)}</dd></div>
    <div><dt>Outstanding</dt><dd data-payment-total="due">{paymentMoney(summary.balance_due)}</dd></div>
  </dl></>;
}

export function AppointmentPayment({ appointment, disabled }: { appointment: Appointment; disabled?: boolean }) {
  const ledger = usePayments();
  const [summary, setSummary] = useState<PaymentSummary | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setSummary(null); setError('');
    void ledger.history(appointment.id, 1, 0, abort.signal).then(value => { if (!abort.signal.aborted) setSummary(value.summary); })
      .catch(reason => { if (!abort.signal.aborted) setError(failure(reason)); });
    return () => abort.abort();
  }, [ledger, appointment, revision]);
  return <div className="appointment-payment" data-payment-appointment={appointment.id}>
    <div className="payment-row-details">{summary ? <><span className={`payment-status payment-${summary.state}`}>{paymentLabels[summary.state]}</span><span>Paid <strong>{paymentMoney(summary.total_paid)}</strong></span><span>Outstanding <strong>{paymentMoney(summary.balance_due)}</strong></span></> : <span role="status">{error ? 'Payment balance unavailable' : 'Loading payment balance...'}</span>}</div>
    <div className="payment-row-actions">{summary && summary.state !== 'paid' && appointment.status !== 'Cancelled' && <button className="filter-reset record-payment" disabled={disabled} onClick={() => setOpen(true)}><Banknote size={16} aria-hidden="true" />Record payment</button>}
      <button className="filter-reset" disabled={disabled} onClick={() => setOpen(true)}>Payment history</button>{error && <button className="filter-reset" onClick={() => setRevision(value => value + 1)}>Retry balance</button>}</div>
    {open && <PaymentDialog appointment={appointment} disabled={disabled} onSummary={setSummary} onClose={() => setOpen(false)} />}
  </div>;
}

function PaymentDialog({ appointment, disabled, onClose, onSummary }: { appointment: Appointment; disabled?: boolean; onClose: () => void; onSummary: (summary: PaymentSummary) => void }) {
  const ledger = usePayments();
  const { session } = useAuth();
  const zone = session!.business.timezone;
  const dialog = useRef<HTMLDialogElement>(null), alive = useRef(false), sending = useRef(false);
  const [history, setHistory] = useState<PaymentHistory | null>(null);
  const [loading, setLoading] = useState(true), [ready, setReady] = useState(false);
  const [page, setPage] = useState(0), [reload, setReload] = useState(0);
  const [error, setError] = useState(''), [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState(!!ledger.attempt(appointment.id)?.pending);
  const [draft, setDraft] = useState<PaymentDraft>(() => ledger.attempt(appointment.id)?.payload ?? { amount: '', method: 'cash', reference: '' });
  const attempt = ledger.attempt(appointment.id);
  const uncertain = !!attempt && !attempt.receipt;
  const saved = !!attempt?.receipt;
  useEffect(() => {
    alive.current = true;
    const element = dialog.current!, previous = document.activeElement as HTMLElement | null;
    element.showModal(); const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    // A request may still be resolving after its appointment row was filtered out.
    const request = ledger.attempt(appointment.id)?.pending;
    if (request) void request.then(() => { if (alive.current) setReload(n => n + 1); }).catch(reason => { if (alive.current) setError(failure(reason)); }).finally(() => { if (alive.current) setPending(false); });
    return () => { alive.current = false; element.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, [ledger, appointment.id]);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setReady(false); setLoadError('');
    void ledger.history(appointment.id, 10, page * 10, abort.signal).then(value => {
      if (abort.signal.aborted) return;
      const last = Math.max(0, Math.ceil(value.total / 10) - 1);
      if (page > last) { setPage(last); return; }
      setHistory(value); setReady(true); onSummary(value.summary);
      setDraft(old => !old.amount && !ledger.attempt(appointment.id) ? { ...old, amount: value.summary.balance_due } : old);
    }).catch(reason => { if (!abort.signal.aborted) setLoadError(failure(reason)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [ledger, appointment, page, reload, onSummary]);
  function update(field: keyof PaymentDraft, value: string) { setDraft(old => ({ ...old, [field]: value })); setError(''); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (sending.current || pending || saved || disabled || (!uncertain && !ready)) return;
    if (!uncertain) {
      const message = validatePayment(draft, history!.summary.balance_due);
      if (message) { setError(message); return; }
    }
    sending.current = true; setPending(true); setError('');
    try {
      await ledger.submit(appointment.id, draft);
      if (alive.current) { setPage(0); setReload(value => value + 1); }
    } catch (reason) {
      if (alive.current) {
        setError(failure(reason));
        // A definite rejection refreshes the latest balance without changing the draft.
        if (!ledger.attempt(appointment.id)) setReload(value => value + 1);
      }
    } finally { sending.current = false; if (alive.current) setPending(false); }
  }
  const eligible = appointment.status !== 'Cancelled' && history?.summary.state !== 'paid';
  const refresh = () => setReload(value => value + 1);
  return <dialog data-catalog-editor data-payment-dialog ref={dialog} className="booking-dialog payment-dialog" aria-labelledby="payment-title" onCancel={event => { if (pending) event.preventDefault(); else onClose(); }}>
    <div className="booking-heading"><div><span className="eyebrow">APPOINTMENT PAYMENT</span><h2 id="payment-title">Payments for {appointment.customer}</h2></div><button type="button" className="icon-button" aria-label="Close payments" disabled={pending} onClick={onClose}><X size={20} aria-hidden="true" /></button></div>
    <p className="booking-description">{appointment.service} | {appointment.date} | Receipts saved to your business.</p>
    {history && <section className="payment-overview" aria-label="Payment balance"><Totals summary={history.summary} />{!ready && <p>Last loaded balance. Refresh before recording a new payment.</p>}</section>}
    <div className="directory-toolbar"><button className="filter-reset" disabled={loading || pending} onClick={refresh}>Refresh payments</button>{loading && <span role="status">Loading payments...</span>}</div>
    {loadError && <p role="alert" className="booking-error">{loadError} Use Refresh payments to retry.</p>}
    {saved && <div className="payment-success" role="status"><strong>Payment recorded.</strong><p>The receipt is saved. Refresh history if the balance is unavailable.</p>{ready && eligible && <button className="filter-reset" onClick={() => { ledger.next(appointment.id); setDraft({ amount: history!.summary.balance_due, method: 'cash', reference: '' }); setError(''); }}>Record another payment</button>}</div>}
    {!saved && (eligible || uncertain) && <form className="payment-form" onSubmit={submit} aria-busy={pending}>
      <h3>{uncertain ? 'Confirm previous payment' : 'Record a payment'}</h3>
      {uncertain && !pending && <p className="walkin-note">The previous request is not confirmed. Retry the same payment safely; its original details and request key are kept. Keep this session open. If you reload or log out, review history before recording again.</p>}
      <fieldset className="editor-fields" disabled={pending || uncertain || !ready || disabled}>
        <label>Amount (PKR)<input autoFocus name="payment_amount" type="text" inputMode="decimal" required maxLength={13} value={draft.amount} onChange={event => update('amount', event.target.value)} aria-describedby="payment-amount-help" /></label>
        <p className="field-help" id="payment-amount-help">Enter the full outstanding balance or a smaller partial payment. Up to two decimal places.</p>
        <button type="button" className="filter-reset" onClick={() => update('amount', history!.summary.balance_due)}>Use full outstanding balance</button>
        <label>Payment method<select name="payment_method" value={draft.method} onChange={event => update('method', event.target.value as PaymentMethod)}>{Object.entries(paymentMethods).map(([method, label]) => <option key={method} value={method}>{label}</option>)}</select></label>
        <label>Reference (optional)<input name="payment_reference" maxLength={200} value={draft.reference} onChange={event => update('reference', event.target.value)} placeholder="Receipt or transfer reference" /></label>
      </fieldset>
      {error && <p role="alert" className="booking-error">{error}</p>}
      <div className="booking-actions"><button type="button" className="secondary-button" disabled={pending} onClick={onClose}>Close</button><button className="primary-button" disabled={pending || disabled || (!uncertain && !ready)} type="submit">{pending ? 'Recording payment...' : uncertain ? 'Retry same payment' : 'Save payment'}</button></div>
    </form>}
    {!uncertain && !saved && history?.summary.state === 'paid' && <p className="payment-success" role="status">No outstanding balance. This appointment is paid.</p>}
    {appointment.status === 'Cancelled' && <p className="walkin-note">This appointment is cancelled. Existing receipts remain in history; new payments are not allowed.</p>}
    <section className="payment-history" aria-label="Payment history"><h3>Payment history{history ? ` (${history.total})` : ''}</h3>{history && !history.items.length && <p className="empty-appointments">No payments recorded yet.</p>}
      {history?.items.map(receipt => <article className="payment-receipt" key={receipt.id} data-receipt-id={receipt.id}><div><strong>{paymentMoney(receipt.amount)}</strong><span>{paymentMethods[receipt.method]}</span></div><p>{new Intl.DateTimeFormat('en-PK', { timeZone: zone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(receipt.paid_at))} | {zone}</p>{receipt.reference && <p className="payment-reference">Reference: {receipt.reference}</p>}</article>)}
      {history && <Pagination page={page} pages={Math.max(1, Math.ceil(history.total / 10))} setPage={setPage} label="Payment history pagination" />}
    </section>
  </dialog>;
}
