import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
// Strip types using Node 24; no additional test packages are required.
const directory = mkdtempSync(join(tmpdir(), 'salonpulse-tests-'));
let data, customers, staffDomain;
try {
  for (const name of ['customers', 'staff', 'data']) {
    const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
    const output = stripTypeScriptTypes(source).replaceAll("'./customers'", "'./customers.mjs'").replaceAll("'./staff'", "'./staff.mjs'");
    writeFileSync(join(directory, `${name}.mjs`), output);
  }
  customers = await import(pathToFileURL(join(directory, 'customers.mjs')));
  staffDomain = await import(pathToFileURL(join(directory, 'staff.mjs')));
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
const booking = { customerId: 'customer-0', service: 'Signature haircut & beard', staffId: 'staff-0', date: '2027-01-02', time: '10:00' };
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
  const item = makeAppointment(booking); delete item.customerId; delete item.staffId;
  const map = storage({ 'salonpulse.appointments.v1': JSON.stringify([item]) });
  const loaded = loadStore(); assert.equal(loaded.warning, '');
  assert.equal(loaded.store.appointments[0].customerId, seedCustomers[0].id);
  assert.ok(map.has('salonpulse.appointments.v1')); assert.ok(map.has(STORAGE_KEY));
  assert.deepEqual(loadStore().store, loaded.store);
});
test('round-trips customer edits and completed/cancelled history in one store', () => {
  const item = makeAppointment(booking);
  const store = { staff: staffDomain.seedStaff, customers: seedCustomers.map(c => c.id === item.customerId ? { ...c, name: 'Renamed' } : c), appointments: [{ ...item, status: 'Cancelled' }] };
  storage({ [STORAGE_KEY]: JSON.stringify(store) });
  assert.deepEqual(loadStore().store, store);
});
test('reports corrupt or blocked storage', () => {
  storage({ [STORAGE_KEY]: '{broken' }); assert.ok(loadStore().warning);
  globalThis.localStorage = { getItem() { throw Error('blocked'); } }; assert.ok(loadStore().warning);
});
const { seedStaff, validateStaff, makeStaff, availabilityError, upcomingStaffBookings } = staffDomain;
const staffInput = { name: ' New Barber ', phone: '03001234567', specialty: ' Barber ', active: true, hours: null };
test('staff validates names, normalized mobiles, duplicates and stable edits', () => {
  assert.ok(validateStaff({ ...staffInput, name: '' }, []));
  assert.ok(validateStaff({ ...staffInput, phone: '04212345678' }, []));
  const member = makeStaff(staffInput, []);
  assert.equal(member.name, 'New Barber'); assert.equal(member.phone, '+923001234567');
  assert.ok(validateStaff({ ...staffInput, phone: '+923001234567' }, [member]));
  assert.equal(validateStaff(staffInput, [member], member.id), null);
  assert.equal(makeStaff({ ...staffInput, name: 'Renamed' }, [member], member.id).id, member.id);
});
test('working days validate times, unique days and configuration state', () => {
  assert.equal(validateStaff(staffInput, []), null);
  for (const hours of [[], [{ day: 1, start: '18:00', end: '09:00' }], [{ day: 1, start: '09:00', end: '09:00' }], [{ day: 7, start: '09:00', end: '18:00' }], [{ day: 1, start: '09:00', end: '18:00' }, { day: 1, start: '10:00', end: '19:00' }]]) assert.ok(validateStaff({ ...staffInput, hours }, []));
});
test('booking requires active staff, configured hours and entire service fit', () => {
  const active = { ...seedStaff[0], hours: [{ day: 6, start: '09:00', end: '18:00' }] };
  assert.equal(availabilityError(active, '2027-01-02', '09:00', 45), null);
  assert.equal(availabilityError(active, '2027-01-02', '17:15', 45), null);
  assert.ok(availabilityError(active, '2027-01-02', '17:16', 45));
  assert.ok(availabilityError(active, '2027-01-02', '08:59', 45));
  assert.ok(availabilityError(active, '2027-01-03', '10:00', 45));
  assert.match(availabilityError({ ...active, active: false }, booking.date, booking.time, 45), /inactive/);
  assert.match(availabilityError({ ...active, hours: null }, booking.date, booking.time, 45), /not configured/);
  assert.ok(validateBooking(booking, [], now, undefined, seedCustomers, [{ ...active, active: false }]));
  assert.ok(validateBooking(booking, [], now, undefined, seedCustomers, [{ ...active, hours: null }]));
  assert.equal(validateBooking(booking, [], now, undefined, seedCustomers, [active]), null);
});
test('staff renames retain ID conflicts and inactive edits require reassignment', () => {
  const original = makeAppointment(booking);
  const renamed = { ...seedStaff[0], name: 'Renamed employee' };
  assert.match(validateBooking(booking, [original], now, undefined, seedCustomers, [renamed]), /overlapping/);
  assert.equal(validateBooking(booking, [original], now, original.id, seedCustomers, [renamed]), null);
  assert.match(validateBooking(booking, [original], now, original.id, seedCustomers, [{ ...renamed, active: false }]), /inactive/);
  assert.equal(makeAppointment(booking, seedCustomers, [renamed]).staffId, original.staffId);
});
test('deactivation detection includes ongoing and future bookings, excludes history', () => {
  const original = makeAppointment(booking);
  const list = [original, { ...original, id: 'completed', status: 'Completed' }, { ...original, id: 'cancelled', status: 'Cancelled' }];
  const ongoing = Date.parse('2027-01-02T10:15:00+05:00');
  assert.equal(upcomingStaffBookings('staff-0', list, ongoing).length, 1);
  assert.equal(upcomingStaffBookings('staff-0', list, ongoing + 3600000).length, 0);
});
test('migrates v2 names to stable staff IDs and preserves old key and statuses', () => {
  const item = makeAppointment(booking); delete item.staffId;
  const legacy = { customers: seedCustomers, appointments: [{ ...item, status: 'Completed' }] };
  const map = storage({ 'salonpulse.demo.v2': JSON.stringify(legacy) });
  const first = loadStore(); assert.equal(first.warning, '');
  assert.equal(first.store.appointments[0].staffId, 'staff-0');
  assert.equal(first.store.appointments[0].status, 'Completed');
  assert.equal(first.store.staff.length, 3);
  assert.ok(map.has('salonpulse.demo.v2')); assert.deepEqual(loadStore().store, first.store);
});
test('unknown legacy employees migrate safely as inactive with unconfigured hours', () => {
  const item = { ...makeAppointment(booking), staff: 'Former Employee' }; delete item.staffId;
  storage({ 'salonpulse.demo.v2': JSON.stringify({ customers: seedCustomers, appointments: [item] }) });
  const result = loadStore(); assert.equal(result.warning, '');
  const member = result.store.staff.find(member => member.id === result.store.appointments[0].staffId);
  assert.equal(member.name, 'Former Employee'); assert.equal(member.active, false); assert.equal(member.hours, null);
});
test('migration write failure preserves loaded bookings in memory and old storage', () => {
  const item = makeAppointment(booking); delete item.staffId;
  const legacy = JSON.stringify({ customers: seedCustomers, appointments: [item] });
  globalThis.localStorage = { getItem: key => key === 'salonpulse.demo.v2' ? legacy : null, setItem() { throw Error('quota'); } };
  const result = loadStore();
  assert.match(result.warning, /migrated in memory/);
  assert.equal(result.store.appointments[0].id, item.id);
  assert.equal(result.store.appointments[0].staffId, 'staff-0');
  assert.equal(localStorage.getItem('salonpulse.demo.v2'), legacy);
});
test('v3 preserves inactive staff, configured hours, and original booking references', () => {
  const item = makeAppointment(booking);
  const member = { ...seedStaff[0], name: 'Updated name', active: false, hours: null };
  const store = { customers: seedCustomers, staff: [member, ...seedStaff.slice(1)], appointments: [item] };
  storage({ [STORAGE_KEY]: JSON.stringify(store) });
  const result = loadStore();
  assert.equal(result.warning, ''); assert.deepEqual(result.store, store);
  assert.equal(result.store.appointments[0].staff, 'Ali Raza');
});
