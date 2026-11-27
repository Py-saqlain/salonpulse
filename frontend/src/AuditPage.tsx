import { useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { ApiError } from './api';
import { Pagination } from './Pagination';
import { revenueMoney } from './revenueMetrics';
import { auditActions, reconciliationIssues, checkAudit, checkReconciliation } from './audit';
import type { AuditHistory, Reconciliation } from './audit';

export function AuditPage() {
  const { api, session, logout } = useAuth();
  const owner = session!.user.role === 'owner', business = session!.business;
  const [records,setRecords] = useState<AuditHistory | null>(null), [report,setReport] = useState<Reconciliation | null>(null);
  const [action,setAction] = useState(''), [page,setPage] = useState(0), [revision,setRevision] = useState(0);
  const [loading,setLoading] = useState(true), [error,setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    if (!owner) return () => abort.abort();
    setLoading(true); setError('');
    const query = new URLSearchParams({limit:'20',offset:String(page*20)}); if (action) query.set('action',action);
    void Promise.all([
      api.request<AuditHistory>('/api/audit-logs?'+query, {signal:abort.signal}),
      api.request<Reconciliation>('/api/finance/reconciliation', {signal:abort.signal}),
    ]).then(([history,summary]) => {
      if (abort.signal.aborted) return;
      const checked = checkAudit(history,business.id,20,page*20,action);
      const last = Math.max(0,Math.ceil(checked.total/20)-1);
      if (page > last) { setPage(last); return; }
      setRecords(checked); setReport(checkReconciliation(summary,business.id,business.timezone));
    }).catch(reason => { if (!abort.signal.aborted) { setError(reason instanceof Error ? reason.message : 'Audit records are unavailable.'); if (reason instanceof ApiError && reason.status === 403) { setRecords(null); setReport(null); logout(); } } })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [api,business.id,business.timezone,owner,action,page,revision]);
  if (!owner) return <section className="panel empty-appointments"><h2>Owner access required</h2><p>Audit history and financial reconciliation are available to the salon owner.</p></section>;
  const ready = !loading && !error;
  return <div className="audit-page" data-audit-ready={ready}>
    <section className="panel revenue-panel" aria-label="Financial reconciliation" data-reconciliation-ready={ready && !!report}>
      <div className="panel-heading"><div><h2>Financial reconciliation</h2><p>All-time recorded receipts and current appointment balances. This checks our ledger, not bank or provider settlement.</p></div><button className="filter-reset" disabled={loading} onClick={()=>setRevision(n=>n+1)}>Refresh audit</button></div>
      {loading && <p className="revenue-message" role="status">Loading audit and reconciliation...</p>}
      {error && <p className="booking-error" role="alert">{error} Use Refresh audit to retry. Previously loaded records may be out of date.</p>}
      {report && <><div className="revenue-cards">{([['collected_total','Total collected'],['active_booked_total','Active booked value'],['active_paid_total','Paid on active bookings'],['outstanding_total','Outstanding balance']] as const).map(([key,label])=><article key={key}><h3>{label}</h3><strong data-reconcile-total={key}>{revenueMoney(report[key])}</strong></article>)}</div>
        <div className="audit-checks"><p className={ready && report.consistent ? 'payment-success' : 'walkin-note'} role="status">{!ready ? 'Last loaded results; refresh to verify.' : report.consistent ? 'No inconsistencies detected.' : 'Review required. No records have been changed.'}</p>
          <p>Collected on cancelled bookings: <strong>{revenueMoney(report.cancelled_collected_total)}</strong>. These receipts remain collected; no refunds are applied.</p>
          <p>Balance equations: {report.totals_match ? 'matched' : 'do not match'}. Active booked value = active paid + outstanding. Collected = active paid + cancelled receipts.</p>
          <dl>{Object.entries(reconciliationIssues).map(([key,label])=><div key={key}><dt>{label}</dt><dd data-reconcile-issue={key}>{report.issues[key as keyof typeof report.issues]}</dd></div>)}</dl>
          <p>Checked {new Intl.DateTimeFormat('en-PK',{timeZone:business.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(report.as_of))} | {business.timezone}. Historical receipts predating audit logging may need manual review.</p>
        </div></>}
    </section>
    <section className="panel audit-history" aria-label="Audit history"><div className="panel-heading"><div><h2>Audit history</h2><p>Append-only operator and resource IDs. No customer details, payment references or credentials are stored here.</p></div></div>
      <label className="audit-filter">Action<select aria-label="Audit action" value={action} onChange={event=>{setAction(event.target.value);setPage(0);setRecords(null);}}><option value="">All actions</option>{Object.entries(auditActions).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      {records?.items.map(record=><article className="audit-record" key={record.id} data-audit-id={record.id}><strong>{auditActions[record.action]}</strong><time dateTime={record.created_at}>{new Intl.DateTimeFormat('en-PK',{timeZone:business.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(record.created_at))}</time><dl><div><dt>Operator ID</dt><dd>{record.operator_id}</dd></div><div><dt>Resource ID</dt><dd>{record.resource_id}</dd></div></dl></article>)}
      {ready && records && !records.items.length && <p className="empty-appointments">No audit records match this filter. New sensitive operations will appear here.</p>}
      {records && <Pagination page={page} pages={Math.max(1,Math.ceil(records.total/20))} setPage={setPage} label="Audit history pagination" />}
    </section>
  </div>;
}
