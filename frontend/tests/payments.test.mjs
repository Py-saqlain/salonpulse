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
  const ledger = new payment.PaymentLedger(client, business, { user: '44444444-4444-4444-8444-444444444444', role:'owner', active:()=>true, storage:()=>localStorage, locks:()=>undefined });
  await ledger.history(appointment, 10, 0);
  assert.ok(requested.url.endsWith(`/api/appointments/${appointment}/payments?limit=10&offset=0`));
  assert.equal(requested.options.headers.get('Authorization'), 'Bearer memory-only');
  const abort = new AbortController(); abort.abort();
  await assert.rejects(ledger.history(appointment, 10, 0, abort.signal));
});
// A serialized in-memory server models durable intent transitions, not browser payload storage.
const user = '44444444-4444-4444-8444-444444444444';
function fixture() {
  const store = new Map(), intents = new Map(), calls = []; let paid = 0, fail = '', active = true;
  let queue = Promise.resolve();
  const locks = { request(_name, action) { const next = queue.then(action); queue = next.catch(() => {}); return next; } };
  const options = { user, role: 'owner', storage: () => ({ getItem: k => store.get(k) ?? null, setItem: (k,v) => store.set(k,v) }), locks: () => locks, active: () => active };
  const api = { async request(path, options = {}) {
    calls.push({ path, options: structuredClone(options) });
    if (fail === 'before') { fail = ''; throw new ApiError(503, 'Unavailable'); }
    const parts = path.split('/'), action = parts.at(-1);
    const totals = () => ({ booked_price: '1000.00', total_paid: (paid / 100).toFixed(2), balance_due: ((100000-paid)/100).toFixed(2), state: paid === 100000 ? 'paid' : paid ? 'partially_paid' : 'unpaid' });
    const result = value => value ? { ...structuredClone(value), summary: totals(), payload: value.state === 'pending' ? structuredClone(value.payload) : null } : null;
    if (action === 'active') return result([...intents.values()].find(v => !v.resolved));
    if (action === 'payment-intents') {
      const body = options.body;
      if ([...intents.values()].some(v => !v.resolved)) throw new ApiError(409,'Reconcile first');
      if (intents.has(body.idempotency_key)) throw new ApiError(409,'Closed');
      const value = { intent_id: body.idempotency_key, business_id: business, user_id: user, appointment_id: appointment, state: 'pending', resolved: false, payload: body };
      intents.set(value.intent_id,value);
      if (fail === 'create') { fail = ''; throw new ApiError(0,'Lost response'); }
      return result(value);
    }
    const id = parts.at(-2); let value = intents.get(id);
    if (!value && action === 'reconcile') { value = { intent_id:id,business_id:business,user_id:user,appointment_id:appointment,state:'cancelled',resolved:true,payload:null }; intents.set(id,value); }
    if (!value) throw new ApiError(404,'Missing');
    if (action === 'confirm' && value.state === 'pending') { paid += payment.paisa(value.payload.amount); value.state = 'recorded'; }
    if (action === 'cancel' && value.state === 'pending') { value.state = 'cancelled'; value.resolved = true; }
    if (action === 'acknowledge') { if (value.state === 'pending') throw new ApiError(409,'Pending'); value.resolved = true; }
    if (fail === 'confirm' && action === 'confirm') { fail=''; throw new ApiError(0,'Lost response'); }
    return result(value);
  } };
  const ledger = (overrides={}) => new payment.PaymentLedger(api,business,{ ...options,...overrides });
  return { ledger, options, store, intents, calls, fail: value => { fail=value; }, end: () => { active=false; }, paid: () => paid };
}

