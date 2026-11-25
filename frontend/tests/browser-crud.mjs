// Run through browser-auth.mjs --crud: reuse its guarded cleanup and Chrome connection.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verifyCrud({ accounts, command, evaluate, wait, route, submit, logout, login, check, socket, calls }) {
  let acceptDialogs = true; let dialogs = 0;
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Page.javascriptDialogOpening') { dialogs++; void command('Page.handleJavaScriptDialog', { accept: acceptDialogs }); }
  });
  const tokens = [];
  async function api(index, path, method = 'GET', body) {
    if (!tokens[index]) {
      const response = await fetch('http://127.0.0.1:8000/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: accounts[index].email, password: accounts[index].password }) });
      check(response.status === 200, 'Fixture login'); tokens[index] = (await response.json()).access_token;
    }
    const response = await fetch('http://127.0.0.1:8000/api/' + path, { method, headers: { Authorization: 'Bearer ' + tokens[index], 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: response.status === 204 ? null : await response.json() };
  }
  async function list(resource) { const result = await api(0, resource + '?limit=100'); check(result.status === 200, 'Read saved directory'); return result.data.items; }
  async function saved(resource, name) { const record = (await list(resource)).find(item => item.name === name); check(!!record, 'Saved record missing'); return record; }
  async function ready() { await wait('document.querySelector(".directory-toolbar button")?.disabled===false && !!document.querySelector(".app-shell")', 'directory load'); }
  async function navigate(page) { await evaluate(`location.hash=${JSON.stringify(page)}`); await ready(); await wait(`document.querySelector('main h1')?.textContent===${JSON.stringify(page[0].toUpperCase() + page.slice(1))}`, 'directory navigation'); }
  async function click(text, within = 'document') { await evaluate(`([...${within}.querySelectorAll('button')].find(button=>button.textContent.trim()===${JSON.stringify(text)})).click()`); }
  async function set(selector, value) {
    await evaluate(`(() => { const input=document.querySelector(${JSON.stringify(selector)}); const prototype=input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(input,${JSON.stringify(value)}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  }
  async function submitEditor() { await evaluate('document.querySelector(".customer-edit-panel form").requestSubmit()'); }
  const card = name => `[...document.querySelectorAll('article.customer-card')].find(card=>card.querySelector('h3')?.textContent===${JSON.stringify(name)})`;
  async function see(name) { await ready(); await wait(`!!(${card(name)})`, 'saved card'); }
  async function createCustomer(name, phone = '') {
    await navigate('customers'); await click('Add customer'); await set('.customer-editor input[autocomplete=name]', name);
    await set('.customer-editor input[type=tel]', phone); await set('.customer-editor textarea', 'Saved customer notes'); await submitEditor(); await see(name);
  }
  async function createStaff(name) {
    await navigate('staff'); await click('Add employee'); await set('.staff-editor input:not([type])', name);
    await set('.staff-editor input[type=tel]', '03011234567');
    await evaluate('document.querySelector(".working-hours > label input").click()');
    for (let day = 0; day < 7; day++) await evaluate(`(() => { const input=document.querySelectorAll('.shift-row input[type=checkbox]')[${day}]; if (!input.checked) input.click(); })()`);
    await submitEditor(); await see(name);
  }
  async function createService(name) {
    await navigate('services'); await click('Add service'); await set('.customer-edit-panel input:not([type])', name);
    await set('.customer-edit-panel input[type=number]', '45'); await set('.customer-edit-panel input[inputmode=decimal]', '1250.50');
    await set('.service-description-input', 'A detailed service description'); await submitEditor(); await see(name);
  }
  async function edit(resource, name, label) { await navigate(resource); await see(name); await click(label, `(${card(name)})`); }
  async function focusPreservesEditor(label) {
    const snapshot = `JSON.stringify({fields:[...document.querySelectorAll('[data-catalog-editor] input,[data-catalog-editor] textarea,[data-catalog-editor] select')].map(input=>({value:input.value,checked:input.checked})),feedback:[...document.querySelectorAll('[data-catalog-editor] [role=alert]')].map(item=>item.textContent)})`;
    const before = await evaluate(snapshot); const requests = calls.length;
    await evaluate('(async()=>{window.dispatchEvent(new Event("focus"));await new Promise(resolve=>setTimeout(resolve,350));})()');
    check(await evaluate('!!document.querySelector("[data-catalog-editor]")'), label + ' editor remained mounted');
    check(await evaluate(snapshot) === before, label + ' draft and feedback preserved');
    check(calls.length === requests, label + ' focus refresh deferred');
  }
  function fixture(operation, records = {}) {
    const backend = fileURLToPath(new URL('../../backend/', import.meta.url));
    const code = `
import json,sys
from datetime import datetime,timedelta,timezone
from sqlalchemy import create_engine,select
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from app.core.config import Settings
from app.models import Business,User,UserRole,Customer,Staff,Service,Appointment,AppointmentStatus,AppointmentType
from uuid import UUID
data=json.loads(sys.argv[1]); url=make_url(Settings().database_url.get_secret_value())
assert url.host in ('localhost','127.0.0.1','::1') and url.database=='salonpulse_dev' and url.username=='salonpulse_app' and url.port==5432
engine=create_engine(url,hide_parameters=True)
try:
 with Session(engine) as session,session.begin():
  business=session.scalar(select(Business).where(Business.name==data['business_name']))
  assert business is not None and business.name.startswith('__day7_browser__')
  user=session.scalar(select(User).where(User.email==data['email'],User.business_id==business.id)); assert user is not None
  if data['operation']=='staff': user.role=UserRole.STAFF
  elif data['operation']=='owner': user.role=UserRole.OWNER
  else:
   customer=session.scalar(select(Customer).where(Customer.id==UUID(data['customer']),Customer.business_id==business.id))
   staff=session.scalar(select(Staff).where(Staff.id==UUID(data['staff']),Staff.business_id==business.id))
   service=session.scalar(select(Service).where(Service.id==UUID(data['service']),Service.business_id==business.id))
   assert customer is not None and staff is not None and service is not None
   start=(datetime.now(timezone.utc)+timedelta(days=2)).replace(hour=5,minute=0,second=0,microsecond=0)
   session.add(Appointment(business_id=business.id,customer_id=customer.id,staff_id=staff.id,service_id=service.id,starts_at=start,ends_at=start+timedelta(minutes=service.duration_minutes),status=AppointmentStatus.CONFIRMED,booking_type=AppointmentType.SCHEDULED,booked_price=service.price,booked_duration_minutes=service.duration_minutes))
 print('ok')
finally: engine.dispose()
`;
    const result = spawnSync(resolve(backend, '.venv/Scripts/python.exe'), ['-B', '-c', code, JSON.stringify({ operation, business_name: accounts[0].business_name, email: accounts[0].email, ...records })], { cwd: backend, env: { ...process.env, DEBUG: 'false', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
    check(result.status === 0, 'Guarded temporary fixture');
  }

  await route('register'); await submit(accounts[0]); await wait('!!document.querySelector(".app-shell")', 'register first business'); await ready();
  await createCustomer('Customer A', '03001234567');
  const customer = await saved('customers', 'Customer A'); check(customer.phone === '+923001234567', 'Phone normalization');
  await click('Add customer'); await set('.customer-editor input[autocomplete=name]', 'Duplicate A'); await set('.customer-editor input[type=tel]', '03001234567');
  await submitEditor(); await wait('document.querySelector(".customer-editor [role=alert]")?.textContent.includes("already belongs")', 'duplicate phone');
  check(true, 'Duplicate phone rejected');
  await set('.customer-editor textarea', 'Unsaved customer draft');
  await focusPreservesEditor('Customer validation');
  await click('Cancel', 'document.querySelector(".customer-editor")');
  await edit('customers', 'Customer A', 'Edit customer'); await set('.customer-editor input[type=tel]', ''); await set('.customer-editor textarea', 'Updated notes'); await submitEditor(); await see('Customer A');
  check((await saved('customers', 'Customer A')).phone === null, 'Nullable phone clearing');
  await createStaff('Staff A'); const staff = await saved('staff', 'Staff A'); check(staff.hours.length === 7 && staff.hours[0].start === '09:00', 'Working hours saved');
  await edit('staff', 'Staff A', 'Edit employee / hours'); await set('.staff-editor .editor-fields > label:nth-of-type(3) input', 'Senior barber');
  // Edit a shift through the existing controlled time input.
  await set('.shift-row input[type=time]', '09:30'); await focusPreservesEditor('Staff working hours'); await submitEditor(); await see('Staff A');
  check((await saved('staff', 'Staff A')).hours.some(day => day.start === '09:30'), 'Working hours edit');
  await createService('Service A'); let service = await saved('services', 'Service A');
  check(service.price === '1250.50' && service.duration_minutes === 45 && service.description === 'A detailed service description', 'Service contract mapping');
  await edit('services', 'Service A', 'Edit service'); await set('.customer-edit-panel input[inputmode=decimal]', '9999999999.99');
  await focusPreservesEditor('Service price'); await submitEditor(); await see('Service A');
  check((await saved('services', 'Service A')).price === '9999999999.99', 'Maximum price persistence');
  for (const price of ['10000000000', '-0.01', '1.001']) {
    const result = await api(0, 'services/' + service.id, 'PATCH', { price }); check(result.status === 422, 'Backend rejects invalid price');
  }
  await edit('services', 'Service A', 'Edit service'); await set('.customer-edit-panel input[inputmode=decimal]', '1250.50'); await submitEditor(); await see('Service A');
  // Actual unreferenced DELETE flows for all three resource types.
  await createCustomer('Disposable customer'); await click('Delete customer', `(${card('Disposable customer')})`); await ready();
  await wait(`!(${card('Disposable customer')})`, 'customer deletion'); check(true, 'Customer DELETE');
  await createService('Disposable service'); await click('Delete service', `(${card('Disposable service')})`); await ready();
  await wait(`!(${card('Disposable service')})`, 'service deletion'); check(true, 'Service DELETE');
  // Staff phone must differ from Staff A.
  await navigate('staff'); await click('Add employee'); await set('.staff-editor input:not([type])', 'Disposable staff'); await submitEditor(); await see('Disposable staff');
  await click('Delete employee', `(${card('Disposable staff')})`); await ready(); await wait(`!(${card('Disposable staff')})`, 'staff deletion'); check(true, 'Staff DELETE');

  fixture('booking', { customer: customer.id, staff: staff.id, service: service.id });
  for (const [resource, name, label, id] of [['customers', 'Customer A', 'Delete customer', customer.id], ['staff', 'Staff A', 'Delete employee', staff.id], ['services', 'Service A', 'Delete service', service.id]]) {
    await navigate(resource); await click(label, `(${card(name)})`); await wait('document.querySelector("main [role=alert]")?.textContent.includes("referenced")', 'restricted deletion');
    check((await api(0, resource + '/' + id)).status === 200, 'Referenced record preserved');
  }
  await edit('staff', 'Staff A', 'Edit employee / hours'); await evaluate('document.querySelector(".working-hours > label input").click()'); await submitEditor();
  await wait('document.querySelector(".staff-editor [role=alert]")?.textContent.includes("conflicts")', 'hours conflict'); check(true, 'Hours preserve existing bookings');
  await click('Cancel', 'document.querySelector(".staff-editor")');
  for (const [resource, name, label] of [['staff', 'Staff A', 'Edit employee / hours'], ['services', 'Service A', 'Edit service']]) {
    await edit(resource, name, label); await evaluate('document.querySelector(".customer-edit-panel .staff-checkbox input").click()');
    acceptDialogs = false; await submitEditor(); await wait('document.querySelector(".customer-edit-panel [role=alert]")?.textContent.includes("not saved")', 'declined deactivation');
    await focusPreservesEditor(resource + ' declined deactivation');
    check((await saved(resource, name)).active === true, 'Declined deactivation kept record active');
    acceptDialogs = true; await submitEditor(); await see(name);
    check(await evaluate(`(${card(name)}).textContent.includes('Inactive')`), 'Confirmed deactivation');
  }

  await logout(); await route('register'); await submit(accounts[1]); await wait('!!document.querySelector(".app-shell")', 'register second business'); await ready();
  for (const resource of ['customers', 'staff', 'services']) { await navigate(resource); check(await evaluate('document.querySelectorAll("article.customer-card").length===0'), 'Other tenant directory leaked'); }
  await createCustomer('Customer B');
  for (const [resource, id] of [['customers', customer.id], ['staff', staff.id], ['services', service.id]]) {
    for (const [method, body] of [['GET', undefined], ['PATCH', { name: 'Intrusion' }], ['DELETE', undefined]]) check((await api(1, resource + '/' + id, method, body)).status === 404, 'Cross-tenant access');
  }
  await logout(); await login(accounts[0]); await ready(); await navigate('customers'); await see('Customer A');
  check(await evaluate('!document.body.textContent.includes("Customer B")'), 'Cross-login data leakage');
  await navigate('staff'); await see('Staff A'); check(await evaluate(`(${card('Staff A')}).textContent.includes('Inactive')`), 'Staff state did not persist');
  await navigate('services'); await see('Service A'); check(await evaluate(`(${card('Service A')}).textContent.includes('Inactive')`), 'Service state did not persist');

  // Existing appointment preview still quick-adds a real customer and keeps its
  // draft on focus; this does not create a backend appointment.
  await click('New appointment'); await wait('!!document.querySelector("dialog[open]")', 'appointment preview');
  await click('+ Add customer', 'document.querySelector("dialog")');
  await set('dialog .customer-editor input[autocomplete=name]', 'Quick-added customer');
  await evaluate('document.querySelector("dialog .customer-editor").requestSubmit()');
  await wait('!document.querySelector("dialog .customer-editor")', 'quick customer save');
  const quick = await saved('customers', 'Quick-added customer');
  check(await evaluate(`document.querySelector('dialog select').value===${JSON.stringify(quick.id)}`), 'Quick customer UUID selected');
  await focusPreservesEditor('Appointment preview');
  await evaluate('document.querySelector("dialog .icon-button").click()');

  fixture('staff'); await logout(); await login(accounts[0]); await ready();
  for (const resource of ['staff', 'services']) { await navigate(resource); check(await evaluate('!document.querySelector(".customer-toolbar button") && document.body.textContent.includes("Read-only")'), 'Staff role exposed owner controls'); }
  check((await api(0, 'staff', 'POST', { name: 'Forbidden' })).status === 403, 'Staff API permission');
  check((await api(0, 'services/' + service.id, 'PATCH', { active: true })).status === 403, 'Service API permission');
  await createCustomer('Staff-created customer'); check(true, 'Staff customer management');
  fixture('owner'); await logout(); await login(accounts[0]); await ready();
  // Seed additional HTTP fixtures solely to exercise directory pagination/search.
  for (let index = 0; index < 21; index++) check((await api(0, 'customers', 'POST', { name: 'Pagination ' + String(index).padStart(2, '0') })).status === 201, 'Pagination fixture');
  await click('Refresh directories'); await ready(); await navigate('customers');
  // Focus must still revalidate once no editor owns a draft.
  const focusRequests = calls.length;
  await evaluate('window.dispatchEvent(new Event("focus"))');
  await wait('document.querySelector(".directory-toolbar button")?.disabled===false', 'focus refresh without editor');
  check(calls.length > focusRequests, 'Focus refresh retained outside editors');
  check(await evaluate('document.querySelectorAll("article.customer-card").length===20'), 'First page size');
  await click('Next', 'document.querySelector(".directory-pagination")'); check(await evaluate('document.querySelector(".directory-pagination").textContent.includes("Page 2 of 2")'), 'Next page');
  await set('.customer-search input', 'Customer A'); await wait(`!!(${card('Customer A')})`, 'global search'); check(await evaluate('document.querySelectorAll("article.customer-card").length===1'), 'Search across pages');

  // Logout during a delayed refresh: its responses must not hydrate the next account.
  await command('Network.emulateNetworkConditions', { offline: false, latency: 200, downloadThroughput: -1, uploadThroughput: -1 });
  await click('Refresh directories'); await logout(); await login(accounts[1]); await ready();
  await command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await navigate('customers'); await see('Customer B'); check(await evaluate('!document.body.textContent.includes("Customer A")'), 'Stale responses crossed accounts');
  await command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await click('Refresh directories'); await wait('document.querySelector("main [role=alert]")?.textContent.includes("Cannot reach")', 'network failure');
  check(await evaluate('!document.querySelector("article.customer-card")'), 'Stale records shown after failed refresh');
  await command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await click('Refresh directories'); await ready(); await see('Customer B');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  check(await evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Mobile directory overflow');
  check(!calls.some(path => path.startsWith('/api/appointments')), 'Appointment API integration added unexpectedly');
  check(dialogs >= 8, 'Confirmation dialogs were not exercised');
}
