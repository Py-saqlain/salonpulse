import { paymentMethods } from './paymentLedger';
import { revenueMoney, trendPoints } from './revenueMetrics';
import type { RevenueView } from './useRevenueAnalytics';

export function RevenuePanel({ analytics }: { analytics: RevenueView }) {
  if (!analytics.allowed) return <section className="panel empty-appointments"><h2>Owner access required</h2><p>Financial reporting is available to the salon owner.</p></section>;
  const { data, available, loading, error, refresh } = analytics;
  return <section className="panel revenue-panel" aria-label="Revenue analytics" data-revenue-ready={available}>
    <div className="panel-heading"><div><h2>Collections & balances</h2><p>Recorded payments in PKR{data ? ` | ${data.timezone}` : ''}. Unpaid bookings are excluded from collections.</p></div><button className="filter-reset" disabled={loading} onClick={refresh}>Refresh revenue</button></div>
    {loading && <p role="status" className="revenue-message">Loading revenue...</p>}
    {error && <p role="alert" className="booking-error">{error} Use Refresh revenue to retry.</p>}
    {!loading && !available && !error && <p className="revenue-message">Revenue is unavailable until business records load.</p>}
    {available && data && <>
      <div className="revenue-cards">{(['daily', 'weekly', 'monthly'] as const).map(period => <article key={period}><h3>{({ daily: 'Daily collected', weekly: 'Weekly collected', monthly: 'Monthly collected' })[period]}</h3><strong data-revenue={period}>{revenueMoney(data[period].collected)}</strong><p>{data[period].start} to {data[period].end_exclusive} (end excluded)</p></article>)}<article><h3>Total outstanding</h3><strong data-revenue="outstanding">{revenueMoney(data.outstanding)}</strong><p>All non-cancelled appointments, across all dates</p></article></div>
      <div className="revenue-payment-counts" aria-label="Appointment payment counts"><span data-paid-count={data.appointment_counts.paid}>Fully paid: {data.appointment_counts.paid}</span><span>Partially paid: {data.appointment_counts.partially_paid}</span><span>Unpaid: {data.appointment_counts.unpaid}</span></div>
      <div className="revenue-chart-layout"><section className="revenue-trend"><h3>Collected revenue trend</h3><p>30 days ending {data.date} | Payment timestamps in {data.timezone}</p><svg viewBox="0 0 600 210" role="img" aria-labelledby="revenue-chart-title revenue-chart-desc"><title id="revenue-chart-title">Daily collected payments for the last 30 days</title><desc id="revenue-chart-desc">Exact values are available in the daily collections table below.</desc><path d="M20 180H580" stroke="#a8bcae" fill="none" /><polyline points={trendPoints(data.trend)} fill="none" stroke="#23573d" strokeWidth="3" /><text x="20" y="205">{data.trend_start}</text><text x="580" y="205" textAnchor="end">{data.date}</text></svg>
        <details><summary>View daily collections table</summary><div className="revenue-table"><table><caption>Actual collected payments | {data.timezone}</caption><thead><tr><th scope="col">Date</th><th scope="col">Collected (PKR)</th></tr></thead><tbody>{data.trend.map(point => <tr key={point.date}><th scope="row">{point.date}</th><td>{revenueMoney(point.collected)}</td></tr>)}</tbody></table></div></details>
      </section><section className="revenue-methods"><h3>By payment method</h3><p>Same 30-day period as the trend</p><dl>{data.method_breakdown.map(item => <div key={item.method}><dt>{paymentMethods[item.method]}</dt><dd data-revenue-method={item.method}>{revenueMoney(item.collected)}</dd></div>)}</dl></section></div>
      <p className="revenue-message">Weeks start Monday; daily, weekly and monthly totals use calendar periods. Cancelled appointments are excluded from balances and counts. Their recorded receipts remain collected; no refunds are processed.</p>
    </>}
  </section>;
}
