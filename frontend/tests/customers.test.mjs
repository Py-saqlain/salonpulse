import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
// Strip types using Node 24; no additional test packages are required.
const directory = mkdtempSync(join(tmpdir(), 'salonpulse-tests-'));
let data, customers;
try {
  for (const name of ['customers', 'data']) {
    const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
    const output = stripTypeScriptTypes(source).replaceAll("'./customers'", "'./customers.mjs'");
    writeFileSync(join(directory, `${name}.mjs`), output);
  }
  customers = await import(pathToFileURL(join(directory, 'customers.mjs')));
  data = await import(pathToFileURL(join(directory, 'data.mjs')));
} finally { rmSync(directory, { recursive: true, force: true }); }
const { normalizePhone, validateCustomer, createCustomer, customerHistory, seedCustomers } = customers;
const { makeAppointment, validateBooking, loadStore, STORAGE_KEY } = data;
function storage(entries = {}) {
  const map = new Map(Object.entries(entries));
  globalThis.localStorage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
  return map;
}
const input = { name: '  New Customer  ', phone: '0300 1234567', notes: '  Prefers afternoon  ' };
const booking = { customerId: 'customer-0', service: 'Signature haircut & beard', staff: 'Ali Raza', date: '2027-01-02', time: '10:00' };
const now = Date.parse('2027-01-01T00:00:00Z');
test('normalizes national and international Pakistani mobiles', () => {
  for (const number of ['03001234567', '0300 123-4567', '+92 (300) 1234567', '923001234567', '00923001234567']) assert.equal(normalizePhone(number), '+923001234567');
  assert.equal(normalizePhone('  '), '');
  for (const number of ['+1 3001234567', '0300123', '04212345678', 'abc', '+9203001234567', '---']) assert.equal(normalizePhone(number), null);
});
test('requires names and validates optional phones', () => {
  assert.ok(validateCustomer({ ...input, name: '  ' }, []));
  assert.ok(validateCustomer({ ...input, phone: 'invalid' }, []));
  assert.equal(validateCustomer({ ...input, phone: '' }, []), null);
});
test('creation trims fields, normalizes phone, and assigns stable IDs', () => {
  const customer = createCustomer(input, []);
  assert.ok(customer.id); assert.equal(customer.name, 'New Customer'); assert.equal(customer.notes, 'Prefers afternoon'); assert.equal(customer.phone, '+923001234567');
});
test('prevents normalized phone duplicates but permits editing own phone and duplicate names', () => {
  const customer = createCustomer(input, []);
  assert.ok(validateCustomer({ ...input, phone: '+923001234567' }, [customer]));
  assert.equal(validateCustomer(input, [customer], customer.id), null);
  assert.throws(() => createCustomer(input, [customer]));
  assert.equal(validateCustomer({ ...input, phone: '' }, [customer]), null);
});
test('history uses stable IDs after renames and counts only completed visits', () => {
  const original = makeAppointment(booking);
  const rows = [{ ...original, status: 'Completed' }, { ...original, id: 'second', date: '2027-01-03', status: 'Completed' }, { ...original, id: 'cancelled', date: '2027-01-04', status: 'Cancelled' }, { ...original, id: 'other', customerId: 'customer-1' }];
  const renamed = { ...seedCustomers[0], name: 'Renamed Customer' };
  const result = customerHistory(renamed.id, rows);
  assert.equal(result.history.length, 3); assert.equal(result.completedVisits, 2); assert.equal(result.lastCompleted.id, 'second');
  assert.equal(customerHistory('missing', rows).completedVisits, 0);
});
test('preserves booking overlap and edit rules, including cancellations and midnight', () => {
  const original = makeAppointment(booking);
  assert.equal(validateBooking(booking, [original], now, original.id), null);
  assert.ok(validateBooking(booking, [original], now));
  assert.equal(validateBooking(booking, [{ ...original, status: 'Cancelled' }], now), null);
  assert.equal(validateBooking({ ...booking, time: '10:45' }, [original], now), null);
  assert.ok(validateBooking({ ...booking, date: '2026-01-01' }, [], now));
  const night = makeAppointment({ ...booking, time: '23:45' });
  assert.ok(validateBooking({ ...booking, date: '2027-01-03', time: '00:00' }, [night], now));
  assert.ok(validateBooking({ ...booking, customerId: 'missing' }, [], now));
});
test('new customers are accepted for bookings from shared directory', () => {
  const customer = createCustomer(input, []);
  const directory = [...seedCustomers, customer];
  const next = { ...booking, customerId: customer.id, bookingType: 'Walk-in' };
  assert.equal(validateBooking(next, [], now, undefined, directory), null);
  assert.equal(makeAppointment(next, directory).customerId, customer.id);
});
test('migrates legacy bookings to IDs without losing history and persists stable migration', () => {
  const item = makeAppointment(booking); delete item.customerId;
  const map = storage({ 'salonpulse.appointments.v1': JSON.stringify([item]) });
  const loaded = loadStore(); assert.equal(loaded.warning, '');
  assert.equal(loaded.store.appointments[0].customerId, seedCustomers[0].id);
  assert.ok(map.has('salonpulse.appointments.v1')); assert.ok(map.has(STORAGE_KEY));
  assert.deepEqual(loadStore().store, loaded.store);
});
test('round-trips customer edits and completed/cancelled history in one store', () => {
  const item = makeAppointment(booking);
  const store = { customers: seedCustomers.map(c => c.id === item.customerId ? { ...c, name: 'Renamed' } : c), appointments: [{ ...item, status: 'Cancelled' }] };
  storage({ [STORAGE_KEY]: JSON.stringify(store) });
  assert.deepEqual(loadStore().store, store);
});
test('reports corrupt or blocked storage', () => {
  storage({ [STORAGE_KEY]: '{broken' }); assert.ok(loadStore().warning);
  globalThis.localStorage = { getItem() { throw Error('blocked'); } }; assert.ok(loadStore().warning);
});