test('concurrent clicks coalesce into one intent and confirmation', async () => {
  const f=fixture(), ledger=f.ledger(); const a=ledger.submit(appointment,draft),b=ledger.submit(appointment,draft);
  assert.equal(a,b); assert.equal((await a).state,'recorded');
  assert.equal(f.intents.size,1); assert.equal(f.paid(),25025);
  await ledger.submit(appointment,draft); assert.equal(f.paid(),25025);
});
test('lost confirmation recovers after refresh and re-login without another payment', async () => {
  const f=fixture(); f.fail('confirm'); await assert.rejects(f.ledger().submit(appointment,draft));
  const restored=f.ledger(); assert.equal((await restored.recover(appointment)).state,'recorded');
  await restored.submit(appointment,{...draft,amount:'999'}); assert.equal(f.paid(),25025);
  const [[key,value]]=f.store; assert.ok(key.includes(business+':'+user+':'+appointment));
  assert.deepEqual(Object.keys(JSON.parse(value)),['intent_id']); assert.equal(value.includes('250.25'),false); assert.equal(value.includes('receipt'),false);
});
test('lost intent creation resumes frozen server payload despite changed inputs', async () => {
  const f=fixture(); f.fail('create'); await assert.rejects(f.ledger().submit(appointment,draft));
  const restored=f.ledger(); const value=await restored.recover(appointment); assert.equal(value.payload.reference,'receipt');
  await assert.rejects(restored.next(appointment));
  await restored.submit(appointment,{amount:'999',method:'jazzcash',reference:'changed'}); assert.equal(f.paid(),25025);
});
test('server unavailable or unverifiable outcomes preserve recovery identifiers', async () => {
  const f=fixture(); f.fail('create'); await assert.rejects(f.ledger().submit(appointment,draft));
  const pointer=[...f.store.values()][0]; f.fail('before'); await assert.rejects(f.ledger().recover(appointment));
  assert.equal([...f.store.values()][0],pointer); assert.equal(f.paid(),0);
  await f.ledger().submit(appointment,draft); assert.equal(f.paid(),25025);
});
test('unknown nonce is closed before a new corrected request can be started', async () => {
  const f=fixture(), ledger=f.ledger(); const id=crypto.randomUUID(); f.store.set(ledger.key(appointment),JSON.stringify({intent_id:id}));
  assert.equal((await ledger.recover(appointment)).state,'cancelled');
  await ledger.submit(appointment,draft); assert.equal(f.paid(),0);
  await ledger.next(appointment); await ledger.submit(appointment,draft); assert.equal(f.paid(),25025);
});
test('record another requires explicit acknowledgement and a new request key', async () => {
  const f=fixture(), ledger=f.ledger(); await ledger.submit(appointment,draft); const key=[...f.intents.keys()][0];
  await ledger.next(appointment); await ledger.submit(appointment,draft); assert.equal(f.paid(),50050);
  assert.equal(f.intents.size,2); assert.notEqual([...f.intents.keys()][1],key);
});
test('two tabs serialize retries and do not duplicate a lost payment', async () => {
  const f=fixture(); f.fail('confirm'); await assert.rejects(f.ledger().submit(appointment,draft));
  const results=await Promise.all([f.ledger().submit(appointment,draft),f.ledger().submit(appointment,draft)]);
  assert.ok(results.every(v=>v.state==='recorded')); assert.equal(f.paid(),25025);
});
test('pending cancellation is reconciled without charging and permits a new payment', async () => {
  const f=fixture();f.fail('create');const ledger=f.ledger();await assert.rejects(ledger.submit(appointment,draft));
  assert.equal(await ledger.cancel(appointment),null); assert.equal(f.paid(),0);
  await ledger.submit(appointment,draft); assert.equal(f.paid(),25025);
});
test('storage loss discovers unresolved server intents before allowing new submission', async () => {
  const f=fixture(); f.fail('confirm');await assert.rejects(f.ledger().submit(appointment,draft));f.store.clear();
  assert.equal((await f.ledger().recover(appointment)).state,'recorded');assert.equal(f.paid(),25025);
});
test('account scope isolates pointers and an ended session cannot continue', async () => {
  const f=fixture(), first=f.ledger(), second=f.ledger({user:appointment});
  assert.notEqual(first.key(appointment),second.key(appointment));
  f.end(); assert.throws(()=>first.submit(appointment,draft),/session/);assert.equal(f.calls.length,0);
});
test('missing locks, unavailable storage and malformed metadata fail closed', async () => {
  const f=fixture();await assert.rejects(f.ledger({locks:()=>undefined}).submit(appointment,draft),/Web Locks/);
  await assert.rejects(f.ledger({storage:()=>{throw new Error('Denied');}}).submit(appointment,draft),/storage/);
  const ledger=f.ledger();f.store.set(ledger.key(appointment),JSON.stringify({intent_id:crypto.randomUUID(),amount:'5'}));
  await assert.rejects(ledger.submit(appointment,draft),/storage/);assert.equal(f.paid(),0);
});
test('staff can fetch balances but history is rejected without making a request', async () => {
  const f=fixture();await assert.rejects(f.ledger({role:'staff'}).history(appointment),/Only owners/);assert.equal(f.calls.length,0);
});

test('unverifiable recovery identities cannot enable a new submission', async () => {
  for (const fields of [{business_id:appointment},{user_id:appointment},{appointment_id:business},{intent_id:'invalid'}, {payload:null}]) {
    const f=fixture();f.fail('create');await assert.rejects(f.ledger().submit(appointment,draft));
    const value=[...f.intents.values()][0];Object.assign(value,fields);
    await assert.rejects(f.ledger().submit(appointment,draft));assert.equal(f.paid(),0);
  }
});
test('a failed recovery pointer write prevents intent creation', async () => {
  const f=fixture();await assert.rejects(f.ledger({storage:()=>({getItem:()=>null,setItem:()=>{throw new Error('Full');}})}).submit(appointment,draft),/could not be saved/);
  assert.equal(f.intents.size,0);assert.equal(f.paid(),0);
});
test('session loss during reconciliation prevents continuation under a new account', async () => {
  const f=fixture(); f.fail('create');await assert.rejects(f.ledger().submit(appointment,draft));
  const ledger=f.ledger();const pending=ledger.recover(appointment);f.end();await assert.rejects(pending,/session/);assert.equal(f.paid(),0);
});

test('a late response from an old session cannot issue requests or log out the new account', async () => {
  for (const rejected of [false,true]) {
    let active=true,release,calls=0,logouts=0;
    const api={request:()=>{calls++;return new Promise((resolve,reject)=>{release=()=>rejected?reject(new ApiError(403,'Forbidden')):resolve(null);});}};
    const ledger=new payment.PaymentLedger(api,business,{user,role:'owner',storage:()=>({getItem:()=>null,setItem:()=>{}}),locks:()=>({request:(_key,action)=>action()}),active:()=>active,forbidden:()=>logouts++});
    const pending=ledger.submit(appointment,draft);active=false;release();await assert.rejects(pending);
    assert.equal(calls,1);assert.equal(logouts,0);
  }
});
