const cdpOrigin = process.env.SALONPULSE_CDP_URL ?? 'http://127.0.0.1:9223';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(cdpOrigin)) throw new Error('CDP must use a local HTTP endpoint');
// Opt-in real Chrome verification. Requires localhost services, Chrome CDP on 9223,
// and the existing backend venv. Creates two unique businesses; always cleans only those.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForCondition } from './browser-readiness.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const backend = resolve(root, '../backend');
const accounts = [0, 1].map(() => ({ business_name: '__day7_browser__' + randomUUID(), full_name: 'Temporary owner', email: 'browser-' + randomUUID() + '@example.com', password: randomBytes(24).toString('base64url') }));
const markers = accounts.map(({ business_name, email }) => ({ name: business_name, email }));

function database(cleanup = false) {
  const code = `
import json,sys
from sqlalchemy import create_engine,select,delete
from sqlalchemy.engine import make_url
from app.core.config import Settings
from app.models import Business,User,Customer,Staff,Service,Appointment,Payment,PaymentIntent
markers=json.loads(sys.argv[1]); cleanup=sys.argv[2]=='true'
url=make_url(Settings().database_url.get_secret_value())
assert url.drivername=='postgresql+psycopg' and url.host in ('localhost','127.0.0.1','::1') and url.database=='salonpulse_dev' and url.username=='salonpulse_app' and url.port==5432
engine=create_engine(url,hide_parameters=True)
try:
 if cleanup:
  with engine.begin() as c:
   for marker in markers:
    ids=c.scalars(select(Business.id).where(Business.name==marker['name'])).all()
    assert len(ids)<=1
    for business_id in ids:
     assert c.scalars(select(User.email).where(User.business_id==business_id)).all()==[marker['email']]
     for model in (PaymentIntent,Payment,Appointment,Customer,Staff,Service,User): c.execute(delete(model).where(model.business_id==business_id))
     c.execute(delete(Business).where(Business.id==business_id,Business.name==marker['name']))
 with engine.connect() as c:
  print(json.dumps({model.__tablename__:sorted(str(value) for value in c.scalars(select(model.id))) for model in (Business,User,Customer,Staff,Service,Appointment,Payment,PaymentIntent)}))
finally: engine.dispose()
`;
  const result = spawnSync(resolve(backend, '.venv/Scripts/python.exe'), ['-B', '-c', code, JSON.stringify(markers), String(cleanup)], { cwd: backend, env: { ...process.env, DEBUG: 'false', PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Database safety/cleanup verification failed (private details suppressed)');
  return result.stdout.trim();
}

const baseline = database();
let socket;
let pageId;
let sequence = 0;
const pending = new Map();
const calls = [];
const traffic = [];
const responses = [];
let exceptions = 0;
let checks = 0;
let interception = null;
const check = (condition, label) => { if (!condition) throw new Error(label); checks++; };
async function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser command timeout: ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer, method }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error('Browser evaluation failed (private details suppressed)');
  return result.result.value;
}
async function wait(expression, label) {
  await waitForCondition(evaluate, expression, label);
}
async function route(hash) {
  await evaluate(`location.hash=${JSON.stringify(hash)}`);
  await wait(hash === 'register' ? '!!document.querySelector("input[name=business_name]")' : '!!document.querySelector(".auth-form") && !document.querySelector("input[name=business_name]")', 'auth route');
}
async function fill(values) {
  await evaluate(`(() => { const values=${JSON.stringify(values)}; for (const [name,value] of Object.entries(values)) { const input=document.querySelector('input[name="'+name+'"]'); input.value=value; input.dispatchEvent(new Event('input',{bubbles:true})); } })()`);
}
async function submit(values) { await fill(values); await evaluate('document.querySelector(".auth-form").requestSubmit()'); }
async function logout() { await evaluate('document.querySelector(".account-logout").click()'); await wait('!!document.querySelector(".auth-form")', 'logout'); }
async function login(account) {
  await route('login'); await submit({ email: account.email, password: account.password });
  await wait('!!document.querySelector(".app-shell")', 'login');
}

try {
  // Own a fresh tab rather than attaching to a prior test's navigating target.
  const response = await fetch(cdpOrigin + '/json/new?about:blank', { method: 'PUT' });
  if (!response.ok) throw new Error('Could not create a fresh verification tab');
  const page = await response.json(); pageId = page.id;
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const data = JSON.parse(event.data);
    if (data.id) {
      const request = pending.get(data.id);
      if (request) {
        clearTimeout(request.timer); pending.delete(data.id);
        if (data.error) {
          const error = new Error(`Browser command failed: ${request.method} (${data.error.code})`);
          error.navigationContextUnavailable = request.method === 'Runtime.evaluate' && data.error.code === -32000
            && /context|active page/i.test(data.error.message);
          request.reject(error);
        } else request.resolve(data.result);
      }
    } else if (data.method === 'Network.requestWillBeSent' && data.params.request.url.startsWith('http://127.0.0.1:8000/')) {
      calls.push(new URL(data.params.request.url).pathname);
      traffic.push({ path: new URL(data.params.request.url).pathname, method: data.params.request.method, offset: new URL(data.params.request.url).searchParams.get('offset') });
    } else if (data.method === 'Network.responseReceived' && data.params.response.url.startsWith('http://127.0.0.1:8000/')) {
      responses.push({ path: new URL(data.params.response.url).pathname, status: data.params.response.status });
    } else if (data.method === 'Runtime.exceptionThrown') exceptions++;
    else if (data.method === 'Fetch.requestPaused') {
      if (data.params.request.method === 'OPTIONS') {
        void command('Fetch.continueRequest', { requestId: data.params.requestId });
        return;
      }
      if (interception) { void interception(data.params); return; }
      const response = JSON.stringify({ detail: 'Not authenticated' });
      void command('Fetch.fulfillRequest', { requestId: data.params.requestId, responseCode: 401, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: 'http://127.0.0.1:5173' }, { name: 'WWW-Authenticate', value: 'Bearer' }], body: Buffer.from(response).toString('base64') });
    }
  };
  await command('Runtime.enable'); await command('Page.enable'); await command('Network.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1365, height: 900, deviceScaleFactor: 1, mobile: false });
  const navigation = await command('Page.navigate', { url: 'http://127.0.0.1:5173/#customers' });
  if (navigation.errorText) throw new Error('Frontend navigation failed: ' + navigation.errorText);
  // Reloading immediately after navigate races Chrome's active-page swap.
  await wait('location.origin==="http://127.0.0.1:5173" && document.readyState!=="loading" && !!document.querySelector(".auth-form")', 'protected route');
  check(await evaluate('location.hash==="#login" && !document.querySelector(".app-shell")'), 'Protected route exposed workspace');
  await evaluate('localStorage.setItem("salonpulse.demo.v4", JSON.stringify({customers:[{name:"LEGACY PRIVATE CUSTOMER"}]}))');

  if (process.argv.includes('--analytics')) {
    const { verifyAnalytics } = await import('./browser-analytics.mjs');
    await verifyAnalytics({ accounts, command, evaluate, wait, route, submit, logout, login, check });
    check(exceptions === 0, 'Browser runtime exceptions');
    console.log(`PASS: ${checks} live analytics browser checks.`);
  } else if (process.argv.includes('--payments')) {
    const { verifyPayments } = await import('./browser-payments.mjs');
    await verifyPayments({ accounts, command, evaluate, wait, route, submit, logout, login, check, socket, setInterceptor: value => { interception = value; } });
    check(exceptions === 0, 'Browser runtime exceptions');
    console.log(`PASS: ${checks} live payment browser checks.`);
  } else if (process.argv.includes('--dashboard')) {
    const { verifyDashboard } = await import('./browser-dashboard.mjs');
    await verifyDashboard({ accounts, command, evaluate, wait, route, submit, logout, login, check, socket, traffic });
    check(exceptions === 0, 'Browser runtime exceptions');
    console.log(`PASS: ${checks} live dashboard browser checks.`);
  } else if (process.argv.includes('--appointments')) {
    const { verifyAppointments } = await import('./browser-appointments.mjs');
    await verifyAppointments({ accounts, command, evaluate, wait, route, submit, logout, login, check, socket, calls, traffic, cdpOrigin });
    check(exceptions === 0, 'Browser runtime exceptions');
    console.log(`PASS: ${checks} live appointment browser checks.`);
  } else if (process.argv.includes('--crud')) {
    const { verifyCrud } = await import('./browser-crud.mjs');
    await verifyCrud({ accounts, command, evaluate, wait, route, submit, logout, login, check, socket, calls, traffic, cdpOrigin });
    check(exceptions === 0, 'Browser runtime exceptions');
    console.log(`PASS: ${checks} live CRUD browser checks.`);
  } else {
  await route('register');
  await submit({ ...accounts[0], email: 'invalid@localhost' });
  await wait('!!document.querySelector("input[name=email][aria-invalid=true]")', 'inline backend validation');
  check(await evaluate('!!document.querySelector("#email-error") && !document.querySelector(".app-shell")'), 'Inline 422 errors missing');
  await command('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: -1, uploadThroughput: -1 });
  await submit(accounts[0]);
  await wait('document.querySelector("fieldset")?.disabled===true', 'loading state');
  check(await evaluate('document.querySelector(".auth-form").getAttribute("aria-busy")==="true"'), 'Loading state missing');
  await wait('!!document.querySelector(".app-shell")', 'registration');
  await command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  check(await evaluate(`document.querySelector('.workspace strong').textContent===${JSON.stringify(accounts[0].business_name)}`), 'Business profile mismatch');
  check(await evaluate('!document.body.textContent.includes("LEGACY PRIVATE CUSTOMER") && !document.body.textContent.includes("Ahmed Raza")'), 'Legacy demo identity leaked');
  check(calls.includes('/api/auth/me') && calls.includes('/api/business/me'), 'Profile endpoints not loaded');
  await evaluate('location.hash="customers"'); await wait('!!document.querySelector(".customer-page")', 'customer navigation');
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="Add customer").click()');
  await evaluate('(() => { const input=document.querySelector(".customer-editor input"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"SESSION A PRIVATE CUSTOMER"); input.dispatchEvent(new Event("input",{bubbles:true})); })()');
  await evaluate('document.querySelector(".customer-editor").requestSubmit()');
  await wait('document.body.textContent.includes("SESSION A PRIVATE CUSTOMER")', 'demo customer creation');
  check(await evaluate(`(()=>{const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;return sessionStorage.length===0 && Object.keys(localStorage).every(key=>{if(key==='salonpulse.demo.v4')return true;const parts=key.split(':');if(parts.length!==4||parts[0]!=='salonpulse.payment-recovery.v1'||!parts.slice(1).every(id=>uuid.test(id)))return false;const value=JSON.parse(localStorage.getItem(key));return Object.keys(value).join(',')==='intent_id'&&uuid.test(value.intent_id);});})()`), 'Session data, tokens or sensitive payment data persisted');
  await logout();
  await route('register'); await submit(accounts[1]); await wait('!!document.querySelector(".app-shell")', 'second registration');
  check(await evaluate(`document.querySelector('.workspace strong').textContent===${JSON.stringify(accounts[1].business_name)} && !document.body.textContent.includes('SESSION A PRIVATE CUSTOMER')`), 'Previous tenant leaked into second account');
  await command('Page.reload'); await wait('!!document.querySelector(".auth-form")', 'refresh requires login');
  check(await evaluate('!document.querySelector(".app-shell")'), 'Session survived refresh');
  await submit({ email: accounts[1].email, password: 'incorrect-only' });
  await wait('!!document.querySelector("[role=alert]")', 'invalid credentials');
  check(await evaluate('document.querySelector("[role=alert]").textContent.includes("incorrect") && document.querySelector("input[name=password]").value===""'), 'Invalid credential handling');
  await route('register'); await submit(accounts[1]); await wait('!!document.querySelector("[role=alert]")', 'duplicate registration');
  check(await evaluate('document.querySelector("[role=alert]").textContent.includes("already registered")'), 'Duplicate registration handling');
  await login(accounts[0]);
  await evaluate('location.hash="customers"'); await wait('!!document.querySelector(".customer-page")', 'persisted directory');
  check(await evaluate('document.body.textContent.includes("SESSION A PRIVATE CUSTOMER")'), 'Saved customer did not persist across login');
  await evaluate('window.__originalNow=Date.now; Date.now=()=>window.__originalNow()+31*60*1000; window.dispatchEvent(new Event("focus"))');
  await wait('!!document.querySelector(".auth-form")', 'expiry logout');
  check(await evaluate('document.body.textContent.includes("expired")'), 'Expiry message missing');
  await evaluate('Date.now=window.__originalNow; delete window.__originalNow');
  await command('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await submit({ email: accounts[0].email, password: accounts[0].password });
  await wait('!!document.querySelector("[role=alert]")', 'network error');
  check(await evaluate('document.querySelector("[role=alert]").textContent.includes("Cannot reach")'), 'Network error missing');
  await command('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await command('Fetch.enable', { patterns: [{ urlPattern: '*:8000/api/auth/me', requestStage: 'Request' }] });
  await submit({ email: accounts[0].email, password: accounts[0].password });
  await wait('document.body.textContent.includes("session has ended")', 'authenticated 401');
  check(await evaluate('!document.querySelector(".app-shell")'), '401 did not clear auth');
  await command('Fetch.disable'); await login(accounts[0]);
  const desktop = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(tmpdir(), 'salonpulse-auth-desktop.png'), Buffer.from(desktop.data, 'base64'));
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evaluate('document.querySelector(".mobile-menu").click()');
  await wait('document.querySelector(".sidebar").classList.contains("sidebar-open")', 'mobile navigation');
  check(await evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Mobile horizontal overflow');
  await logout(); await route('register');
  const mobile = await command('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(tmpdir(), 'salonpulse-auth-mobile.png'), Buffer.from(mobile.data, 'base64'));
  check(await evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Mobile auth horizontal overflow');
  check(calls.every(path => ['/api/auth/register','/api/auth/login','/api/auth/me','/api/business/me','/api/customers','/api/staff','/api/services','/api/appointments','/api/analytics/revenue'].includes(path)), 'Unexpected business-resource API calls');
  check(exceptions === 0, 'Browser runtime exceptions');
  console.log(`PASS: ${checks} live browser checks; desktop/mobile, registration, login, logout, refresh, expiry, 401, network errors, duplicates and tenant/demo isolation.`);
  }
} catch (error) {
  // Never dump browser protocol data, requests, passwords or tokens.
  console.error('FAIL:', error instanceof Error ? error.message : 'Browser verification failed'); process.exitCode = 1;
  if (socket?.readyState === WebSocket.OPEN) {
    try {
      const state = await evaluate(`JSON.stringify({route:location.hash, editorOpen:!!document.querySelector('.customer-edit-panel'), alerts:[...document.querySelectorAll('main [role=alert]')].map(item=>item.textContent), statuses:[...document.querySelectorAll('article.customer-card .status')].map(item=>item.textContent), loading:document.querySelector('.directory-toolbar button')?.disabled})`);
      console.error('Safe UI diagnostics:', state);
    } catch { console.error('UI diagnostics unavailable during navigation.'); }
  }
  console.error('HTTP status diagnostics:', JSON.stringify(responses.slice(-30)));
} finally {
  socket?.close();
  for (const request of pending.values()) clearTimeout(request.timer);
  if (pageId) await fetch(cdpOrigin + '/json/close/' + pageId);
  const after = database(true);
  if (after !== baseline) { console.error('FAIL: Database baseline mismatch after cleanup'); process.exitCode = 1; }
  else console.log('PASS: Temporary businesses/accounts cleaned up; all eight tables restored to baseline.');
}
