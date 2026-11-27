// Run with browser-auth.mjs --dashboard. Its finally block removes only the
// marked test businesses and compares all six tables with their original IDs.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyDashboard({ accounts, command, evaluate, wait, route, submit, logout, login, check, socket, traffic }) {
  socket.addEventListener('message', event => { if (JSON.parse(event.data).method === 'Page.javascriptDialogOpening') void command('Page.handleJavaScriptDialog', { accept: true }); });
  const tokens = [];
  async function api(index, path, method = 'GET', body) {
    if (!tokens[index]) {
      const response = await fetch('http://127.0.0.1:8010/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: accounts[index].email, password: accounts[index].password }) });
      check(response.status === 200, 'Dashboard fixture login'); tokens[index] = (await response.json()).access_token;
    }
    const response = await fetch('http://127.0.0.1:8010/api/' + path, { method, headers: { Authorization: 'Bearer ' + tokens[index], 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  }
  function database(index, seed = false) {
    const backend = fileURLToPath(new URL('../../backend/', import.meta.url));
    const code = `
import json,sys,os
from datetime import datetime,timedelta,timezone
from decimal import Decimal
from uuid import UUID,uuid4
from zoneinfo import ZoneInfo
from sqlalchemy import create_engine,select,text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from app.core.config import Settings
from app.models import Business,User,Customer,Staff,Service,Appointment,AppointmentStatus,AppointmentType
d=json.loads(sys.argv[1]);u=make_url(Settings().database_url.get_secret_value())
assert u.drivername=='postgresql+psycopg' and u.host in ('localhost','127.0.0.1','::1') and u.database=='salonpulse_dev' and u.username=='salonpulse_app' and u.port==5432
sys.path.insert(0,'tests')
from isolated_db import test_engine
e=test_engine(os.environ['SALONPULSE_TEST_SCHEMA'])
try:
 with Session(e) as s,s.begin():
  b=s.scalar(select(Business).where(Business.name==d['business_name']));assert b is not None and b.name.startswith('__day7_browser__')
  assert s.scalar(select(User.id).where(User.email==d['email'],User.business_id==b.id)) is not None
  if d['seed']:
   assert not s.scalar(select(Customer.id).where(Customer.business_id==b.id).limit(1))
   b.timezone='Asia/Karachi' if d['index']==0 else 'UTC'
   count=101 if d['index']==0 else 1;letter='A' if d['index']==0 else 'B'
   clients=[Customer(id=UUID(int=(1<<128)-1) if i==count-1 and d['index']==0 else uuid4(),business_id=b.id,name=f'Dashboard customer {letter} {i:03}') for i in range(count)]
   team=[Staff(id=UUID(int=(1<<128)-2) if i==count-1 and d['index']==0 else uuid4(),business_id=b.id,name=f'Dashboard staff {letter} {i:03}',active=i!=1,hours=[dict(day=day,start='00:00',end='23:59') for day in range(7)]) for i in range(count)]
   service=Service(business_id=b.id,name='Dashboard service '+letter,duration_minutes=30,price=Decimal('100.00'))
   s.add_all(clients+team+[service]);s.flush()
   zone=ZoneInfo(b.timezone);now=datetime.now(timezone.utc);day=now.astimezone(zone).replace(hour=0,minute=0,second=0,microsecond=0);tomorrow=day+timedelta(days=1)
   def add(start,status,member=None,minutes=30):
    start=start.astimezone(timezone.utc)
    s.add(Appointment(business_id=b.id,customer_id=clients[-1].id,staff_id=(member or team[-1]).id,service_id=service.id,starts_at=start,ends_at=start+timedelta(minutes=minutes),status=status,booking_type=AppointmentType.SCHEDULED,booked_price=Decimal('100.00'),booked_duration_minutes=minutes))
   if d['index']==0:
    for i in range(105):add(day-timedelta(days=1)+timedelta(hours=1,minutes=i*2),AppointmentStatus.COMPLETED)
    for i in range(4):add(now-timedelta(minutes=60-i*5),AppointmentStatus.COMPLETED)
    for i in range(3):add(day+timedelta(hours=4,minutes=i*35),AppointmentStatus.CONFIRMED)
    for i in range(2):add(day+timedelta(hours=7,minutes=i*35),AppointmentStatus.CANCELLED)
    add(now-timedelta(seconds=10),AppointmentStatus.IN_PROGRESS,team[1],20)
    add(day-timedelta(seconds=1),AppointmentStatus.CANCELLED)
    add(day,AppointmentStatus.CONFIRMED)
    add(tomorrow,AppointmentStatus.CONFIRMED)
   else:add(day+timedelta(hours=1),AppointmentStatus.COMPLETED)
   for hour in (10,11,12):add(tomorrow+timedelta(hours=hour),AppointmentStatus.CONFIRMED)
  s.flush()
  params={'business':b.id,'zone':b.timezone}
  status=dict(s.execute(text("SELECT status,count(*) FROM appointments WHERE business_id=:business AND (starts_at AT TIME ZONE :zone)::date=(now() AT TIME ZONE :zone)::date GROUP BY status"),params).all())
  upcoming=s.execute(text("SELECT id FROM appointments WHERE business_id=:business AND status='confirmed' AND starts_at>=now() ORDER BY starts_at,id"),params).scalars().all()
  workload=s.execute(text("SELECT s.id,count(a.id),coalesce(sum(a.booked_duration_minutes),0) FROM staff s LEFT JOIN appointments a ON a.business_id=s.business_id AND a.staff_id=s.id AND a.status<>'cancelled' AND (a.starts_at AT TIME ZONE :zone)::date=(now() AT TIME ZONE :zone)::date WHERE s.business_id=:business GROUP BY s.id"),params).all()
  customer_count=s.scalar(text('SELECT count(*) FROM customers WHERE business_id=:business'),params)
  future=s.scalar(text("SELECT id FROM appointments WHERE business_id=:business AND status='confirmed' AND starts_at>=now() ORDER BY starts_at DESC LIMIT 1"),params)
  confirmed=s.scalar(text("SELECT id FROM appointments WHERE business_id=:business AND status='confirmed' AND (starts_at AT TIME ZONE :zone)::date=(now() AT TIME ZONE :zone)::date ORDER BY starts_at LIMIT 1"),params)
  chosen_customer=s.scalar(select(Customer).where(Customer.business_id==b.id).order_by(Customer.id.desc()).limit(1));chosen_staff=s.scalar(select(Staff).where(Staff.business_id==b.id,Staff.active.is_(True)).order_by(Staff.id.desc()).limit(1));chosen_service=s.scalar(select(Service).where(Service.business_id==b.id).limit(1))
  result=dict(statuses={key:int(status.get(key,0)) for key in ('confirmed','in_progress','completed','cancelled')},customers=customer_count,upcoming=len(upcoming),next=[str(value) for value in upcoming[:5]],workload={str(row[0]):[row[1],row[2]] for row in workload},zone=b.timezone,tomorrow=(datetime.now(ZoneInfo(b.timezone))+timedelta(days=1)).date().isoformat(),customer=str(chosen_customer.id),staff=str(chosen_staff.id),service=str(chosen_service.id),future=str(future) if future else None,confirmed=str(confirmed) if confirmed else None)
 print(json.dumps(result))
finally:e.dispose()
`;
    const result = spawnSync(resolve(backend, '.venv/Scripts/python.exe'), ['-B', '-c', code, JSON.stringify({ business_name: accounts[index].business_name, email: accounts[index].email, index, seed })], { cwd: backend, env: { ...process.env, DEBUG: 'false', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
    check(result.status === 0, 'Guarded dashboard database fixture/query');
    return JSON.parse(result.stdout);
  }
  async function ready() { await wait('!!document.querySelector(".app-shell") && document.querySelector(".directory-toolbar button")?.disabled===false', 'dashboard data'); await wait('document.querySelector("[data-revenue-ready=true]") || location.hash!=="#dashboard"', 'dashboard revenue'); }
  async function click(label, scope = 'document') { await evaluate(`([...${scope}.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(label)})).click()`); }
  async function set(selector, value) { await evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});const prototype=input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`); }
  async function dashboard() { await evaluate('location.hash="dashboard"'); await ready(); await wait('!!document.querySelector(".dashboard-status-summary")', 'dashboard'); }
  async function refresh() { await click('Refresh directories'); await ready(); }
  async function assertStats(expected) {
    await dashboard();
    const active = expected.statuses.confirmed + expected.statuses.in_progress + expected.statuses.completed;
    const values = await evaluate('[...document.querySelectorAll(".kpi-value")].map(item=>item.textContent)');
    check(values[0] === String(active), 'Daily count matches PostgreSQL'); check(values[2] === String(expected.customers), 'Customer count includes every page'); check(values[3] === String(expected.upcoming), 'Upcoming count includes every page');
    const labels = { confirmed: 'Confirmed', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' };
    for (const [key, label] of Object.entries(labels)) check(await evaluate(`document.querySelector('[data-daily-status="${label}"]').textContent`) === `${label}: ${expected.statuses[key]}`, 'Status total matches PostgreSQL: ' + label);
    check(await evaluate('[...document.querySelectorAll(".dashboard-main-panels .appointment")].map(item=>item.dataset.appointmentId)').then(ids => JSON.stringify(ids) === JSON.stringify(expected.next)), 'Upcoming order matches PostgreSQL');
    for (const [id, values] of Object.entries(expected.workload).filter(([, values]) => values[0] > 0)) {
      const row = await evaluate(`document.querySelector('[data-workload-id="${id}"]')?.textContent`);
      check(!!row && row.includes(`${values[0]} appointments`) && row.includes(`${values[1]} min booked`), 'Staff workload uses all daily snapshots');
    }
    check(await evaluate('document.querySelector(".section-date").textContent').then(text => text.includes(expected.zone)), 'Business timezone displayed');
  }

  await route('register'); await submit(accounts[0]); await wait('!!document.querySelector(".app-shell")', 'first business'); await ready();
  check(await evaluate('[...document.querySelectorAll(".kpi-value")].every(item=>item.textContent==="0"||item.textContent==="PKR 0.00")'), 'New business starts empty without samples');
  let expected = database(0, true); await refresh(); await assertStats(expected);
  for (const resource of ['appointments','customers','staff']) check(traffic.some(item => item.path === '/api/' + resource && item.method === 'GET' && item.offset === '100'), resource + ' second API page loaded');
  // Read every workload display page, not just its first twenty staff.
  const workload = {};
  while (true) {
    const rows = await evaluate('[...document.querySelectorAll(".workload-row")].map(item=>({id:item.dataset.workloadId,counts:[...item.querySelectorAll(":scope > span")].map(span=>parseInt(span.textContent,10))}))');
    for (const row of rows) workload[row.id] = row.counts;
    if (await evaluate('[...document.querySelectorAll(".dashboard-main-panels section:last-child nav button")].find(button=>button.textContent==="Next").disabled')) break;
    await click('Next', 'document.querySelector(".dashboard-main-panels section:last-child nav")');
  }
  check(JSON.stringify(Object.entries(workload).sort()) === JSON.stringify(Object.entries(expected.workload).sort()), 'Every staff workload page matches PostgreSQL');
  // Return to the first workload page for later positive-workload assertions.
  while (!await evaluate('[...document.querySelectorAll(".dashboard-main-panels section:last-child nav button")].find(button=>button.textContent==="Previous").disabled')) await click('Previous', 'document.querySelector(".dashboard-main-panels section:last-child nav")');
  await evaluate('location.hash="customers"'); await wait('!!document.querySelector(".customer-page")', 'customer page');
  await click('Add customer'); await set('.customer-editor input[autocomplete=name]', 'Dashboard extra customer A'); await evaluate('document.querySelector(".customer-editor").requestSubmit()'); await ready(); await wait('!document.querySelector(".customer-editor")', 'saved customer');
  expected = database(0); await assertStats(expected); check(expected.customers === 102, 'Dashboard updated after customer creation');
  const created = (await api(0, 'customers?limit=100')).data.items.find(item => item.name === 'Dashboard extra customer A'); check(!!created, 'New customer persisted');
  await click('New appointment'); await wait('!!document.querySelector("dialog[open]")', 'booking form');
  await evaluate(`(()=>{const selects=document.querySelectorAll('dialog form:not([hidden]) select');for(const [index,value] of [[0,${JSON.stringify(created.id)}],[1,${JSON.stringify(expected.service)}],[2,${JSON.stringify(expected.staff)}]]){Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(selects[index],value);selects[index].dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await set('dialog input[type=date]', expected.tomorrow); await set('dialog input[type=time]', '14:00'); await evaluate('document.querySelector("dialog form:not([hidden])").requestSubmit()'); await wait('!document.querySelector("dialog")', 'booking saved'); await ready();
  expected = database(0); await assertStats(expected);
  const createdBooking = (await api(0, 'appointments?date=' + expected.tomorrow + '&staff_id=' + expected.staff + '&limit=100')).data.items.find(item => item.customer_id === created.id); check(!!createdBooking, 'Dashboard booking persisted');
  check((await api(0, 'appointments/' + createdBooking.id, 'DELETE')).status === 204, 'Cancel dashboard booking'); await evaluate('window.dispatchEvent(new Event("focus"))'); await ready(); expected = database(0); await assertStats(expected);
  if (expected.confirmed) { check((await api(0, 'appointments/' + expected.confirmed, 'DELETE')).status === 204, 'Cancel today booking'); await refresh(); expected = database(0); await assertStats(expected); }
  check((await api(0, 'services/' + expected.service, 'PATCH', { price: '5000.00', duration_minutes: 90 })).status === 200, 'Catalog update'); await refresh(); await assertStats(database(0));
  await logout(); await login(accounts[0]); await ready(); await assertStats(database(0));
  await logout(); await route('register'); await submit(accounts[1]); await wait('!!document.querySelector(".app-shell")', 'second business'); await ready();
  check(await evaluate('document.querySelectorAll(".workload-row").length===0'), 'Other business starts empty');
  const firstBooking = expected.future; database(1, true); await logout(); await login(accounts[1]); await ready(); await assertStats(database(1));
  check(await evaluate('!document.body.textContent.includes("Dashboard customer A") && !document.body.textContent.includes("Dashboard staff A")'), 'Dashboard tenant data isolated');
  check((await api(1, 'appointments/' + firstBooking)).status === 404, 'Cross-business booking inaccessible');
  await command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await click('Refresh directories');
  await wait('document.querySelector("main [role=alert]")?.textContent.includes("Cannot reach")', 'dashboard network error');
  check(await evaluate('[...document.querySelectorAll(".kpi-value")].every(item=>item.textContent==="--")'), 'Unavailable statistics are not shown as zero');
  await command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); await click('Refresh directories'); await ready(); await assertStats(database(1));
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  check(await evaluate('document.documentElement.scrollWidth<=innerWidth && document.querySelector(".workload-row").getBoundingClientRect().width>0'), 'Mobile dashboard and workload remain available');
}
