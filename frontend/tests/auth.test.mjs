import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const directory = mkdtempSync(join(tmpdir(), 'salonpulse-auth-'));
let api, session;
try {
  for (const name of ['api', 'session']) writeFileSync(join(directory, `${name}.mjs`), stripTypeScriptTypes(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')));
  api = await import(pathToFileURL(join(directory, 'api.mjs')));
  session = await import(pathToFileURL(join(directory, 'session.mjs')));
} finally { rmSync(directory, { recursive: true, force: true }); }

test('API base URL is configurable and rejects credentials or unsafe protocols', () => {
  assert.equal(api.apiBaseUrl('https://api.example.com/v1/'), 'https://api.example.com/v1');
  for (const value of ['javascript:alert(1)', 'https://user:private@example.com', 'http://example.com?key=private', 'bad-url']) assert.throws(() => api.apiBaseUrl(value));
});

test('native fetch keeps the browser global receiver rather than the API client', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async function () {
    assert.equal(this, globalThis);
    return Response.json({ ok: true });
  };
  try { assert.deepEqual(await new api.ApiClient('http://localhost:8000').me(), { ok: true }); }
  finally { globalThis.fetch = original; }
});

test('JSON authentication uses public requests without tokens or browser credentials', async () => {
  const calls = [];
  const client = new api.ApiClient('http://localhost:8000/', { token: () => 'in-memory-placeholder', fetcher: async (url, options) => {
    calls.push({ url, options }); return Response.json({ access_token: 'placeholder', token_type: 'bearer' });
  } });
  await client.login({ email: 'owner@example.com', password: 'placeholder-only', full_name: 'Owner', business_name: 'Salon' });
  await client.register({ email: 'owner@example.com', password: 'placeholder-only', full_name: 'Owner', business_name: 'Salon', role: 'staff', business_id: 'untrusted' });
  for (const { options } of calls) {
    assert.equal(options.headers.has('Authorization'), false);
    assert.equal(options.headers.get('Content-Type'), 'application/json');
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store'); assert.equal(options.redirect, 'error');
  }
  assert.equal(calls[0].url, 'http://localhost:8000/api/auth/login');
  assert.deepEqual(Object.keys(JSON.parse(calls[0].options.body)).sort(), ['email', 'password']);
  assert.deepEqual(Object.keys(JSON.parse(calls[1].options.body)).sort(), ['business_name', 'email', 'full_name', 'password']);
});

test('profile requests use the current in-memory token and support 204 responses', async () => {
  let token = 'first'; const seen = [];
  const client = new api.ApiClient('http://localhost:8000', { token: () => token, fetcher: async (_, options) => {
    seen.push(options.headers.get('Authorization')); return new Response(null, { status: 204 });
  } });
  assert.equal(await client.me(), undefined); token = 'second'; await client.business();
  assert.deepEqual(seen, ['Bearer first', 'Bearer second']);
  await assert.rejects(client.request('https://foreign.example/api/me'));
  await assert.rejects(client.request('/api/../other'));
});

test('protected 401 notifies session owner; incorrect login does not expire another session', async () => {
  const rejected = [];
  const client = new api.ApiClient('http://localhost:8000', { token: () => 'current', unauthorized: token => rejected.push(token), fetcher: async () => Response.json({ detail: 'Invalid credentials' }, { status: 401 }) });
  await assert.rejects(client.me(), error => error instanceof api.ApiError && error.status === 401);
  await assert.rejects(client.login({ email: 'x@example.com', password: 'wrong' }), /Email or password is incorrect/);
  assert.deepEqual(rejected, ['current']);
});

test('safe validation and duplicate errors retain actionable fields without submitted inputs', async () => {
  const client = new api.ApiClient('http://localhost:8000', { fetcher: async () => Response.json({ detail: [{ loc: ['body', 'email'], msg: 'Enter a valid email', type: 'value_error' }] }, { status: 422 }) });
  await assert.rejects(client.me(), error => error.status === 422 && error.fields.email === 'Enter a valid email');
  const duplicate = new api.ApiClient('http://localhost:8000', { fetcher: async () => Response.json({ detail: 'Email already registered' }, { status: 409 }) });
  await assert.rejects(duplicate.me(), /Email already registered/);
});

test('network and server errors are sanitized; unreadable JSON is handled', async () => {
  for (const [fetcher, message] of [
    [async () => { throw new Error('private network details'); }, /Cannot reach SalonPulse/],
    [async () => Response.json({ detail: 'private server details' }, { status: 503 }), /temporarily unavailable/],
    [async () => new Response('not json'), /unreadable response/],
  ]) {
    const client = new api.ApiClient('http://localhost:8000', { fetcher });
    await assert.rejects(client.me(), error => message.test(error.message) && !error.message.includes('private'));
  }
});

test('expiry requires a finite expiration claim and identity must match the business', () => {
  const token = 'header.' + btoa(JSON.stringify({ exp: 2000000000 })) + '.signature';
  assert.equal(session.tokenExpiresAt(token), 2000000000000);
  for (const value of ['bad', 'x.' + btoa('{}') + '.y', 'x.' + btoa('{"exp":"tomorrow"}') + '.y']) assert.throws(() => session.tokenExpiresAt(value));
  const user = { id: 'user', business_id: 'business', role: 'owner', is_active: true };
  session.checkIdentity(user, { id: 'business' });
  for (const changed of [{ business_id: 'other' }, { role: 'admin' }, { is_active: false }]) assert.throws(() => session.checkIdentity({ ...user, ...changed }, { id: 'business' }));
});

test('production frontend contains no legacy business storage or sample directories', () => {
  const root = new URL('../src/', import.meta.url);
  for (const name of readdirSync(root).filter(name => /\.tsx?$/.test(name))) {
    const source = readFileSync(new URL(name, root), 'utf8');
    assert.doesNotMatch(source, /\b(localStorage|sessionStorage|seedCustomers|seedStaff|seedServices|seedAppointments|loadStore|STORAGE_KEY|DemoStore)\b/, name);
  }
});
