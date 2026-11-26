import type { PaymentMethod } from './paymentLedger';

export type RevenuePeriod = { start: string; end_exclusive: string; collected: string };
export type RevenueAnalytics = { business_id: string; timezone: string; currency: 'PKR'; date: string;
  daily: RevenuePeriod; weekly: RevenuePeriod; monthly: RevenuePeriod; outstanding: string;
  appointment_counts: { paid: number; partially_paid: number; unpaid: number };
  trend_start: string; trend_end_exclusive: string; trend: { date: string; collected: string }[];
  method_breakdown: { method: PaymentMethod; collected: string }[] };

export function revenuePaisa(value: string): bigint {
  if (typeof value !== 'string' || !/^\d{1,40}(?:\.\d{1,2})?$/.test(value)) throw new Error('Invalid revenue amount.');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}
export function revenueMoney(value: string): string {
  const cents = revenuePaisa(value);
  return `PKR ${(cents / 100n).toLocaleString('en-PK')}.${String(cents % 100n).padStart(2, '0')}`;
}
const dateValue = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid revenue date.');
  const day = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value) throw new Error('Invalid revenue date.');
  return day;
};
export function checkRevenue(data: RevenueAnalytics, business: string, zone: string, day: string): RevenueAnalytics {
  if (!data || data.business_id !== business || data.timezone !== zone || data.currency !== 'PKR' || data.date !== day) throw new Error('Revenue identity could not be verified.');
  const anchor = dateValue(day);
  for (const period of [data.daily, data.weekly, data.monthly]) {
    if (!period || dateValue(period.start) > anchor || dateValue(period.end_exclusive) <= anchor) throw new Error('Revenue period is invalid.');
    revenuePaisa(period.collected);
  }
  revenuePaisa(data.outstanding);
  if (!data.appointment_counts || ['paid', 'partially_paid', 'unpaid'].some(key => { const n = data.appointment_counts[key as keyof typeof data.appointment_counts]; return !Number.isSafeInteger(n) || n < 0; })) throw new Error('Revenue counts are invalid.');
  if (!Array.isArray(data.trend) || data.trend.length !== 30 || dateValue(data.trend_start) !== anchor - 29 * 86400000 || dateValue(data.trend_end_exclusive) !== anchor + 86400000) throw new Error('Revenue trend is incomplete.');
  let total = 0n;
  data.trend.forEach((point, i) => { if (dateValue(point.date) !== anchor + (i - 29) * 86400000) throw new Error('Revenue trend dates are invalid.'); total += revenuePaisa(point.collected); });
  const methods = data.method_breakdown;
  if (!Array.isArray(methods) || methods.length !== 4 || new Set(methods.map(m => m.method)).size !== 4 || methods.some(m => !['cash', 'bank_transfer', 'jazzcash', 'easypaisa'].includes(m.method))
    || methods.reduce((sum, item) => sum + revenuePaisa(item.collected), 0n) !== total) throw new Error('Revenue method totals are inconsistent.');
  return data;
}
export function trendPoints(trend: RevenueAnalytics['trend']): string {
  const values = trend.map(point => revenuePaisa(point.collected));
  const max = values.reduce((a, b) => a > b ? a : b, 1n);
  return values.map((value, i) => `${20 + i * 560 / Math.max(1, values.length - 1)},${180 - Number(value * 160n / max)}`).join(' ');
}
