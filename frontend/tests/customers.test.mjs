import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
// Strip types using Node 24; no additional test packages are required.
const directory = mkdtempSync(join(tmpdir(), 'salonpulse-tests-'));
let data, customers, staffDomain, serviceDomain;
try {
  for (const name of ['customers', 'staff', 'services', 'data']) {
    const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
    const output = stripTypeScriptTypes(source).replaceAll("'./customers'", "'./customers.mjs'").replaceAll("'./staff'", "'./staff.mjs'").replaceAll("'./services'", "'./services.mjs'");
    writeFileSync(join(directory, `${name}.mjs`), output);
  }
  customers = await import(pathToFileURL(join(directory, 'customers.mjs')));
  staffDomain = await import(pathToFileURL(join(directory, 'staff.mjs')));
  serviceDomain = await import(pathToFileURL(join(directory, 'services.mjs')));
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
const booking = { customerId: 'customer-0', serviceId: 'service-0', staffId: 'staff-0', date: '2027-01-02', time: '10:00' };
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
  const store = { services: serviceDomain.seedServices, staff: staffDomain.seedStaff, customers: seedCustomers.map(c => c.id === item.customerId ? { ...c, name: 'Renamed' } : c), appointments: [{ ...item, status: 'Cancelled' }] };
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
  const store = { services: serviceDomain.seedServices, customers: seedCustomers, staff: [member, ...seedStaff.slice(1)], appointments: [item] };
  storage({ [STORAGE_KEY]: JSON.stringify(store) });
  const result = loadStore();
  assert.equal(result.warning, ''); assert.deepEqual(result.store, store);
  assert.equal(result.store.appointments[0].staff, 'Ali Raza');
});
const { seedServices, validateService, makeService, bookingService, upcomingServiceBookings } = serviceDomain;
const serviceInput = { name: '  Luxury facial  ', category: ' Skin care ', description: ' Gentle treatment ', minutes: 60, price: 0, active: true };
test('service creation trims optional fields and assigns stable IDs', () => {
  const service = makeService(serviceInput, []);
  assert.ok(service.id); assert.equal(service.name, 'Luxury facial'); assert.equal(service.category, 'Skin care'); assert.equal(service.price, 0);
  assert.equal(makeService({ ...serviceInput, name: 'New name' }, [service], service.id).id, service.id);
});
test('service validation rejects missing names and invalid numbers', () => {
  assert.ok(validateService({ ...serviceInput, name: ' ' }, []));
  for (const minutes of [0, -1, NaN, Infinity, 1.5, 1441]) assert.ok(validateService({ ...serviceInput, minutes }, []));
  for (const price of [-1, NaN, Infinity, 1.001, 10000001]) assert.ok(validateService({ ...serviceInput, price }, []));
  assert.equal(validateService({ ...serviceInput, price: 1250.25 }, []), null);
});
test('active names are unique ignoring case and whitespace, including reactivation', () => {
  const existing = makeService(serviceInput, []);
  assert.ok(validateService({ ...serviceInput, name: 'luxury   FACIAL' }, [existing]));
  assert.equal(validateService(serviceInput, [existing], existing.id), null);
  assert.equal(validateService({ ...serviceInput, active: false }, [existing]), null);
  assert.equal(validateService(serviceInput, [{ ...existing, active: false }]), null);
});
test('new bookings reject inactive service, but original edit can keep booked terms', () => {
  const existing = makeAppointment(booking);
  const catalog = seedServices.map(service => ({ ...service, active: false }));
  assert.match(validateBooking(booking, [], now, undefined, seedCustomers, seedStaff, catalog), /inactive/);
  assert.equal(validateBooking(booking, [existing], now, existing.id, seedCustomers, seedStaff, catalog), null);
  assert.match(validateBooking({ ...booking, recalculateService: true }, [existing], now, existing.id, seedCustomers, seedStaff, catalog), /inactive/);
});
test('catalog edits do not alter existing price, duration or service name snapshots', () => {
  const existing = makeAppointment(booking);
  const catalog = seedServices.map(service => service.id === existing.serviceId ? { ...service, name: 'Renamed service', minutes: 90, price: 9999 } : service);
  const edited = makeAppointment(booking, seedCustomers, seedStaff, catalog, existing);
  assert.equal(edited.minutes, 45); assert.equal(edited.price, 2500); assert.equal(edited.service, existing.service);
  const fresh = makeAppointment(booking, seedCustomers, seedStaff, catalog);
  assert.equal(fresh.minutes, 90); assert.equal(fresh.price, 9999); assert.equal(fresh.service, 'Renamed service');
  assert.equal(existing.price, 2500);
});
test('explicit recalculation applies current terms and changing services requires confirmation', () => {
  const existing = makeAppointment(booking);
  const catalog = seedServices.map(service => service.id === booking.serviceId ? { ...service, minutes: 60, price: 5000 } : service);
  const recalculated = makeAppointment({ ...booking, recalculateService: true }, seedCustomers, seedStaff, catalog, existing);
  assert.equal(recalculated.minutes, 60); assert.equal(recalculated.price, 5000);
  assert.equal('recalculateService' in recalculated, false);
  assert.match(bookingService({ ...booking, serviceId: 'service-1' }, catalog, existing), /Confirm/);
  const changed = makeAppointment({ ...booking, serviceId: 'service-1', recalculateService: true }, seedCustomers, seedStaff, catalog, existing);
  assert.equal(changed.minutes, 90); assert.equal(changed.serviceId, 'service-1');
});
test('current service duration controls shift boundary for new bookings', () => {
  const catalog = seedServices.map(service => ({ ...service, minutes: 90 }));
  const exact = { ...booking, time: '18:30' };
  assert.equal(validateBooking(exact, [], now, undefined, seedCustomers, seedStaff, catalog), null);
  assert.match(validateBooking({ ...exact, time: '18:31' }, [], now, undefined, seedCustomers, seedStaff, catalog), /entire service/);
});
test('edit validation uses original duration until recalculation and checks new conflicts', () => {
  const existing = makeAppointment(booking);
  const neighbor = { ...makeAppointment({ ...booking, time: '11:00' }), id: 'neighbor' };
  const catalog = seedServices.map(service => service.id === booking.serviceId ? { ...service, minutes: 90 } : service);
  assert.equal(validateBooking(booking, [existing, neighbor], now, existing.id, seedCustomers, seedStaff, catalog), null);
  assert.match(validateBooking({ ...booking, recalculateService: true }, [existing, neighbor], now, existing.id, seedCustomers, seedStaff, catalog), /overlapping/);
  assert.equal(validateBooking({ ...booking, recalculateService: true }, [existing, { ...neighbor, status: 'Cancelled' }], now, existing.id, seedCustomers, seedStaff, catalog), null);
});
test('existing appointments block using their booked duration after catalog is shortened', () => {
  const existing = { ...makeAppointment(booking), minutes: 120 };
  const catalog = seedServices.map(service => ({ ...service, minutes: 15 }));
  assert.match(validateBooking({ ...booking, time: '11:30' }, [existing], now, undefined, seedCustomers, seedStaff, catalog), /overlapping/);
  assert.equal(validateBooking({ ...booking, time: '12:00' }, [existing], now, undefined, seedCustomers, seedStaff, catalog), null);
});
test('service deactivation warning detects upcoming and ongoing bookings only', () => {
  const existing = makeAppointment(booking);
  const rows = [existing, { ...existing, id: 'done', status: 'Completed' }, { ...existing, id: 'cancel', status: 'Cancelled' }];
  assert.equal(upcomingServiceBookings(existing.serviceId, rows, now).length, 1);
  assert.equal(upcomingServiceBookings(existing.serviceId, rows, Date.parse('2027-01-02T10:30:00+05:00')).length, 1);
  assert.equal(upcomingServiceBookings(existing.serviceId, rows, Date.parse('2027-01-03T10:30:00+05:00')).length, 0);
});
test('v3 migration preserves custom price/duration and customer/staff identities', () => {
  const existing = { ...makeAppointment(booking), price: 3200, minutes: 75 }; delete existing.serviceId;
  const legacy = { customers: seedCustomers, staff: [{ ...seedStaff[0], active: false, name: 'Renamed staff' }, ...seedStaff.slice(1)], appointments: [existing] };
  const map = storage({ 'salonpulse.demo.v3': JSON.stringify(legacy) });
  const result = loadStore(); assert.equal(result.warning, '');
  assert.equal(result.store.staff[0].active, false); assert.equal(result.store.staff[0].name, 'Renamed staff');
  const migrated = result.store.appointments[0];
  assert.equal(migrated.customerId, existing.customerId); assert.equal(migrated.staffId, existing.staffId);
  assert.equal(migrated.serviceId, 'service-0'); assert.equal(migrated.price, 3200); assert.equal(migrated.minutes, 75);
  assert.ok(map.has('salonpulse.demo.v3')); assert.deepEqual(loadStore().store, result.store);
});
test('unknown legacy services retained as inactive records, snapshots survive reload', () => {
  const existing = { ...makeAppointment(booking), service: 'Legacy treatment', price: 7000, minutes: 80 }; delete existing.serviceId;
  storage({ 'salonpulse.demo.v3': JSON.stringify({ customers: seedCustomers, staff: seedStaff, appointments: [existing] }) });
  const result = loadStore(); assert.equal(result.warning, '');
  const service = result.store.services.find(service => service.id === result.store.appointments[0].serviceId);
  assert.equal(service.name, 'Legacy treatment'); assert.equal(service.active, false);
  assert.equal(result.store.appointments[0].price, 7000);
  assert.deepEqual(loadStore().store, result.store);
});
test('v4 load accepts historical snapshots that differ from renamed catalog records', () => {
  const existing = makeAppointment(booking);
  const catalog = seedServices.map(service => ({ ...service, name: service.name + ' updated', price: 10000, minutes: 120 }));
  const store = { customers: seedCustomers, staff: seedStaff, services: catalog, appointments: [existing] };
  storage({ [STORAGE_KEY]: JSON.stringify(store) });
  assert.equal(loadStore().warning, ''); assert.deepEqual(loadStore().store, store);
});
