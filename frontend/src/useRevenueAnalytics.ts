import { useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { usePayments } from './PaymentContext';
import { localDateTime } from './appointments';
import type { Appointment } from './data';
import { checkRevenue } from './revenueMetrics';
import type { RevenueAnalytics } from './revenueMetrics';

export function useRevenueAnalytics(records: Appointment[], ready: boolean, catalogLoading: boolean, now: number) {
  const { api, session } = useAuth();
  const ledger = usePayments();
  const business = session!.business;
  const day = localDateTime(now, business.timezone).date;
  const [data, setData] = useState<RevenueAnalytics | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => ledger.subscribe(() => setRevision(n => n + 1)), [ledger]);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(ready || catalogLoading); setError(!ready && !catalogLoading ? 'Refresh business records before loading revenue.' : '');
    if (ready) void api.request<RevenueAnalytics>(`/api/analytics/revenue?date=${day}`, { signal: abort.signal }).then(value => {
      if (!abort.signal.aborted) setData(checkRevenue(value, business.id, business.timezone, day));
    }).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : 'Revenue is unavailable.'); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [api, business.id, business.timezone, day, records, ready, catalogLoading, revision]);
  return { data, loading, error, available: ready && !loading && !error && !!data && data.date === day && data.business_id === business.id && data.timezone === business.timezone, refresh: () => setRevision(n => n + 1) };
}
export type RevenueView = ReturnType<typeof useRevenueAnalytics>;
