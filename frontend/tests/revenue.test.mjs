import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
const directory = mkdtempSync(join(tmpdir(), 'salonpulse-revenue-'));
let metrics;
try {
  writeFileSync(join(directory, 'revenue.mjs'), stripTypeScriptTypes(readFileSync(new URL('../src/revenueMetrics.ts', import.meta.url), 'utf8')));
  metrics = await import(pathToFileURL(join(directory, 'revenue.mjs')));
} finally { rmSync(directory, { recursive: true, force: true }); }
const data = () => ({ business_id: 'business-a', timezone: 'Asia/Karachi', currency: 'PKR', date: '2026-03-01',
  daily: { start: '2026-03-01', end_exclusive: '2026-03-02', collected: '0.30' },
  weekly: { start: '2026-02-23', end_exclusive: '2026-03-02', collected: '0.30' },
  monthly: { start: '2026-03-01', end_exclusive: '2026-04-01', collected: '0.30' }, outstanding: '1000.25',
  appointment_counts: { paid: 1, partially_paid: 1, unpaid: 1 }, trend_start: '2026-01-31', trend_end_exclusive: '2026-03-02',
  trend: Array.from({ length: 30 }, (_, i) => ({ date: new Date(Date.parse('2026-01-31T00:00Z') + i * 86400000).toISOString().slice(0, 10), collected: i === 29 ? '0.30' : '0.00' })),
  method_breakdown: ['cash', 'bank_transfer', 'jazzcash', 'easypaisa'].map((method, i) => ({ method, collected: i === 0 ? '0.10' : i === 1 ? '0.20' : '0.00' })) });
const verify = value => metrics.checkRevenue(value, 'business-a', 'Asia/Karachi', '2026-03-01');
test('aggregate money preserves exact paisa even above JavaScript safe integer totals', () => {
  assert.equal(metrics.revenuePaisa('0.10') + metrics.revenuePaisa('0.20'), 30n);
  assert.equal(metrics.revenueMoney('900719925474099.31'), 'PKR 900,719,925,474,099.31');
  for (const amount of ['NaN', 'Infinity', '-1', '1.001', '1e6']) assert.throws(() => metrics.revenueMoney(amount));
});
test('revenue validates business identity, timezone and reporting date', () => {
  assert.deepEqual(verify(data()), data());
  for (const fields of [{ business_id: 'business-b' }, { timezone: 'UTC' }, { date: '2026-03-02' }, { currency: 'USD' }]) assert.throws(() => verify({ ...data(), ...fields }));
});
test('trend requires continuous local calendar dates and method totals match exact receipts', () => {
  const missing = data(); missing.trend.pop(); assert.throws(() => verify(missing));
  const duplicate = data(); duplicate.trend[1].date = duplicate.trend[0].date; assert.throws(() => verify(duplicate));
  const wrongMethod = data(); wrongMethod.method_breakdown[0].collected = '0.11'; assert.throws(() => verify(wrongMethod));
  const wrongDate = data(); wrongDate.trend[0].date = '2026-02-30'; assert.throws(() => verify(wrongDate));
});
test('unknown counts and negative balances fail rather than displaying misleading zeroes', () => {
  for (const fields of [{ outstanding: '-1' }, { appointment_counts: { paid: -1, partially_paid: 0, unpaid: 0 } },
                        { appointment_counts: { other: 1, partially_paid: 0, unpaid: 0 } }]) assert.throws(() => verify({ ...data(), ...fields }));
});
test('empty and large revenue trends produce finite chart coordinates', () => {
  const zero = data().trend.map(point => ({ ...point, collected: '0.00' }));
  assert.equal(metrics.trendPoints(zero).split(' ').length, 30);
  zero[29].collected = '900719925474099.31';
  assert.ok(metrics.trendPoints(zero).endsWith('580,20'));
  assert.equal(/NaN|Infinity/.test(metrics.trendPoints(zero)), false);
});
