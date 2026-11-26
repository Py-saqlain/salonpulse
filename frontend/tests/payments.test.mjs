import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const directory = mkdtempSync(join(tmpdir(), 'salonpulse-payments-'));
let payment, ApiClient, ApiError;
try {
  for (const name of ['api', 'paymentLedger']) {
    const code = stripTypeScriptTypes(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')).replaceAll("'./api'", "'./api.mjs'");
    writeFileSync(join(directory, name + '.mjs'), code);
  }
  payment = await import(pathToFileURL(join(directory, 'paymentLedger.mjs')));
  ({ ApiClient, ApiError } = await import(pathToFileURL(join(directory, 'api.mjs'))));
} finally { rmSync(directory, { recursive: true, force: true }); }
const business = '11111111-1111-4111-8111-111111111111', appointment = '22222222-2222-4222-8222-222222222222';
const receipt = { id: '33333333-3333-4333-8333-333333333333', business_id: business, appointment_id: appointment,
  amount: '250.25', currency: 'PKR', method: 'cash', reference: null, paid_at: '2026-01-01T09:00:00Z',
  idempotency_key: null, created_at: '2026-01-01T09:00:00Z', updated_at: '2026-01-01T09:00:00Z' };
const summary = { booked_price: '1000.00', total_paid: '250.25', balance_due: '749.75', state: 'partially_paid' };
const history = () => ({ items: [{ ...receipt }], total: 1, limit: 10, offset: 0, summary: { ...summary } });
const draft = { amount: '250.25', method: 'cash', reference: ' receipt ' };

test('PKR validation uses exact integer paisa including the maximum backend amount', () => {
  assert.equal(payment.paisa('9999999999.99'), 999999999999);
  assert.equal(payment.paisa('0.01') + payment.paisa('0.02'), payment.paisa('0.03'));
  assert.equal(payment.decimalAmount(' 250.2 '), '250.20');
  assert.equal(payment.paymentMoney('749.75'), 'PKR 749.75');
  for (const value of ['-1', '1.001', 'NaN', 'Infinity', '1e3', '1,000', '', '10000000000.00']) assert.throws(() => payment.paisa(value));
});
test('full and partial payments validate all methods, positive amounts and references', () => {
  for (const method of Object.keys(payment.paymentMethods)) assert.equal(payment.validatePayment({ ...draft, method }, '250.25'), null);
  assert.equal(payment.validatePayment({ ...draft, amount: '0.01' }, '250.25'), null);
  for (const fields of [{ amount: '0' }, { amount: '-1' }, { amount: '250.26' }, { amount: '0.001' }, { method: 'card' }, { reference: 'x'.repeat(201) }])
    assert.ok(payment.validatePayment({ ...draft, ...fields }, '250.25'));
});
test('payment history validates tenant, appointment and PKR receipt identity', () => {
  assert.deepEqual(payment.verifyHistory(history(), business, appointment, 10, 0), history());
  for (const fields of [{ business_id: appointment }, { appointment_id: business }, { currency: 'USD' }, { method: 'card' }, { amount: '-1' }, { paid_at: 'bad' }]) {
    const value = history(); Object.assign(value.items[0], fields);
    assert.throws(() => payment.verifyHistory(value, business, appointment, 10, 0));
  }
});
test('history rejects inconsistent totals, duplicates and invalid pagination', () => {
  for (const fields of [{ total: -1 }, { offset: 10 }, { limit: 20 }, { items: [] }, { summary: { ...summary, balance_due: '750' } }, { summary: { ...summary, state: 'paid' } }])
    assert.throws(() => payment.verifyHistory({ ...history(), ...fields }, business, appointment, 10, 0));
  assert.throws(() => payment.verifyHistory({ ...history(), items: [receipt, receipt], total: 2 }, business, appointment, 10, 0));
  assert.equal(payment.verifyHistory({ items: [], total: 1, limit: 10, offset: 10, summary }, business, appointment, 10, 10).items.length, 0);
});
test('zero-priced and fully paid appointments have zero outstanding balance', () => {
  for (const price of ['0.00', '1000.00']) {
    const value = { ...history(), summary: { booked_price: price, total_paid: price, balance_due: '0.00', state: 'paid' } };
    assert.equal(payment.verifyHistory(value, business, appointment, 10, 0).summary.state, 'paid');
  }
});
test('authenticated history requests use real pagination and reject cancelled responses', async () => {
  let requested;
  const client = new ApiClient('http://localhost:8000', { token: () => 'memory-only', fetcher: async (url, options) => {
    requested = { url, options }; return Response.json(history());
  } });
  const ledger = new payment.PaymentLedger(client, business);
  await ledger.history(appointment, 10, 0);
  assert.ok(requested.url.endsWith(`/api/appointments/${appointment}/payments?limit=10&offset=0`));
  assert.equal(requested.options.headers.get('Authorization'), 'Bearer memory-only');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(ledger.history(appointment, 10, 0, abort.signal));
});
test('concurrent clicks coalesce into one POST and retain a stable UUID request key', async () => {
  const calls = []; let resolve;
  const ledger = new payment.PaymentLedger({ request: (path, options) => { calls.push({ path, options }); return new Promise(done => { resolve = done; }); } }, business);
  const a = ledger.submit(appointment, draft), b = ledger.submit(appointment, draft);
  assert.equal(a, b); assert.equal(calls.length, 1);
  assert.match(calls[0].options.body.idempotency_key, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  assert.equal(calls[0].options.body.reference, 'receipt');
  assert.equal('business_id' in calls[0].options.body, false);
  resolve(receipt); await a;
  await ledger.submit(appointment, draft); assert.equal(calls.length, 1);
});
test('uncertain network results keep the same payload through close/navigation and retry', async () => {
  const bodies = []; let attempt = 0;
  const ledger = new payment.PaymentLedger({ request: async (_path, options) => {
    bodies.push(structuredClone(options.body)); if (!attempt++) throw new ApiError(0, 'Network interrupted'); return receipt;
  } }, business);
  await assert.rejects(ledger.submit(appointment, draft));
  assert.throws(() => ledger.next(appointment));
  await ledger.submit(appointment, { amount: '999', method: 'jazzcash', reference: 'changed' });
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(ledger.attempt(appointment).receipt.id, receipt.id);
});
test('server failures and unverifiable successful responses preserve idempotency keys', async () => {
  for (const result of [new ApiError(503, 'Unavailable'), { ...receipt, business_id: appointment }]) {
    const ledger = new payment.PaymentLedger({ request: async () => { if (result instanceof Error) throw result; return result; } }, business);
    await assert.rejects(ledger.submit(appointment, draft));
    assert.ok(ledger.attempt(appointment).payload.idempotency_key);
    assert.equal(ledger.attempt(appointment).receipt, undefined);
    assert.equal(ledger.attempt(appointment).pending, undefined);
  }
});
test('definite validation and conflict rejections allow a corrected new request', async () => {
  for (const status of [400, 403, 404, 409, 422]) {
    const ledger = new payment.PaymentLedger({ request: async () => { throw new ApiError(status, 'Rejected'); } }, business);
    await assert.rejects(ledger.submit(appointment, draft));
    assert.equal(ledger.attempt(appointment), undefined);
  }
});
test('record another payment requires confirmed success and generates a new key', async () => {
  const keys = [];
  const ledger = new payment.PaymentLedger({ request: async (_path, options) => { keys.push(options.body.idempotency_key); return receipt; } }, business);
  await ledger.submit(appointment, draft); ledger.next(appointment); await ledger.submit(appointment, draft);
  assert.notEqual(keys[0], keys[1]);
});
test('account-scoped ledger instances never share pending or successful receipts', async () => {
  const first = new payment.PaymentLedger({ request: async () => receipt }, business);
  const second = new payment.PaymentLedger({ request: async () => { throw new Error('Not used'); } }, appointment);
  await first.submit(appointment, draft);
  assert.ok(first.attempt(appointment)); assert.equal(second.attempt(appointment), undefined);
});
