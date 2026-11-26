// Preserve domain coverage after retiring demo constructors/storage migrations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
const directory = mkdtempSync(join(tmpdir(), 'salonpulse-api-regressions-'));
const names = ['api', 'customers', 'staff', 'services', 'appointments', 'catalog', 'data'];
const modules = {};
try {
  for (const name of names) {
    let code = stripTypeScriptTypes(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'));
    for (const dependency of names) code = code.replaceAll(`'./${dependency}'`, `'./${dependency}.mjs'`);
    writeFileSync(join(directory, name + '.mjs'), code);
  }
  for (const name of names) modules[name] = await import(pathToFileURL(join(directory, name + '.mjs')));
} finally { rmSync(directory, { recursive: true, force: true }); }
const { catalog, customers, staff, services, appointments, api, data } = modules;
const id = n => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const business = id(999), record = { id: id(1), business_id: business, name: 'Record', phone: null, notes: null, specialty: null, active: true, hours: null, category: null, description: '', duration_minutes: 30, price: '1250.25' };
const resources = { customers: [catalog.customerFromAPI(record)], staff: [{ ...catalog.staffFromAPI(record), hours: Array.from({ length: 7 }, (_, day) => ({ day, start: '09:00', end: '18:00' })) }], services: [catalog.serviceFromAPI(record)], appointments: [] };
const input = { customerId: id(1), staffId: id(1), serviceId: id(1), date: '2030-01-02', time: '10:00' };
const dto = { ...record, customer_id: id(1), staff_id: id(1), service_id: id(1), starts_at: '2030-01-02T05:00:00Z', ends_at: '2030-01-02T05:30:00Z', status: 'confirmed', booking_type: 'scheduled', booked_price: '900.50', booked_duration_minutes: 30 };
const original = () => appointments.appointmentFromAPI(dto, resources, 'Asia/Karachi');
const now = Date.parse('2030-01-01T00:00Z');
const validate = (changes = {}, records = resources, previous) => appointments.validateAppointment({ ...input, ...changes }, records, 'Asia/Karachi', previous, now);

test('customer payload trims fields and normalizes phone without assigning a client ID', () => {
  const body = catalog.customerToAPI({ name: ' Customer ', phone: '0300 8672095', notes: ' Note ' });
  assert.equal(body.name, 'Customer'); assert.equal(body.phone, '+923008672095'); assert.equal(body.notes, 'Note'); assert.equal('id' in body, false);
});
test('customer response retains server identity after a rename', () => { assert.equal(catalog.customerFromAPI({ ...record, name: 'Renamed' }).id, record.id); });
test('blank customer optional fields clear to null and name remains required', () => {
  assert.equal(catalog.customerToAPI({ name: 'Customer', phone: '', notes: ' ' }).notes, null);
  assert.ok(customers.validateCustomer({ name: ' ', phone: '', notes: '' }, []));
});
test('staff payload retains configured working days and clears blank optional fields', () => {
  const body = catalog.staffToAPI({ ...resources.staff[0], specialty: ' ', phone: '' });
  assert.deepEqual(body.hours, resources.staff[0].hours); assert.equal(body.specialty, null); assert.equal(body.phone, null);
});
test('inactive staff records retain stable server IDs', () => { assert.deepEqual(catalog.staffFromAPI({ ...record, active: false }).id, record.id); });
test('staff phone duplicate checks permit editing the same stable ID', () => {
  const member = { ...resources.staff[0], phone: '+923008672095' };
  assert.ok(staff.validateStaff({ ...member, phone: '03008672095' }, [member]));
  assert.equal(staff.validateStaff(member, [member], member.id), null);
});
test('working hours reject malformed times and duplicate weekdays', () => {
  for (const hours of [[{ day: 1, start: '24:00', end: '25:00' }], [{ day: 1, start: '10:00', end: '10:00' }], [resources.staff[0].hours[0], resources.staff[0].hours[0]]]) assert.ok(staff.validateStaff({ ...resources.staff[0], hours }, []));
});
test('service payload serializes zero and maximum prices exactly', () => {
  for (const [price, expected] of [[0, '0.00'], [9999999999.99, '9999999999.99']]) assert.equal(catalog.serviceToAPI({ ...resources.services[0], price }).price, expected);
});
test('inactive services cannot receive new bookings or reschedules', () => {
  const records = { ...resources, services: [{ ...resources.services[0], active: false }] };
  assert.match(validate({}, records), /active/); assert.match(validate({}, records, original()), /active/);
});
test('catalog price and duration edits preserve existing booked terms', () => {
  const records = { ...resources, services: [{ ...resources.services[0], price: 7000, minutes: 90 }] };
  assert.deepEqual(services.bookingService(input, records.services, original()), { name: 'Record', minutes: 30, price: 900.5 });
});
test('changing service requires acknowledgement of current catalog terms', () => {
  const records = { ...resources, services: [...resources.services, { ...resources.services[0], id: id(2) }] };
  assert.match(validate({ serviceId: id(2) }, records, original()), /Confirm/);
  assert.equal(validate({ serviceId: id(2), recalculateService: true }, records, original()), null);
});
test('service can end exactly at shift close but cannot overrun it', () => { assert.equal(validate({ time: '17:30' }), null); assert.match(validate({ time: '17:31' }), /entire service/); });
test('adjacent slots are allowed while partial overlap is rejected', () => {
  const records = { ...resources, appointments: [original()] };
  assert.equal(validate({ time: '10:30' }, records), null); assert.match(validate({ time: '10:15' }, records), /overlapping/);
});
test('cancelled and completed records stay in history without blocking slots', () => {
  for (const status of ['Cancelled', 'Completed']) assert.equal(validate({}, { ...resources, appointments: [{ ...original(), status }] }), null);
});
test('renaming staff does not bypass an existing staff-ID conflict', () => {
  assert.match(validate({}, { ...resources, staff: [{ ...resources.staff[0], name: 'Renamed' }], appointments: [original()] }), /overlapping/);
});
test('deactivating assigned staff requires reassignment when editing', () => {
  assert.match(validate({}, { ...resources, staff: [{ ...resources.staff[0], active: false }] }, original()), /active/);
});
test('explicit duration recalculation rechecks conflicts against saved intervals', () => {
  const records = { ...resources, services: [{ ...resources.services[0], minutes: 90 }], appointments: [{ ...original(), id: id(2), startUTC: '2030-01-02T06:00:00Z', endUTC: '2030-01-02T06:30:00Z' }] };
  assert.equal(validate({}, records, original()), null); assert.match(validate({ recalculateService: true }, records, original()), /overlapping/);
});
test('renamed service displays current name but retains historical money and duration', () => {
  const view = appointments.appointmentFromAPI(dto, { ...resources, services: [{ ...resources.services[0], name: 'Renamed', price: 9000, minutes: 120 }] }, 'Asia/Karachi');
  assert.equal(view.service, 'Renamed'); assert.equal(view.price, 900.5); assert.equal(view.minutes, 30);
});
test('all tenant-owned resource DTOs reject a different business', () => {
  for (const resource of [record, { ...record, hours: null }, dto]) assert.throws(() => catalog.checkRecord({ ...resource, business_id: id(998) }, business));
});
test('catalog pagination resolves booking references beyond the first customer and staff pages', async () => {
  const request = async path => {
    const url = new URL(path, 'http://localhost'), resource = url.pathname.split('/').at(-1), offset = Number(url.searchParams.get('offset'));
    const rows = resource === 'appointments' ? [{ ...dto, customer_id: id(101), staff_id: id(101) }] : resource === 'services' ? [record] : Array.from({ length: 101 }, (_, i) => ({ ...record, id: id(i + 1) }));
    return { items: rows.slice(offset, offset + 100), total: rows.length, limit: 100, offset };
  };
  const result = await catalog.readCatalog({ request }, business, new AbortController().signal, 'Asia/Karachi');
  assert.equal(result.customers.length, 101); assert.equal(result.staff.length, 101); assert.equal(result.appointments[0].customerId, id(101));
});
test('changing directory totals during pagination fails safely', async () => {
  let requests = 0;
  await assert.rejects(catalog.readAll({ request: async () => ({ items: requests++ ? [] : [record], total: requests === 1 ? 2 : 3, limit: 100, offset: requests - 1 }) }, 'customers', business, new AbortController().signal), /changed/);
});
test('already-aborted reads never send API requests', async () => {
  const controller = new AbortController(); controller.abort(); let sent = false;
  await assert.rejects(catalog.readAll({ request: () => { sent = true; } }, 'customers', business, controller.signal)); assert.equal(sent, false);
});
test('duplicate write responses retain safe conflict status and message', async () => {
  const client = new api.ApiClient('http://localhost:8000', { fetcher: async () => Response.json({ detail: 'Active service name already exists' }, { status: 409 }) });
  await assert.rejects(client.request('/api/services', { method: 'POST', body: catalog.serviceToAPI(resources.services[0]) }), error => error.status === 409 && /already exists/.test(error.message));
});
test('UTC formatting ignores stale cached wall-clock fields', () => { const view = { ...original(), date: '1999-01-01', time: '00:00' }; assert.equal(data.startsAt(view), Date.parse(dto.starts_at)); });
test('API catalog reloads preserve stable references without touching browser storage', async () => {
  globalThis.localStorage = { getItem() { throw Error('Forbidden storage access'); }, setItem() { throw Error('Forbidden storage access'); } };
  try {
    const request = async path => { const resource = path.split('?')[0].split('/').at(-1); return { items: [resource === 'appointments' ? dto : record], total: 1, offset: 0, limit: 100 }; };
    const first = await catalog.readCatalog({ request }, business, new AbortController().signal, 'Asia/Karachi');
    const second = await catalog.readCatalog({ request }, business, new AbortController().signal, 'Asia/Karachi');
    assert.deepEqual(first, second); assert.equal(first.appointments[0].customerId, first.customers[0].id);
  } finally { delete globalThis.localStorage; }
});
