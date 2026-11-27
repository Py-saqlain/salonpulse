import { useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { ApiError } from './api';
import { usePayments } from './PaymentContext';
import { localDateTime } from './appointments';
import type { Appointment } from './data';
import { checkRevenue } from './revenueMetrics';
import type { RevenueAnalytics } from './revenueMetrics';

export function useRevenueAnalytics(records: Appointment[], ready: boolean, catalogLoading: boolean, now: number) {
  const { api, session, logout } = useAuth();
  const ledger = usePayments();
  const business = session!.business;
  const owner = session!.user.role === 'owner';
  const day = localDateTime(now, business.timezone).date;
  const [data, setData] = useState<RevenueAnalytics | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => ledger.subscribe(() => setRevision(n => n + 1)), [ledger]);
  useEffect(() => {
    const abort = new AbortController();
    if (!owner) { setData(null); setLoading(false); setError(''); return () => abort.abort(); }
    setLoading(ready || catalogLoading); setError(!ready && !catalogLoading ? 'Refresh business records before loading revenue.' : '');
    if (ready) void api.request<RevenueAnalytics>(`/api/analytics/revenue?date=${day}`, { signal: abort.signal }).then(value => {
      if (!abort.signal.aborted) setData(checkRevenue(value, business.id, business.timezone, day));
    }).catch(reason => { if (!abort.signal.aborted) { setData(null); setError(reason instanceof Error ? reason.message : 'Revenue is unavailable.'); if (reason instanceof ApiError && reason.status === 403) logout(); } })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [api, business.id, business.timezone, day, records, ready, catalogLoading, revision, owner]);
  return { data, loading, error, allowed: owner, available: owner && ready && !loading && !error && !!data && data.date === day && data.business_id === business.id && data.timezone === business.timezone, refresh: () => setRevision(n => n + 1) };
}
export type RevenueView = ReturnType<typeof useRevenueAnalytics>;
