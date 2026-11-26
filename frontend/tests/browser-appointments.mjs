// Opt-in: node tests/browser-auth.mjs --appointments. The shared harness owns
// both temporary businesses and guarantees scoped database cleanup on failure.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function verifyAppointments({ accounts, command, evaluate, wait, route, submit, logout, login, check, socket, cdpOrigin }) {
  socket.addEventListener('message', event => {
    if (JSON.parse(event.data).method === 'Page.javascriptDialogOpening') void command('Page.handleJavaScriptDialog', { accept: true });
  });
  const tokens = [];
  async function api(index, path, method = 'GET', body) {
    if (!tokens[index]) {
      const result = await fetch('http://127.0.0.1:8000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: accounts[index].email, password: accounts[index].password }) });
      check(result.status === 200, 'Fixture login'); tokens[index] = (await result.json()).access_token;
    }
    const result = await fetch('http://127.0.0.1:8000/api/' + path, { method, headers: { Authorization: 'Bearer ' + tokens[index], 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: result.status, data: result.status === 204 ? null : await result.json() };
  }
  async function post(index, resource, body) { const result = await api(index, resource, 'POST', body); check(result.status === 201, resource + ' fixture creation'); return result.data; }
  async function get(id) { const result = await api(0, 'appointments/' + id); check(result.status === 200, 'Read persisted booking'); return result.data; }
  async function ready(run = evaluate) { await until(run, '!!document.querySelector(".app-shell") && document.querySelector(".directory-toolbar button")?.disabled===false', 'business records'); }
  async function until(run, expression, label) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { if (await run(expression)) return; } catch (error) { if (!error.navigationContextUnavailable) throw error; }
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error('Appointment browser timeout: ' + label);
  }
  async function click(label, scope = 'document', run = evaluate) { await run(`([...${scope}.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(label)})).click()`); }
  async function set(selector, value, run = evaluate) {
    await run(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});const prototype=input instanceof HTMLSelectElement?HTMLSelectElement.prototype:input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  }
  async function refresh() { await click('Refresh directories'); await ready(); }
  async function appointments() { await evaluate('location.hash="appointments"'); await ready(); await wait('!!document.querySelector(".appointments-page")', 'appointments page'); }
  const article = id => `document.querySelector('[data-appointment-id="${id}"]')`;
  async function edit(id) { await appointments(); await click('Edit', article(id)); await wait('!!document.querySelector("dialog[open]")', 'edit form'); }
  async function close() { await evaluate('document.querySelector("dialog .icon-button").click()'); await wait('!document.querySelector("dialog")', 'close form'); }
  async function save(run = evaluate) { await run('document.querySelector("dialog form:not([hidden])").requestSubmit()'); }
  async function saved() { await wait('!document.querySelector("dialog")', 'booking saved'); await ready(); }
  const future = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const hours = Array.from({ length: 7 }, (_, day) => ({ day, start: '09:00', end: '18:00' }));
  const allHours = hours.map(day => ({ ...day, start: '00:00', end: '23:59' }));
  async function resources(index, letter) {
    return {
      customer: await post(index, 'customers', { name: 'Booking customer ' + letter }),
      staff: await post(index, 'staff', { name: 'Booking barber ' + letter, hours }),
      service: await post(index, 'services', { name: 'Booking haircut ' + letter, duration_minutes: 30, price: '1500.50' }),
    };
  }
  async function form(records, time = '10:00', run = evaluate) {
    await ready(run); await click('New appointment', 'document', run);
    await until(run, '!!document.querySelector("dialog[open]")', 'booking form');
    await set('dialog select:nth-of-type(1)', records.customer.id, run);
    // Selects are nested in labels; target by their order in the booking form.
    await run(`(()=>{const selects=document.querySelectorAll('dialog form:not([hidden]) select');for(const [index,value] of [[0,${JSON.stringify(records.customer.id)}],[1,${JSON.stringify(records.service.id)}],[2,${JSON.stringify(records.staff.id)}]]){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(selects[index],value);selects[index].dispatchEvent(new Event('change',{bubbles:true}));}})()`);
    await set('dialog input[type=date]', future, run); await set('dialog input[type=time]', time, run);
  }
  async function secondTab() {
    const page = await (await fetch(cdpOrigin + '/json/new?about:blank', { method: 'PUT' })).json();
    const connection = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { connection.onopen = resolve; connection.onerror = reject; });
    let next = 0; const requests = new Map();
    connection.onmessage = event => { const data = JSON.parse(event.data); if (!data.id) return; const request = requests.get(data.id); if (!request) return; requests.delete(data.id); clearTimeout(request.timer); if (data.error) { const error = new Error('Secondary Chrome command failed'); error.navigationContextUnavailable = data.error.code === -32000; request.reject(error); } else request.resolve(data.result); };
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; const timer = setTimeout(() => { requests.delete(id); reject(new Error('Secondary Chrome timeout')); }, 20000); requests.set(id, { resolve, reject, timer }); connection.send(JSON.stringify({ id, method, params })); });
    const run = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error('Secondary browser evaluation failed'); return result.result.value; };
    const shutdown = async () => { connection.close(); for (const request of requests.values()) clearTimeout(request.timer); await fetch(cdpOrigin + '/json/close/' + page.id); };
    try {
      await send('Runtime.enable'); await send('Page.enable'); await send('Page.navigate', { url: 'http://127.0.0.1:5173/#login' });
      await until(run, '!!document.querySelector(".auth-form")', 'secondary login');
      await set('input[name=email]', accounts[0].email, run); await set('input[name=password]', accounts[0].password, run);
      await run('document.querySelector(".auth-form").requestSubmit()'); await ready(run);
      await run('location.hash="appointments"'); await until(run, '!!document.querySelector(".appointments-page")', 'secondary schedule');
      return { run, shutdown };
    } catch (error) { await shutdown(); throw error; }
  }

  await route('register'); await submit(accounts[0]); await wait('!!document.querySelector(".app-shell")', 'first business'); await ready();
  const a = await resources(0, 'A');
  const walkStaff = await post(0, 'staff', { name: 'Walk-in barber', hours: allHours });
  const short = await post(0, 'services', { name: 'Quick service', duration_minutes: 1, price: '100.00' });
  await refresh(); await appointments(); await form(a);
  const secondary = await secondTab();
  try {
    await form(a, '10:00', secondary.run);
    await Promise.all([save(), save(secondary.run)]);
    const deadline = Date.now() + 20000; let race;
    while (Date.now() < deadline) {
      race = await Promise.all([evaluate('({open:!!document.querySelector("dialog"),error:document.querySelector("dialog [role=alert]")?.textContent})'), secondary.run('({open:!!document.querySelector("dialog"),error:document.querySelector("dialog [role=alert]")?.textContent})')]);
      if (race.filter(item => !item.open).length === 1 && race.some(item => item.error?.includes('overlapping'))) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    check(race.filter(item => !item.open).length === 1 && race.some(item => item.error?.includes('overlapping')), 'Concurrent browser bookings must produce one conflict');
    if (race[0].open) { await evaluate('window.dispatchEvent(new Event("focus"))'); check(await evaluate('document.querySelector("dialog [role=alert]").textContent.includes("overlapping")'), 'Conflict feedback preserved'); await close(); }
  } finally { await secondary.shutdown(); }
  await refresh();
  const initial = await api(0, 'appointments'); check(initial.data.total === 1, 'Only one concurrent booking persisted');
  const first = initial.data.items[0]; check(first.starts_at.startsWith(future + 'T05:00') && first.booked_price === '1500.50' && first.booked_duration_minutes === 30, 'UTC and snapshot contract');
  check((await api(0, 'services/' + a.service.id, 'PATCH', { price: '2500.00', duration_minutes: 45 })).status === 200, 'Catalog change');
  await refresh(); await edit(first.id); await set('dialog input[type=time]', '11:00'); await save(); await saved();
  const preserved = await get(first.id); check(preserved.booked_price === '1500.50' && preserved.booked_duration_minutes === 30, 'Reschedule retained snapshots');
  await edit(first.id); await evaluate('document.querySelector(".booking-terms input").click()'); await save(); await saved();
  const recalculated = await get(first.id); check(recalculated.booked_price === '2500.00' && recalculated.booked_duration_minutes === 45, 'Explicit recalculation');
  await form(a, '18:00'); await save(); await wait('document.querySelector("dialog [role=alert]")?.textContent.includes("entire service")', 'shift-end validation');
  await set('dialog input[type=time]', '12:00');
  const draft = await evaluate('document.querySelector("dialog input[type=time]").value');
  await evaluate('document.querySelector(".directory-toolbar button").click()'); await ready();
  check(await evaluate('document.querySelector("dialog input[type=time]").value') === draft, 'Manual refresh preserved booking draft'); await close();
  await click('Cancel appointment', article(first.id)); await ready(); await wait(`${article(first.id)}?.textContent.includes('Cancelled')`, 'cancellation');
  check((await get(first.id)).status === 'cancelled', 'Cancelled history preserved');

  // A short future API fixture avoids waiting a full minute to test the real
  // Start action. It is created through the public appointment API, not SQL.
  const scheduled = await post(0, 'appointments', { customer_id: a.customer.id, staff_id: walkStaff.id, service_id: short.id, starts_at: new Date(Date.now() + 3000).toISOString() });
  await refresh(); await new Promise(resolve => setTimeout(resolve, 3200));
  await wait(`!!${article(scheduled.id)} && ![...${article(scheduled.id)}.querySelectorAll('button')].find(button=>button.textContent==='Start appointment').disabled`, 'start becomes available');
  await click('Start appointment', article(scheduled.id)); await ready(); await wait(`${article(scheduled.id)}?.textContent.includes('In progress')`, 'start status');
  await click('Complete', article(scheduled.id)); await ready(); await wait(`${article(scheduled.id)}?.textContent.includes('Completed')`, 'completion');
  await form({ customer: a.customer, staff: walkStaff, service: short });
  await evaluate('[...document.querySelectorAll("dialog input[name=bookingType]")].find(input=>input.value==="Walk-in").click()');
  check(await evaluate('document.querySelector(".booking-date-time").hidden'), 'Walk-in date/time are server owned');
  await save(); await saved();
  const walkIn = (await api(0, 'appointments')).data.items.find(item => item.booking_type === 'walk_in');
  check(walkIn?.status === 'in_progress', 'Walk-in starts in progress');
  await click('Complete', article(walkIn.id)); await ready(); await wait(`${article(walkIn.id)}?.textContent.includes('Completed')`, 'walk-in completion');
  check((await api(0, 'appointments/' + walkIn.id, 'DELETE')).status === 409, 'Completed history cannot be cancelled');
  await evaluate('location.hash="customers"'); await wait('!!document.querySelector(".customer-page")', 'customer history');
  check(await evaluate('document.querySelector(".customer-card dd").textContent==="2"'), 'Derived completed visits');
  await click('View history', 'document.querySelector("article.customer-card")'); check(await evaluate('document.querySelectorAll(".history-item").length===3'), 'Real customer history');
  await evaluate('location.hash="dashboard"'); await wait('!!document.querySelector(".kpi")', 'dashboard');
  await wait('!!document.querySelector("[data-revenue-ready=true]")', 'collected revenue ready');
  check(await evaluate('[...document.querySelectorAll(".kpi")].find(card=>card.textContent.includes("Today\u0027s collected revenue")).querySelector(".kpi-value").textContent==="PKR 0.00"'), 'Completed unpaid bookings must not count as collected revenue');

  await appointments(); await set('.appointment-filters select', 'Cancelled');
  await wait('document.querySelectorAll(".appointment").length===1', 'status filter');
  await set('.appointment-filters input[type=date]', future);
  await set('.appointment-filters label:nth-of-type(4) select', a.staff.id);
  const filtered = await api(0, `appointments?date=${future}&status=cancelled&staff_id=${a.staff.id}`);
  check(filtered.data.total === 1 && await evaluate('document.querySelector(".filter-summary").textContent.includes("Showing 1 of")'), 'Business date/status filtering');
  await click('Clear filters');
  for (let index = 0; index < 21; index++) {
    const date = new Date(Date.now() + (index + 5) * 86400000).toISOString().slice(0, 10);
    await post(0, 'appointments', { customer_id: a.customer.id, staff_id: a.staff.id, service_id: a.service.id, starts_at: date + 'T05:00:00Z' });
  }
  await refresh(); check(await evaluate('document.querySelectorAll(".appointment").length===20'), 'Appointment page size');
  await click('Next', 'document.querySelector(".directory-pagination")'); check(await evaluate('document.querySelector(".directory-pagination").textContent.includes("Page 2 of 2")'), 'Appointment pagination');

  await logout(); await route('register'); await submit(accounts[1]); await wait('!!document.querySelector(".app-shell")', 'second business'); await ready();
  const b = await resources(1, 'B'); await refresh(); await appointments(); check(await evaluate('!document.querySelector(".appointment")'), 'Second business cannot see first business bookings');
  await form(b); await save(); await saved();
  for (const [method, body] of [['GET', undefined], ['PATCH', { status: 'cancelled' }], ['DELETE', undefined]]) check((await api(1, 'appointments/' + first.id, method, body)).status === 404, 'Cross-tenant booking protection');
  for (const [field, id] of [['customer_id', a.customer.id], ['staff_id', a.staff.id], ['service_id', a.service.id]]) check((await api(1, 'appointments', 'POST', { customer_id: b.customer.id, staff_id: b.staff.id, service_id: b.service.id, starts_at: future + 'T07:00:00Z', [field]: id })).status === 404, 'Cross-tenant booking references');
  await logout(); await login(accounts[0]); await ready(); await appointments();
  check((await api(0, 'appointments')).data.total === 24, 'Bookings persisted across re-login');
  check(await evaluate('!document.body.textContent.includes("Booking customer B")'), 'No cross-account data leakage');

  // No public staff-account creation API exists: change only this uniquely
  // marked temporary identity to verify the existing database-derived role.
  const backend = fileURLToPath(new URL('../../backend/', import.meta.url));
  const roleCode = `
import json,sys
from sqlalchemy import create_engine,select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from app.core.config import Settings
from app.models import User,Business,UserRole
d=json.loads(sys.argv[1]);u=make_url(Settings().database_url.get_secret_value())
assert u.host in ('localhost','127.0.0.1','::1') and u.database=='salonpulse_dev' and u.username=='salonpulse_app' and u.port==5432
e=create_engine(u,hide_parameters=True)
try:
 with Session(e) as s,s.begin():
  b=s.scalar(select(Business).where(Business.name==d['business_name']));assert b is not None and b.name.startswith('__day7_browser__')
  user=s.scalar(select(User).where(User.email==d['email'],User.business_id==b.id));assert user is not None;user.role=UserRole.STAFF
finally:e.dispose()
`;
  const role = spawnSync(resolve(backend, '.venv/Scripts/python.exe'), ['-B', '-c', roleCode, JSON.stringify({ business_name: accounts[0].business_name, email: accounts[0].email })], { cwd: backend, env: { ...process.env, DEBUG: 'false', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
  check(role.status === 0, 'Guarded staff role fixture');
  await logout(); await login(accounts[0]); await ready(); await appointments();
  await form({ customer: a.customer, staff: walkStaff, service: short }); await evaluate('[...document.querySelectorAll("dialog input[name=bookingType]")].find(input=>input.value==="Walk-in").click()'); await save(); await saved();
  check((await api(0, 'appointments')).data.items.filter(item => item.booking_type === 'walk_in').length === 2, 'Staff can create appointments');
  const latest = (await api(0, 'appointments')).data.items.filter(item => item.status === 'in_progress')[0];
  await click('Cancel appointment', article(latest.id)); await ready(); check((await get(latest.id)).status === 'cancelled', 'Staff can cancel appointments');
  await form(a, '12:00');
  await command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await save(); await wait('document.querySelector("dialog [role=alert]")?.textContent.includes("Cannot reach")', 'network failure feedback');
  await evaluate('window.dispatchEvent(new Event("focus"))'); check(await evaluate('document.querySelector("dialog input[type=time]").value==="12:00"'), 'Network failure retains draft');
  await command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await close();
  await command('Page.reload'); await wait('!!document.querySelector(".auth-form")', 'refresh login'); await login(accounts[0]); await ready(); await appointments();
  check((await api(0, 'appointments')).data.total === 25, 'Server records survive page refresh');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  check(await evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Mobile appointment layout');
}
