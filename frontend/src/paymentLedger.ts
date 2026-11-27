import { ApiError } from './api';
import type { ApiClient } from './api';

export const paymentMethods = { cash: 'Cash', bank_transfer: 'Bank transfer', jazzcash: 'JazzCash', easypaisa: 'Easypaisa' } as const;
export type PaymentMethod = keyof typeof paymentMethods;
export type PaymentState = 'unpaid' | 'partially_paid' | 'paid';
export const paymentLabels: Record<PaymentState, string> = { unpaid: 'Unpaid', partially_paid: 'Partially paid', paid: 'Paid' };
export type PaymentSummary = { booked_price: string; total_paid: string; balance_due: string; state: PaymentState };
export type Receipt = { id: string; business_id: string; appointment_id: string; amount: string; currency: 'PKR'; method: PaymentMethod; reference: string | null; paid_at: string; idempotency_key: string | null; created_at: string; updated_at: string };
export type PaymentHistory = { items: Receipt[]; total: number; limit: number; offset: number; summary: PaymentSummary };
export type PaymentDraft = { amount: string; method: PaymentMethod; reference: string };
export type PaymentRequest = PaymentDraft & { idempotency_key: string };
export type PaymentRecovery = { intent_id: string; business_id: string; user_id: string; appointment_id: string; state: 'pending' | 'recorded' | 'cancelled'; resolved: boolean; payload: (Omit<PaymentRequest, 'reference'> & { reference: string | null }) | null; summary: PaymentSummary };
export type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type RecoveryLocks = { request<T>(name: string, callback: () => Promise<T>): Promise<T> };
export type RecoveryOptions = { user: string; role: 'owner' | 'staff'; storage: () => RecoveryStorage; locks: () => RecoveryLocks | undefined; active: () => boolean; forbidden?: () => void };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Integer paisa avoids binary floating-point arithmetic when validating money.
export function paisa(value: string): number {
  if (typeof value !== 'string' || !/^\d{1,10}(?:\.\d{1,2})?$/.test(value)) throw new Error('Use a valid PKR amount with no more than two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export function decimalAmount(value: string): string {
  const amount = paisa(value.trim());
  return `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2, '0')}`;
}
export function paymentMoney(value: string): string {
  return `PKR ${(paisa(value) / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
export function validatePayment(draft: PaymentDraft, balance: string): string | null {
  try {
    const amount = paisa(draft.amount.trim());
    if (amount <= 0) return 'Enter a payment greater than zero.';
    if (amount > paisa(balance)) return 'This payment exceeds the outstanding balance. Refresh the balance or enter a smaller amount.';
  } catch (reason) { return (reason as Error).message; }
  if (!Object.hasOwn(paymentMethods, draft.method)) return 'Choose a supported payment method.';
  if (draft.reference.trim().length > 200) return 'Use up to 200 characters for the reference.';
  return null;
}
function verifyReceipt(value: Receipt, business: string, appointment: string): Receipt {
  if (!value || !uuid.test(value.id) || value.business_id !== business || value.appointment_id !== appointment || value.currency !== 'PKR'
    || !Object.hasOwn(paymentMethods, value.method) || paisa(value.amount) <= 0 || !Number.isFinite(Date.parse(value.paid_at))) {
    throw new Error('The payment response could not be verified. Refresh payment history.');
  }
  return value;
}
export function verifySummary(summary: PaymentSummary): PaymentSummary {
  if (!summary) throw new Error('Payment balance is unavailable. Refresh to retry.');
  const price = paisa(summary.booked_price), paid = paisa(summary.total_paid), due = paisa(summary.balance_due);
  const state = paid >= price ? 'paid' : paid > 0 ? 'partially_paid' : 'unpaid';
  if (due !== Math.max(0, price - paid) || summary.state !== state) throw new Error('The payment balance could not be verified. Refresh to retry.');
  return summary;
}
export function verifyHistory(value: PaymentHistory, business: string, appointment: string, limit: number, offset: number): PaymentHistory {
  if (!value || !Number.isSafeInteger(value.total) || value.total < 0 || value.limit !== limit || value.offset !== offset
    || !Array.isArray(value.items) || value.items.length > limit || value.items.length !== Math.min(limit, Math.max(0, value.total - offset))) {
    throw new Error('Payment history could not be verified. Refresh to retry.');
  }
  verifySummary(value.summary);
  const ids = new Set<string>();
  for (const receipt of value.items) {
    verifyReceipt(receipt, business, appointment);
    if (ids.has(receipt.id)) throw new Error('Payment history contains duplicate receipts. Refresh to retry.');
    ids.add(receipt.id);
  }
  return value;
}

// Only scoped UUID metadata is persisted. Server intents retain the payload and
// serialize unknown-outcome reconciliation, cancellation and confirmation.
export class PaymentLedger {
  private api: ApiClient;
  private business: string;
  private options: RecoveryOptions;
  private states = new Map<string, PaymentRecovery>();
  private pending = new Map<string, Promise<PaymentRecovery | null>>();
  private allowed = new Map<string, string>();
  private listeners = new Set<(appointment?: string) => void>();
  constructor(api: ApiClient, business: string, options: RecoveryOptions) { this.api = api; this.business = business; this.options = options; }
  key(id: string) { return `salonpulse.payment-recovery.v1:${this.business}:${this.options.user}:${id}`; }
  attempt(id: string) { return { recovery: this.states.get(id), pending: this.pending.get(id) }; }
  subscribe(listener: (appointment?: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private notify(id: string) { for (const listener of this.listeners) listener(id); }
  storageChanged(key: string | null) {
    const prefix = this.key('');
    if (key?.startsWith(prefix) && uuid.test(key.slice(prefix.length))) {
      const id = key.slice(prefix.length); this.states.delete(id); this.allowed.delete(id); this.notify(id);
    }
  }
  private check() { if (!this.options.active()) throw new Error('Your session has ended. Log in to recover this payment.'); }
  private pointer(id: string): string | null {
    try {
      const text = this.options.storage().getItem(this.key(id));
      if (text === null) return null;
      if (text.length > 100) throw new Error();
      const value = JSON.parse(text);
      if (!value || Object.keys(value).join(',') !== 'intent_id' || !uuid.test(value.intent_id)) throw new Error();
      return value.intent_id;
    } catch { throw new Error('Payment recovery storage is unavailable or invalid. New payments are blocked until recovery storage is available.'); }
  }
  private remember(id: string, intent: string) {
    try {
      const storage = this.options.storage(), value = JSON.stringify({ intent_id: intent });
      if (storage.getItem(this.key(id)) !== value) storage.setItem(this.key(id), value);
      if (storage.getItem(this.key(id)) !== value) throw new Error();
    } catch { throw new Error('Payment recovery metadata could not be saved. No new payment was submitted.'); }
  }
  private verify(value: PaymentRecovery, id: string): PaymentRecovery {
    if (!value || !uuid.test(value.intent_id) || value.business_id !== this.business || value.user_id !== this.options.user || value.appointment_id !== id
      || !['pending', 'recorded', 'cancelled'].includes(value.state) || typeof value.resolved !== 'boolean') throw new Error('Payment recovery identity could not be verified.');
    verifySummary(value.summary);
    if (value.state === 'pending') {
      if (!value.payload || value.payload.idempotency_key !== value.intent_id || paisa(value.payload.amount) <= 0
        || !Object.hasOwn(paymentMethods, value.payload.method) || value.resolved) throw new Error('Pending payment details could not be verified.');
    } else if (value.payload !== null) throw new Error('Unexpected payment recovery details.');
    this.states.set(id, value); return value;
  }
  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    this.check();
    try { const value = await this.api.request<T>(path, { method, body }); this.check(); return value; }
    catch (reason) { if (reason instanceof ApiError && reason.status === 403 && this.options.active()) this.options.forbidden?.(); throw reason; }
  }
  private path(id: string) { return `/api/appointments/${id}/payment-intents`; }
  private async transition(id: string, intent: string, action: string) {
    const value = this.verify(await this.request<PaymentRecovery>(`${this.path(id)}/${intent}/${action}`, 'POST'), id);
    if (value.intent_id !== intent) throw new Error('Payment recovery identifier changed unexpectedly.');
    return value;
  }
  private run(id: string, action: () => Promise<PaymentRecovery | null>): Promise<PaymentRecovery | null> {
    if (this.pending.has(id)) return this.pending.get(id)!;
    this.check();
    const locks = this.options.locks();
    if (!locks) return Promise.reject(new Error('This browser cannot safely coordinate payment recovery. Use a browser with Web Locks support.'));
    const promise = locks.request(this.key(id), async () => { this.check(); return action(); }).finally(() => { this.pending.delete(id); });
    this.pending.set(id, promise); return promise;
  }
  private async recoverLocked(id: string): Promise<PaymentRecovery | null> {
    const pointer = this.pointer(id);
    const active = await this.request<PaymentRecovery | null>(`${this.path(id)}/active`);
    if (active) this.verify(active, id);
    const intent = active?.intent_id ?? pointer;
    if (!intent) { this.states.delete(id); return null; }
    this.remember(id, intent);
    const value = await this.transition(id, intent, 'reconcile');
    if (!active && value.resolved && this.allowed.get(id) === intent) { this.states.delete(id); return null; }
    return value;
  }
  recover(id: string) { return this.run(id, () => this.recoverLocked(id)); }
  async balance(id: string, signal?: AbortSignal): Promise<PaymentSummary> {
    this.check();
    const value = await this.api.request<PaymentSummary>(`/api/appointments/${id}/payment-summary`, { signal });
    this.check();
    if (signal?.aborted) throw new Error('Request cancelled');
    return verifySummary(value);
  }
  async history(id: string, limit = 20, offset = 0, signal?: AbortSignal): Promise<PaymentHistory> {
    this.check();
    if (this.options.role !== 'owner') throw new Error('Only owners can view payment history.');
    try {
      const value = await this.api.request<PaymentHistory>(`/api/appointments/${id}/payments?limit=${limit}&offset=${offset}`, { signal });
      this.check();
    if (signal?.aborted) throw new Error('Request cancelled');
      return verifyHistory(value, this.business, id, limit, offset);
    } catch (reason) { if (reason instanceof ApiError && reason.status === 403 && this.options.active()) this.options.forbidden?.(); throw reason; }
  }
  submit(id: string, draft: PaymentDraft) {
    return this.run(id, async () => {
      let state = await this.recoverLocked(id);
      if (state && state.state !== 'pending') return state;
      if (!state) {
        const intent = crypto.randomUUID(); this.remember(id, intent);
        const payload = { amount: decimalAmount(draft.amount), method: draft.method, reference: draft.reference.trim(), idempotency_key: intent };
        state = this.verify(await this.request<PaymentRecovery>(this.path(id), 'POST', payload), id);
        if (state.intent_id !== intent) throw new Error('Payment request identifier could not be verified.');
      }
      const result = await this.transition(id, state.intent_id, 'confirm');
      if (result.state === 'recorded') this.notify(id);
      return result;
    });
  }
  next(id: string) {
    return this.run(id, async () => {
      const state = await this.recoverLocked(id);
      if (!state) return null;
      if (state.state === 'pending') throw new Error('Confirm or cancel the previous payment first.');
      const value = await this.transition(id, state.intent_id, 'acknowledge');
      this.allowed.set(id, value.intent_id); this.states.delete(id); return null;
    });
  }
  cancel(id: string) {
    return this.run(id, async () => {
      const state = await this.recoverLocked(id);
      if (!state) return null;
      const value = await this.transition(id, state.intent_id, 'cancel');
      if (value.state === 'cancelled') { this.allowed.set(id, value.intent_id); this.states.delete(id); return null; }
      this.notify(id); return value;
    });
  }
}
