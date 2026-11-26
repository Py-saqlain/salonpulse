import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
const directory = mkdtempSync(join(tmpdir(), 'salonpulse-directories-'));
let customers, staff, services, data;
try {
  for (const name of ['customers', 'staff', 'services', 'data']) writeFileSync(join(directory, name + '.mjs'), stripTypeScriptTypes(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')).replaceAll("'./customers'", "'./customers.mjs'"));
  customers = await import(pathToFileURL(join(directory, 'customers.mjs')));
  staff = await import(pathToFileURL(join(directory, 'staff.mjs')));
  services = await import(pathToFileURL(join(directory, 'services.mjs')));
  data = await import(pathToFileURL(join(directory, 'data.mjs')));
} finally { rmSync(directory, { recursive: true, force: true }); }
const input = { name: ' Customer ', phone: '0300 8672095', notes: '' };
const employee = { id: 'employee', name: 'Barber', phone: '+923008672095', specialty: '', active: true, hours: null };
const service = { id: 'service', name: 'Haircut', category: '', description: '', minutes: 30, price: 1250.25, active: true };
const booking = { id: 'booking', customerId: 'customer', customer: 'Old name', staffId: 'employee', serviceId: 'service', service: 'Original haircut', status: 'Confirmed', startUTC: '2030-01-02T05:00:00Z', endUTC: '2030-01-02T05:30:00Z', date: 'wrong cached date', time: '00:00', timeZone: 'Asia/Karachi', price: 900, minutes: 30 };

test('normalizes Pakistani phone formats and rejects malformed numbers', () => {
  for (const number of ['03008672095', '0300 867-2095', '+92 (300) 8672095', '923008672095', '00923008672095']) assert.equal(customers.normalizePhone(number), '+923008672095');
  assert.equal(customers.normalizePhone(' '), '');
  for (const value of ['abc', '04286720958', '+9203008672095', '---']) assert.equal(customers.normalizePhone(value), null);
});
test('customer validation preserves required fields, limits and normalized uniqueness', () => {
  const existing = { id: 'customer', ...input, phone: '+923008672095' };
  assert.ok(customers.validateCustomer({ ...input, name: ' ' }, []));
  assert.equal(customers.validateCustomer({ ...input, phone: '' }, []), null);
  assert.ok(customers.validateCustomer(input, [existing]));
  assert.equal(customers.validateCustomer(input, [existing], existing.id), null);
  assert.equal(customers.validateCustomer({ ...input, name: 'n'.repeat(200), notes: 'n'.repeat(4000) }, []), null);
  for (const changes of [{ name: 'n'.repeat(201) }, { notes: 'n'.repeat(4001) }, { phone: 'invalid' }]) assert.ok(customers.validateCustomer({ ...input, ...changes }, []));
});
test('customer history uses stable IDs and completed records only', () => {
  const rows = [{ ...booking, status: 'Completed' }, { ...booking, id: 'later', customer: 'Renamed', startUTC: '2030-01-03T05:00Z', status: 'Completed' }, { ...booking, id: 'cancel', status: 'Cancelled' }, { ...booking, customerId: 'other' }];
  const history = customers.customerHistory('customer', rows);
  assert.equal(history.history.length, 3); assert.equal(history.completedVisits, 2); assert.equal(history.lastCompleted.id, 'later');
  assert.equal(customers.customerHistory('missing', rows).completedVisits, 0);
});
test('staff validation enforces phones, limits and optional valid working hours', () => {
  assert.equal(staff.validateStaff(employee, [], employee.id), null);
  assert.ok(staff.validateStaff({ ...employee, id: undefined }, [employee]));
  assert.equal(staff.validateStaff(employee, [employee], employee.id), null);
  assert.equal(staff.validateStaff({ ...employee, name: 'n'.repeat(200), specialty: 's'.repeat(200) }, []), null);
  for (const hours of [[], [{ day: 1, start: '18:00', end: '09:00' }], [{ day: 7, start: '09:00', end: '18:00' }], [{ day: 1, start: '09:00', end: '18:00' }, { day: 1, start: '10:00', end: '19:00' }]]) assert.ok(staff.validateStaff({ ...employee, hours }, []));
  assert.ok(staff.validateStaff({ ...employee, specialty: 's'.repeat(201) }, []));
});
test('services validate duration, decimal prices and backend field bounds', () => {
  for (const minutes of [0, -1, NaN, Infinity, 1.5, 1441]) assert.ok(services.validateService({ ...service, minutes }, []));
  for (const price of [-1, NaN, Infinity, 1.001, 10000000000]) assert.ok(services.validateService({ ...service, price }, []));
  for (const price of [0, 0.01, 1250.25, 9999999999.99]) assert.equal(services.validateService({ ...service, price }, []), null);
  assert.equal(services.validateService({ ...service, name: 'n'.repeat(200), category: 'c'.repeat(100), description: 'd'.repeat(2000) }, []), null);
  for (const changes of [{ name: ' ' }, { name: 'n'.repeat(201) }, { category: 'c'.repeat(101) }, { description: 'd'.repeat(2001) }]) assert.ok(services.validateService({ ...service, ...changes }, []));
});
test('active service names remain unique and edits exclude their own ID', () => {
  assert.ok(services.validateService({ ...service, name: ' HAIRCUT ' }, [service]));
  assert.equal(services.validateService(service, [service], service.id), null);
  assert.equal(services.validateService({ ...service, active: false }, [service]), null);
  assert.equal(services.validateService(service, [{ ...service, active: false }]), null);
});
test('booked service snapshots require explicit acknowledgement to recalculate', () => {
  const input = { serviceId: service.id };
  assert.deepEqual(services.bookingService(input, [service], booking), { name: 'Original haircut', minutes: 30, price: 900 });
  assert.equal(services.bookingService({ ...input, recalculateService: true }, [service], booking).price, 1250.25);
  assert.match(services.bookingService({ serviceId: 'other' }, [{ ...service, id: 'other' }], booking), /Confirm/);
});
test('pending booking helpers use UTC intervals and exclude final statuses', () => {
  const rows = [booking, { ...booking, id: 'done', status: 'Completed' }, { ...booking, id: 'cancel', status: 'Cancelled' }];
  for (const [method, id] of [[staff.upcomingStaffBookings, 'employee'], [services.upcomingServiceBookings, 'service']]) {
    assert.equal(method(id, rows, Date.parse('2030-01-02T05:15Z')).length, 1);
    assert.equal(method(id, rows, Date.parse('2030-01-02T05:30Z')).length, 0);
  }
  assert.equal(data.startsAt(booking), Date.parse(booking.startUTC));
});
