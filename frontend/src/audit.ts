import { revenuePaisa } from './revenueMetrics';
export const auditActions = {
  'payment.recorded': 'Payment recorded', 'appointment.created': 'Appointment created',
  'appointment.updated': 'Appointment updated', 'appointment.cancelled': 'Appointment cancelled',
  'appointment.repriced': 'Booked terms recalculated', 'appointment.status_changed': 'Appointment status changed',
  'service.created': 'Service created', 'service.updated': 'Service updated', 'service.deleted': 'Service deleted',
  'payment_intent.created': 'Payment request created', 'payment_intent.cancelled': 'Pending payment cancelled',
} as const;
export type AuditAction = keyof typeof auditActions;
export type AuditRecord = { id: string; business_id: string; operator_id: string; action: AuditAction; resource_id: string; created_at: string };
export type AuditHistory = { items: AuditRecord[]; total: number; limit: number; offset: number };
export const reconciliationIssues = {
  overpaid_appointments: 'Overpaid appointments', payments_without_matching_audit: 'Receipts without matching operator audits',
  audits_without_matching_payment: 'Payment audits without matching receipts', inconsistent_payment_intents: 'Inconsistent recovery requests',
  future_dated_payments: 'Future-dated receipts',
} as const;
export type Reconciliation = { business_id: string; currency: 'PKR'; timezone: string; as_of: string;
  collected_total: string; active_booked_total: string; active_paid_total: string; cancelled_collected_total: string;
  outstanding_total: string; totals_match: boolean; consistent: boolean; issues: Record<keyof typeof reconciliationIssues,number> };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function checkAudit(value: AuditHistory, business: string, limit: number, offset: number, action = ''): AuditHistory {
  if (!value || value.limit !== limit || value.offset !== offset || !Number.isSafeInteger(value.total) || value.total < 0
    || !Array.isArray(value.items) || value.items.length !== Math.min(limit,Math.max(0,value.total-offset))) throw new Error('Audit pagination could not be verified.');
  const ids = new Set<string>();
  for (const record of value.items) {
    if (!record || !uuid.test(record.id) || !uuid.test(record.operator_id) || !uuid.test(record.resource_id) || record.business_id !== business
      || !Object.hasOwn(auditActions, record.action) || (action && record.action !== action) || !Number.isFinite(Date.parse(record.created_at)) || ids.has(record.id)) throw new Error('Audit identity could not be verified.');
    ids.add(record.id);
  }
  return value;
}
export function checkReconciliation(value: Reconciliation, business: string, timezone: string): Reconciliation {
  if (!value || value.business_id !== business || value.currency !== 'PKR' || value.timezone !== timezone || !Number.isFinite(Date.parse(value.as_of))) throw new Error('Reconciliation identity could not be verified.');
  const collected = revenuePaisa(value.collected_total), booked = revenuePaisa(value.active_booked_total), paid = revenuePaisa(value.active_paid_total);
  const cancelled = revenuePaisa(value.cancelled_collected_total), outstanding = revenuePaisa(value.outstanding_total);
  if (!value.issues || Object.keys(value.issues).sort().join(',') !== Object.keys(reconciliationIssues).sort().join(',')
    || Object.values(value.issues).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Reconciliation checks could not be verified.');
  const match = collected === paid+cancelled && booked === paid+outstanding;
  if (value.totals_match !== match || value.consistent !== (match && Object.values(value.issues).every(n=>n===0))) throw new Error('Reconciliation result is inconsistent.');
  return value;
}
