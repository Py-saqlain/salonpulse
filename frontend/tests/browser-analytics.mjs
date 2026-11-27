import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyAnalytics({ accounts, command, evaluate, wait, route, submit, logout, login, check }) {
  const tokens = [], fixtures = [];
  async function api(index, path, method = 'GET', body) {
    if (!tokens[index]) {
      const result = await fetch('http://127.0.0.1:8010/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: accounts[index].email, password: accounts[index].password }) });
      check(result.status === 200, 'Analytics fixture login'); tokens[index] = (await result.json()).access_token;
    }
    const result = await fetch('http://127.0.0.1:8010/api/' + path, { method, headers: { Authorization: 'Bearer ' + tokens[index], 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, data: result.status === 204 ? null : await result.json() };
  }
  async function post(index, path, body) { const result = await api(index, path, 'POST', body); check(result.status === 201, 'Analytics fixture ' + path); return result.data; }
  async function ready() { await wait('document.querySelector("[data-revenue-ready=true]")', 'analytics ready'); }
  async function click(text, scope = 'document') { await evaluate(`([...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)})).click()`); }
  async function refresh() { await click('Refresh directories'); await wait('document.querySelector(".directory-toolbar button")?.disabled===false', 'catalog refresh'); await ready(); }
  const money = amount => 'PKR ' + Number(amount).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function timezoneFixture(index) {
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
  b=c.scalar(select(Business.id).where(Business.name==d['business_name']));assert b and d['business_name'].startswith('__day7_browser__')
  assert c.scalar(select(User.id).where(User.business_id==b,User.email==d['email']))
  c.execute(update(Business).where(Business.id==b,Business.name==d['business_name']).values(timezone='UTC'))
finally:e.dispose()
`;
    const { business_name, email } = accounts[index];
    const result = spawnSync(resolve(backend, '.venv/Scripts/python.exe'), ['-B', '-c', code, JSON.stringify({ business_name, email })], { cwd: backend, env: { ...process.env, DEBUG: 'false', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
    check(result.status === 0, 'Guarded UTC business fixture');
  }
  async function seed(index) {
    const initial = (await api(index, 'analytics/revenue')).data;
    const customer = await post(index, 'customers', { name: 'Analytics customer ' + index });
    const staff = await post(index, 'staff', { name: 'Analytics staff ' + index, hours: Array.from({ length: 7 }, (_, day) => ({ day, start: '00:00', end: '23:59' })) });
    const service = await post(index, 'services', { name: 'Analytics service ' + index, duration_minutes: 30, price: '1000.00' });
    const start = new Date(Date.now() + 3 * 86400000); start.setUTCHours(5, 0, 0, 0);
    const count = index === 0 ? 4 : 1;
    const bookings = [];
    for (let i = 0; i < count; i++) bookings.push(await post(index, 'appointments', { customer_id: customer.id, staff_id: staff.id, service_id: service.id, starts_at: new Date(start.getTime() + i * 3600000).toISOString() }));
    const offset = index === 0 ? 5 * 3600000 : 0;
    const midnight = Date.parse(initial.date + 'T00:00Z') - offset;
    const receipts = [];
    async function pay(booking, cents, method, time) {
      await post(index, 'appointments/' + booking.id + '/payments', { amount: (cents / 100).toFixed(2), method, idempotency_key: randomUUID(), paid_at: new Date(time).toISOString() });
      receipts.push({ cents, method, time });
    }
    if (!index) {
      await pay(bookings[0], 10, 'cash', midnight);
      await pay(bookings[0], 9990, 'bank_transfer', midnight);
      await pay(bookings[0], 3125, 'jazzcash', midnight - 1);
      await pay(bookings[0], 2000, 'easypaisa', midnight - 86400000);
      await pay(bookings[0], 700, 'cash', midnight - 40 * 86400000);
      await pay(bookings[1], 100000, 'cash', midnight);
      await pay(bookings[3], 5000, 'jazzcash', midnight);
      check((await api(index, 'appointments/' + bookings[3].id, 'DELETE')).status === 204, 'Cancelled analytics fixture');
    } else await pay(bookings[0], 4275, 'jazzcash', midnight);
    fixtures[index] = { initial, offset, bookings, receipts };
  }
  async function verify(index, extra = 0) {
    await ready();
    const { initial, offset, receipts } = fixtures[index];
    const result = await api(index, 'analytics/revenue'); check(result.status === 200, 'Analytics API response');
    const data = result.data;
    for (const period of ['daily', 'weekly', 'monthly']) {
      const start = Date.parse(initial[period].start + 'T00:00Z') - offset;
      const end = Date.parse(initial[period].end_exclusive + 'T00:00Z') - offset;
      const cents = receipts.filter(r => r.time >= start && r.time < end).reduce((sum, r) => sum + r.cents, extra);
      check(data[period].collected === (cents / 100).toFixed(2), 'Exact API ' + period + ' total');
      await wait(`document.querySelector('[data-revenue="${period}"]')?.textContent===${JSON.stringify(money(data[period].collected))}`, period + ' collected UI');
    }
    const outstanding = index === 0 ? ((184175 - extra) / 100).toFixed(2) : '957.25';
    check(data.outstanding === outstanding, 'Outstanding excludes cancelled bookings');
    check(await evaluate('document.querySelector("[data-revenue=outstanding]").textContent') === money(outstanding), 'Outstanding UI');
    check(JSON.stringify(data.appointment_counts) === JSON.stringify(index === 0 ? { paid: 1, partially_paid: extra ? 2 : 1, unpaid: extra ? 0 : 1 } : { paid: 0, partially_paid: 1, unpaid: 0 }), 'Payment status counts');
    for (const item of data.method_breakdown) check(await evaluate(`document.querySelector('[data-revenue-method="${item.method}"]').textContent`) === money(item.collected), 'Method breakdown UI');
    check(data.trend.length === 30 && data.trend.reduce((sum, p) => sum + Math.round(Number(p.collected) * 100), 0) === receipts.filter(r => r.time >= Date.parse(data.trend_start + 'T00:00Z') - offset).reduce((sum, r) => sum + r.cents, extra), 'Receipt-based trend total');
    check(await evaluate('document.querySelector(".revenue-trend svg polyline").getAttribute("points").split(" ").length===30 && !/NaN|Infinity/.test(document.querySelector(".revenue-trend svg polyline").getAttribute("points"))'), 'Chart contains thirty finite points');
    check(await evaluate('document.querySelectorAll(".revenue-table tbody tr").length===30'), 'Accessible daily table');
    check(await evaluate('document.querySelector(".revenue-panel").textContent.includes(' + JSON.stringify(data.timezone) + ')'), 'Analytics business timezone');
    return data;
  }
  await route('register'); await submit(accounts[0]); await ready(); await seed(0); await refresh();
  const first = await verify(0);
  check(await evaluate('document.querySelectorAll(".kpi-value")[1].textContent') === money(first.daily.collected), 'Dashboard uses collected payments');
  // Record a real UI payment and confirm automatic analytics refresh after navigation.
  await evaluate('location.hash="appointments"');
  const id = fixtures[0].bookings[2].id;
  await wait(`document.querySelector('[data-payment-appointment="${id}"] .record-payment')`, 'unpaid appointment action');
  await evaluate(`document.querySelector('[data-payment-appointment="${id}"] .record-payment').click()`);
  await wait('document.querySelector(".payment-form") && !document.querySelector("[data-payment-dialog]").textContent.includes("Loading payments...")', 'UI collection form');
  await evaluate(`(()=>{const input=document.querySelector('[name=payment_amount]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'1.00');input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.payment-form').requestSubmit()})()`);
  await wait('document.querySelector(".payment-success")?.textContent.includes("Payment recorded.")', 'UI collection saved');
  await evaluate(`document.querySelector('[aria-label="Close payments"]').click();location.hash='dashboard'`);
  await verify(0, 100);
  await evaluate('location.hash="analytics"'); await ready(); await verify(0, 100);
  await command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await click('Refresh revenue'); await wait('!!document.querySelector(".revenue-panel [role=alert]")', 'analytics offline error');
  check(await evaluate('!document.querySelector("[data-revenue=daily]")'), 'Failed revenue is not presented as zero');
  await command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await click('Refresh revenue'); await verify(0, 100);
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  check(await evaluate('document.documentElement.scrollWidth<=innerWidth+1 && document.querySelector(".revenue-trend svg").getBoundingClientRect().width>0'), 'Mobile revenue layout');
  await command('Emulation.setDeviceMetricsOverride', { width: 1365, height: 900, deviceScaleFactor: 1, mobile: false });
  await logout(); await login(accounts[0]); await verify(0, 100);
  await logout(); await route('register'); await submit(accounts[1]); await ready(); timezoneFixture(1);
  await logout(); await login(accounts[1]); await ready(); await seed(1); await refresh(); await verify(1);
  check((await api(1, 'analytics/revenue?business_id=' + first.business_id)).status === 422, 'Tenant override rejected');
  check((await api(1, 'appointments/' + fixtures[0].bookings[0].id + '/payments')).status === 404, 'Foreign payment details inaccessible');
  await logout(); await login(accounts[0]); await verify(0, 100); await logout();
}
