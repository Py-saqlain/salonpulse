import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const directory = mkdtempSync(join(tmpdir(), 'salonpulse-catalog-'));
let domain, ApiClient, ApiError;
try {
  for (const name of ['api', 'customers', 'catalog']) {
    const code = stripTypeScriptTypes(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')).replaceAll("'./api'", "'./api.mjs'").replaceAll("'./customers'", "'./customers.mjs'");
    writeFileSync(join(directory, name + '.mjs'), code);
  }
  domain = await import(pathToFileURL(join(directory, 'catalog.mjs')));
  ({ ApiClient, ApiError } = await import(pathToFileURL(join(directory, 'api.mjs'))));
} finally { rmSync(directory, { recursive: true, force: true }); }

const business = '11111111-1111-4111-8111-111111111111';
const row = index => ({ id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`, business_id: business, name: 'Customer ' + index, phone: null, notes: null });

test('catalog adapters preserve server UUIDs and normalize nullable fields', () => {
  assert.deepEqual(domain.customerFromAPI(row(1)), { id: row(1).id, name: 'Customer 1', phone: '', notes: '' });
  assert.deepEqual(domain.customerToAPI({ name: ' Ali ', phone: '0300 1234567', notes: ' ' }), { name: 'Ali', phone: '+923001234567', notes: null });
  assert.equal(domain.staffFromAPI({ ...row(2), specialty: null, hours: null, active: false }).hours, null);
  assert.deepEqual(domain.staffToAPI({ name: 'Barber', phone: '', specialty: '', active: true, hours: [{ day: 0, start: '09:00', end: '18:00' }] }).hours, [{ day: 0, start: '09:00', end: '18:00' }]);
  assert.throws(() => domain.checkRecord({ ...row(1), business_id: 'another' }, business));
  assert.throws(() => domain.checkRecord({ ...row(1), id: 'seed-1' }, business));
});

test('service adapters map duration and exact decimal strings without tenant/identity input', () => {
  const service = domain.serviceFromAPI({ ...row(3), category: null, description: 'Trim', duration_minutes: 45, price: '1250.50', active: true });
  assert.equal(service.minutes, 45); assert.equal(service.price, 1250.5); assert.equal(service.category, '');
  const body = domain.serviceToAPI(service);
  assert.equal(body.price, '1250.50'); assert.equal(body.duration_minutes, 45); assert.equal(body.description, 'Trim');
  assert.equal('id' in body || 'business_id' in body || 'minutes' in body, false);
  assert.equal(domain.serviceToAPI({ ...service, price: 9999999999.99 }).price, '9999999999.99');
  for (const price of ['NaN', '-1.00', '12.345', '10000000000.00']) assert.throws(() => domain.serviceFromAPI({ ...row(3), price }));
});

test('all backend pages are loaded so search and selectors include records beyond page one', async () => {
  const requests = [];
  const client = new ApiClient('http://localhost:8000', { fetcher: async url => {
    const offset = Number(new URL(url).searchParams.get('offset')); requests.push(offset);
    return Response.json({ items: Array.from({ length: Math.min(100, 205 - offset) }, (_, index) => row(offset + index)), total: 205, limit: 100, offset });
  } });
  const records = await domain.readAll(client, 'customers', business, new AbortController().signal);
  assert.equal(records.length, 205); assert.equal(records[204].name, 'Customer 204'); assert.deepEqual(requests, [0, 100, 200]);
});

test('pagination rejects foreign tenants, duplicate IDs and incomplete/changing pages', async () => {
  for (const page of [
    { items: [{ ...row(1), business_id: 'foreign' }], total: 1 },
    { items: [row(1), row(1)], total: 2 },
    { items: [], total: 1 },
    { items: [row(1)], total: 0 },
  ]) {
    const client = new ApiClient('http://localhost:8000', { fetcher: async () => Response.json({ limit: 100, offset: 0, ...page }) });
    await assert.rejects(domain.readAll(client, 'customers', business, new AbortController().signal));
  }
});

test('cancelled session reads cannot return old tenant data', async () => {
  const abort = new AbortController();
  const client = new ApiClient('http://localhost:8000', { fetcher: async () => {
    abort.abort(); return Response.json({ items: [row(1)], total: 1, limit: 100, offset: 0 });
  } });
  await assert.rejects(domain.readAll(client, 'customers', business, abort.signal), /cancelled/);
});

test('only the explicit upcoming-booking conflict triggers deactivation confirmation', () => {
  assert.equal(domain.requiresDeactivationConfirmation(new ApiError(409, 'send confirm_upcoming=true')), true);
  assert.equal(domain.requiresDeactivationConfirmation(new ApiError(409, 'Working-hours change conflicts')), false);
  assert.equal(domain.requiresDeactivationConfirmation(new ApiError(403, 'Forbidden')), false);
  assert.match(domain.resourceError(new ApiError(422, 'Invalid', { phone: 'Enter a valid phone' })), /phone: Enter a valid phone/);
});
