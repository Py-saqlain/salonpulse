// Real payment UI checks. The shared browser harness owns and cleans both tenants.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyPayments({ accounts, command, evaluate, wait, route, submit, logout, login, check, setInterceptor }) {
  const tokens = [];
  async function api(index, path, method = 'GET', body) {
    if (!tokens[index]) {
      const result = await fetch('http://127.0.0.1:8010/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: accounts[index].email, password: accounts[index].password }) });
      check(result.status === 200, 'Payment fixture login'); tokens[index] = (await result.json()).access_token;
    }
    const result = await fetch('http://127.0.0.1:8010/api/' + path, { method, headers: { Authorization: 'Bearer ' + tokens[index], 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, data: result.status === 204 ? null : await result.json() };
  }
  async function post(index, resource, body) { const result = await api(index, resource, 'POST', body); check(result.status === 201, resource + ' payment fixture'); return result.data; }
  async function click(text, scope = 'document') {
    await wait(`!![...(${scope}?.querySelectorAll('button') ?? [])].find(b=>b.textContent.trim()===${JSON.stringify(text)} && !b.disabled)`, 'ready payment action: ' + text);
    await evaluate(`([...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})).click()`);
    if (text === 'Record another payment' || text === 'Start new payment') await wait('!!document.querySelector(".payment-form") && !document.querySelector("[name=payment_amount]").matches(":disabled")', 'new payment form ready');
  }
  async function set(selector, value) {
    await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});const prototype=input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  }
  async function ready() { await wait('!!document.querySelector(".app-shell") && document.querySelector(".directory-toolbar button")?.disabled===false', 'payment workspace'); }
  async function refresh() { await click('Refresh directories'); await ready(); }
  async function appointments() { await evaluate('location.hash="appointments"'); await ready(); await wait('!!document.querySelector(".appointments-page")', 'payment appointment page'); }
  const row = id => `document.querySelector('[data-payment-appointment="${id}"]')`;
  const dialog = 'document.querySelector("[data-payment-dialog]")';
  async function open(id, record = true) {
    await appointments(); await wait(`${row(id)}?.querySelector('.payment-status')`, 'row payment balance');
    const label = record ? 'Record payment' : await evaluate(`${row(id)}.textContent.includes('Payment history') ? 'Payment history' : 'Balance and recovery'`);
    await click(label, row(id));
    await wait('!!document.querySelector("[data-payment-dialog][open]") && !document.querySelector("[data-payment-dialog]").textContent.includes("Loading payments...")', 'payment dialog');
    if (record && await evaluate('[...document.querySelectorAll("[data-payment-dialog] button")].some(b=>b.textContent==="Record another payment" && !b.disabled)')) await click('Record another payment', dialog);
  }
  async function close() { await evaluate(`document.querySelector('[aria-label="Close payments"]').click()`); await wait('!document.querySelector("[data-payment-dialog]")', 'close payments'); }
  async function totals(paid, due, state) {
    await wait(`document.querySelector('[data-payment-dialog] [data-payment-total="paid"]')?.textContent===${JSON.stringify('PKR ' + paid)} && document.querySelector('[data-payment-dialog] [data-payment-total="due"]')?.textContent===${JSON.stringify('PKR ' + due)} && !document.querySelector('[data-payment-dialog]').textContent.includes('Loading payments...')`, 'accurate payment balance');
    check(await evaluate(`document.querySelector('[data-payment-dialog] .payment-status').textContent===${JSON.stringify(state)}`), 'Payment status mismatch');
  }
  async function save(amount, method, reference = '') {
    await set('[name=payment_amount]', amount); await set('[name=payment_method]', method); await set('[name=payment_reference]', reference);
    await evaluate('document.querySelector(".payment-form").requestSubmit()');
    await wait('document.querySelector("[data-payment-dialog] .payment-success")?.textContent.includes("Payment recorded.") && !document.querySelector("[data-payment-dialog]").textContent.includes("Loading payments...")', 'payment saved');
  }
  const payloads = [], bookings = [];
  const start = new Date(Date.now() + 3 * 86400000); start.setUTCHours(5, 0, 0, 0);
  async function seed(index) {
    const customer = await post(index, 'customers', { name: 'Payment customer ' + index });
    const staff = await post(index, 'staff', { name: 'Payment staff ' + index, hours: Array.from({ length: 7 }, (_, day) => ({ day, start: '00:00', end: '23:59' })) });
    const service = await post(index, 'services', { name: 'Payment service ' + index, duration_minutes: 30, price: '1000.00' });
    payloads[index] = { customer_id: customer.id, staff_id: staff.id, service_id: service.id, starts_at: start.toISOString() };
    bookings[index] = await post(index, 'appointments', payloads[index]);
  }
  async function serverHistory(id, index = 0) { const result = await api(index, 'appointments/' + id + '/payments'); check(result.status === 200, 'Persisted payment history'); return result.data; }
  function promoteToStaff() {
    const backend = fileURLToPath(new URL('../../backend/', import.meta.url));
    const code = `
import json,sys,os
from sqlalchemy import create_engine,select,update
from sqlalchemy.engine import make_url
from app.core.config import Settings
from app.models import Business,User
d=json.loads(sys.argv[1]);u=make_url(Settings().database_url.get_secret_value())
assert u.database=='salonpulse_dev' and u.username=='salonpulse_app' and u.host in ('localhost','127.0.0.1','::1') and u.port==5432
sys.path.insert(0,'tests')
from isolated_db import test_engine
e=test_engine(os.environ['SALONPULSE_TEST_SCHEMA'])
try:
 with e.begin() as c:
  business=c.scalar(select(Business.id).where(Business.name==d['business_name']));assert business is not None and d['business_name'].startswith('__day7_browser__')
  user=c.scalar(select(User.id).where(User.email==d['email'],User.business_id==business));assert user is not None
  c.execute(update(User).where(User.id==user,User.business_id==business).values(role='staff'))
finally:e.dispose()
`;
    const { business_name, email } = accounts[0];
    const result = spawnSync(resolve(backend, '.venv/Scripts/python.exe'), ['-B', '-c', code, JSON.stringify({ business_name, email })], { cwd: backend, env: { ...process.env, DEBUG: 'false', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
    check(result.status === 0, 'Guarded temporary staff role setup');
  }

  await route('register'); await submit(accounts[0]); await ready(); await seed(0); await refresh();
  await open(bookings[0].id); await totals('0.00', '1,000.00', 'Unpaid');
  check(await evaluate('document.querySelector("[data-payment-total=price]").textContent==="PKR 1,000.00"'), 'Booked price missing');
  for (const value of ['0', '-1', '0.001', '1000.01']) {
    await set('[name=payment_amount]', value); await evaluate('document.querySelector(".payment-form").requestSubmit()');
    await wait('!!document.querySelector(".payment-form [role=alert]")', 'payment inline validation');
  }
  await save('100.25', 'cash', 'Cash reference'); await totals('100.25', '899.75', 'Partially paid');
  check(await evaluate('document.querySelector(".payment-history").textContent.includes("Cash reference")'), 'Payment reference missing');
  await click('Record another payment', dialog); await save('200.25', 'bank_transfer', 'Bank reference'); await totals('300.50', '699.50', 'Partially paid');
  await click('Record another payment', dialog);
  // Keep drafts and feedback intact on focus refresh while the editor is open.
  await set('[name=payment_amount]', '50.00'); await set('[name=payment_method]', 'jazzcash'); await set('[name=payment_reference]', 'Jazz retry');
  await evaluate('window.dispatchEvent(new Event("focus"))');
  check(await evaluate('document.querySelector("[name=payment_reference]").value==="Jazz retry"'), 'Focus lost payment draft');
  // Drop only a committed POST response, then retry the same real API request.
  let dropped = false;
  setInterceptor(async params => {
    if (!dropped && params.request.method === 'POST' && params.responseStatusCode === 200 && params.request.url.endsWith('/confirm')) {
      dropped = true; await command('Fetch.failRequest', { requestId: params.requestId, errorReason: 'ConnectionClosed' });
    } else await command('Fetch.continueRequest', { requestId: params.requestId });
  });
  await command('Fetch.enable', { patterns: [{ urlPattern: '*8010/api/appointments/*/payment-intents/*/confirm', requestStage: 'Response' }] });
  await evaluate('document.querySelector(".payment-form").requestSubmit();document.querySelector(".payment-form").requestSubmit()');
  await wait('document.querySelector("[data-payment-dialog]").textContent.includes("Payment recorded.") && !document.querySelector("[data-payment-dialog]").textContent.includes("Loading payments...")', 'automatic lost-response reconciliation');
  await command('Fetch.disable'); setInterceptor(null);
  check(dropped, 'Committed response was not intercepted');
  check((await serverHistory(bookings[0].id)).total === 3, 'Duplicate submit produced extra receipt');
  const recoveryKey = await evaluate(`Object.keys(localStorage).find(k=>k.startsWith('salonpulse.payment-recovery.v1:') && k.endsWith(':${bookings[0].id}'))`);
  check(!!recoveryKey, 'Persistent recovery pointer missing');
  const pointer = await evaluate(`localStorage.getItem(${JSON.stringify(recoveryKey)})`);
  check(Object.keys(JSON.parse(pointer)).join(',') === 'intent_id', 'Sensitive payment data persisted');
  // A fresh document loses the in-memory JWT and ledger. Login must reconcile the prior receipt.
  await close(); await command('Page.navigate', { url: 'http://127.0.0.1:5174/?recovery=' + randomUUID() + '#appointments' });
  await wait('!!document.querySelector(".auth-form")','refresh requires reauthentication');
  await login(accounts[0]); await open(bookings[0].id, false);
  await wait('document.querySelector("[data-payment-dialog]").textContent.includes("Payment recorded.")','persistent payment recovery');
  await totals('350.50', '649.50', 'Partially paid');
  check((await serverHistory(bookings[0].id)).total === 3, 'Refresh recovery charged twice');
  await click('Record another payment', dialog); await save('149.50', 'easypaisa', 'Easy reference'); await totals('500.00', '500.00', 'Partially paid');
  await close();
  const activeIntent = await api(0, 'appointments/' + bookings[0].id + '/payment-intents/active');
  if (activeIntent.data) check((await api(0, 'appointments/' + bookings[0].id + '/payment-intents/' + activeIntent.data.intent_id + '/acknowledge', 'POST')).status === 200, 'Acknowledge fixture outcome');
  for (let i = 0; i < 8; i++) await post(0, 'appointments/' + bookings[0].id + '/payments', { amount: '10.00', method: 'cash', idempotency_key: randomUUID(), reference: 'History receipt ' + i });
  await open(bookings[0].id); await totals('580.00', '420.00', 'Partially paid');
  check(await evaluate('document.querySelectorAll(".payment-receipt").length===10'), 'History first-page size');
  await click('Next', `document.querySelector('[aria-label="Payment history pagination"]')`);
  await wait('document.querySelectorAll(".payment-receipt").length===2 && !document.querySelector("[data-payment-dialog]").textContent.includes("Loading payments...")', 'history next page');
  check(await evaluate('document.querySelector(".payment-history").textContent.includes("Bank reference") && document.querySelector(".payment-history").textContent.includes("Cash reference")'), 'Older receipts missing from second page');
  await command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await click('Refresh payments', dialog); await wait('!!document.querySelector("[data-payment-dialog] [role=alert]")', 'history network failure');
  await command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await click('Refresh payments', dialog); await totals('580.00', '420.00', 'Partially paid');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  check(await evaluate('document.querySelector("[data-payment-dialog]").scrollWidth<=document.querySelector("[data-payment-dialog]").clientWidth+1 && document.documentElement.scrollWidth<=innerWidth+1'), 'Mobile payment overflow');
  if (await evaluate('[...document.querySelectorAll("[data-payment-dialog] button")].some(b=>b.textContent==="Record another payment")')) { await click('Record another payment', dialog); await wait('!!document.querySelector(".payment-form") && !document.querySelector("[name=payment_amount]").matches(":disabled")','new payment ready'); }
  await save('420.00', 'cash'); await totals('1,000.00', '0.00', 'Paid'); await close();
  check(await evaluate(`${row(bookings[0].id)}.textContent.includes('Paid') && !${row(bookings[0].id)}.querySelector('.record-payment')`), 'Paid appointment still offers record action');
  await command('Emulation.setDeviceMetricsOverride', { width: 1365, height: 900, deviceScaleFactor: 1, mobile: false });
  // A competing write changes the balance after the owner opens a form.
  const conflict = await post(0, 'appointments', { ...payloads[0], starts_at: new Date(start.getTime() + 3600000).toISOString() });
  await refresh(); await open(conflict.id);
  await post(0, 'appointments/' + conflict.id + '/payments', { amount: '750.00', method: 'cash', idempotency_key: randomUUID() });
  await set('[name=payment_amount]', '500.00'); await evaluate('document.querySelector(".payment-form").requestSubmit()');
  await wait('document.querySelector("[data-payment-dialog] [role=alert]")?.textContent.includes("exceeds")', 'stale balance conflict');
  await totals('750.00', '250.00', 'Partially paid');
  check(await evaluate('document.querySelector("[name=payment_amount]").value==="500.00"'), 'Conflict discarded draft');
  await click('Start new payment', dialog); await wait('!!document.querySelector(".payment-form") && !document.querySelector("[name=payment_amount]").matches(":disabled")','corrected payment ready');
  await save('250.00', 'cash'); await totals('1,000.00', '0.00', 'Paid'); await close();
  const cancelled = await post(0, 'appointments', { ...payloads[0], starts_at: new Date(start.getTime() + 7200000).toISOString() });
  check((await api(0, 'appointments/' + cancelled.id, 'DELETE')).status === 204, 'Cancel fixture'); await refresh();
  await wait(`${row(cancelled.id)}?.querySelector('.payment-status')`, 'cancelled balance');
  check(await evaluate(`!${row(cancelled.id)}.querySelector('.record-payment')`), 'Cancelled appointment offers payment action');
  await open(cancelled.id, false);
  check(await evaluate('!document.querySelector(".payment-form") && document.querySelector("[data-payment-dialog]").textContent.includes("cancelled")'), 'Cancelled payment form exposed'); await close();
  // Recover a server-side pending request after losing both session and browser pointer.
  const recoveredBooking = await post(0, 'appointments', { ...payloads[0], starts_at: new Date(start.getTime() + 14400000).toISOString() });
  const pendingData = { amount:'225.50', method:'jazzcash', reference:'Recovered server-only reference', idempotency_key:randomUUID() };
  await post(0,'appointments/' + recoveredBooking.id + '/payment-intents',pendingData);
  await logout(); await login(accounts[0]); await refresh(); await open(recoveredBooking.id);
  check(await evaluate('document.querySelector("[name=payment_amount]").value === "225.50" && document.querySelector("[name=payment_amount]").matches(":disabled")'), 'Server pending recovery lost frozen details');
  await click('Confirm previous payment',dialog); await totals('225.50','774.50','Partially paid');
  check((await serverHistory(recoveredBooking.id)).total===1,'Recovered pending request duplicated');
  await click('Record another payment',dialog); await close();
  const secondIntent = await post(0,'appointments/' + recoveredBooking.id + '/payment-intents',{amount:'100',method:'cash',idempotency_key:randomUUID()});
  const concurrentResults=await Promise.all([0,1].map(()=>api(0,'appointments/' + recoveredBooking.id + '/payment-intents/' + secondIntent.intent_id + '/confirm','POST')));
  check(concurrentResults.every(r=>r.status===200 && r.data.state==='recorded'),'Concurrent recovery confirmation failed');
  check((await serverHistory(recoveredBooking.id)).total===2,'Concurrent recovery charged more than once');
  await open(recoveredBooking.id,false); await totals('325.50','674.50','Partially paid'); await click('Record another payment',dialog); await close();
  const cancelledIntent=await post(0,'appointments/' + recoveredBooking.id + '/payment-intents',{amount:'50',method:'cash',idempotency_key:randomUUID()});
  await open(recoveredBooking.id,false); await click('Cancel pending request',dialog);
  await wait('!!document.querySelector(".payment-form") && !document.querySelector("[name=payment_amount]").matches(":disabled")','cancelled pending recovery');
  check((await serverHistory(recoveredBooking.id)).total===2,'Cancelled intent charged');
  check((await api(0,'appointments/' + recoveredBooking.id + '/payment-intents/' + cancelledIntent.intent_id + '/confirm','POST')).status===409,'Cancelled intent confirmed later');
  await close();
  await logout(); await login(accounts[0]); await open(bookings[0].id, false); await totals('1,000.00', '0.00', 'Paid'); await close();
  await logout(); await route('register'); await submit(accounts[1]); await ready(); await seed(1); await refresh(); await open(bookings[1].id);
  await totals('0.00', '1,000.00', 'Unpaid');
  check(await evaluate('!document.querySelector("[data-payment-dialog]").textContent.includes("Cash reference") && !document.querySelector("[data-payment-dialog]").textContent.includes("Jazz retry")'), 'Previous tenant payment leaked');
  check((await api(1, 'appointments/' + bookings[0].id + '/payments')).status === 404, 'Foreign payment history exposed');
  check((await api(1, 'appointments/' + bookings[0].id + '/payments', 'POST', { amount: '1', method: 'cash', idempotency_key: randomUUID() })).status === 404, 'Foreign payment accepted');
  await save('1000.00', 'bank_transfer', 'Business B only'); await totals('1,000.00', '0.00', 'Paid'); await close();
  await logout(); promoteToStaff(); await login(accounts[0]); await appointments();
  const staffBooking = await post(0, 'appointments', { ...payloads[0], starts_at: new Date(start.getTime() + 10800000).toISOString() });
  await refresh(); await open(staffBooking.id); await save('1000.00', 'cash', 'Staff receipt'); await totals('1,000.00', '0.00', 'Paid'); await close();
  check((await api(0,'appointments/' + bookings[0].id + '/payments')).status === 403, 'Staff history permission');
  check((await api(0,'analytics/revenue')).status === 403, 'Staff analytics permission');
  check((await api(0,'appointments/' + bookings[0].id + '/payment-summary')).data.total_paid === '1000.00', 'Staff necessary balance');
  check(await evaluate('!Array.from(document.links).some(a=>a.hash==="#analytics") && !document.querySelector(".payment-history")'), 'Staff financial UI exposed');
  check((await serverHistory(bookings[1].id, 1)).summary.total_paid === '1000.00', 'Second tenant totals changed');
  await logout();
}
