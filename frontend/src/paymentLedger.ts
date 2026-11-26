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
export type PaymentAttempt = { payload: PaymentRequest; receipt?: Receipt; pending?: Promise<Receipt> };
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
export function verifyHistory(value: PaymentHistory, business: string, appointment: string, limit: number, offset: number): PaymentHistory {
  if (!value || !Number.isSafeInteger(value.total) || value.total < 0 || value.limit !== limit || value.offset !== offset
    || !Array.isArray(value.items) || value.items.length > limit || value.items.length !== Math.min(limit, Math.max(0, value.total - offset))) {
    throw new Error('Payment history could not be verified. Refresh to retry.');
  }
  const summary = value.summary;
  if (!summary) throw new Error('Payment balance is unavailable. Refresh to retry.');
  const price = paisa(summary.booked_price), paid = paisa(summary.total_paid), due = paisa(summary.balance_due);
  const state = paid >= price ? 'paid' : paid > 0 ? 'partially_paid' : 'unpaid';
  if (due !== Math.max(0, price - paid) || summary.state !== state) throw new Error('The payment balance could not be verified. Refresh to retry.');
  const ids = new Set<string>();
  for (const receipt of value.items) {
    verifyReceipt(receipt, business, appointment);
    if (ids.has(receipt.id)) throw new Error('Payment history contains duplicate receipts. Refresh to retry.');
    ids.add(receipt.id);
  }
  return value;
}

// One ledger per authenticated session. Pending keys survive closing an editor,
// filtering and navigation, but are never written to browser storage.
export class PaymentLedger {
  private api: ApiClient;
  private business: string;
  private attempts = new Map<string, PaymentAttempt>();
  private listeners = new Set<() => void>();
  constructor(api: ApiClient, business: string) { this.api = api; this.business = business; }
  attempt(id: string) { return this.attempts.get(id); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async history(id: string, limit = 20, offset = 0, signal?: AbortSignal): Promise<PaymentHistory> {
    const value = await this.api.request<PaymentHistory>(`/api/appointments/${id}/payments?limit=${limit}&offset=${offset}`, { signal });
    if (signal?.aborted) throw new Error('Request cancelled');
    return verifyHistory(value, this.business, id, limit, offset);
  }
  submit(id: string, draft: PaymentDraft): Promise<Receipt> {
    const old = this.attempts.get(id);
    if (old?.receipt) return Promise.resolve(old.receipt);
    if (old?.pending) return old.pending;
    const attempt: PaymentAttempt = old ?? { payload: { amount: decimalAmount(draft.amount), method: draft.method, reference: draft.reference.trim(), idempotency_key: crypto.randomUUID() } };
    this.attempts.set(id, attempt);
    attempt.pending = this.api.request<Receipt>(`/api/appointments/${id}/payments`, { method: 'POST', body: attempt.payload })
      .then(receipt => { attempt.receipt = verifyReceipt(receipt, this.business, id); for (const listener of this.listeners) listener(); return attempt.receipt; })
      .catch(reason => {
        // Network, 5xx and unreadable success responses may follow a committed
        // write. Retain the immutable request/key until its result is confirmed.
        if (reason instanceof ApiError && [400, 403, 404, 409, 422].includes(reason.status)) this.attempts.delete(id);
        throw reason;
      }).finally(() => { attempt.pending = undefined; });
    return attempt.pending;
  }
  next(id: string): void {
    const attempt = this.attempts.get(id);
    if (attempt && !attempt.receipt) throw new Error('Resolve the previous payment before recording another.');
    this.attempts.delete(id);
  }
}
