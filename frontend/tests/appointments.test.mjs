import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
const directory = mkdtempSync(join(tmpdir(), 'salonpulse-bookings-'));
let domain, customerHistory;
try {
  for (const name of ['customers', 'services', 'appointments']) writeFileSync(join(directory, name + '.mjs'), stripTypeScriptTypes(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8')).replaceAll("'./services'", "'./services.mjs'"));
  domain = await import(pathToFileURL(join(directory, 'appointments.mjs')));
  ({ customerHistory } = await import(pathToFileURL(join(directory, 'customers.mjs'))));
} finally { rmSync(directory, { recursive: true, force: true }); }

const records = { customers: [{ id: 'customer', name: 'Customer' }], staff: [{ id: 'staff', name: 'Barber', active: true, hours: Array.from({ length: 7 }, (_, day) => ({ day, start: '09:00', end: '18:00' })) }], services: [{ id: 'service', name: 'Trim', minutes: 45, price: 2500, active: true }], appointments: [] };
const dto = { id: 'booking', customer_id: 'customer', staff_id: 'staff', service_id: 'service', starts_at: '2030-01-02T05:00:12.123Z', ends_at: '2030-01-02T05:30:12.123Z', booked_price: '1500.50', booked_duration_minutes: 30, status: 'confirmed', booking_type: 'scheduled' };
const input = { customerId: 'customer', staffId: 'staff', serviceId: 'service', date: '2030-01-02', time: '10:00', bookingType: 'Scheduled' };
const now = Date.parse('2030-01-01T05:00:00Z');

test('business wall time converts to UTC across midnight independent of the device timezone', () => {
  assert.equal(domain.wallTimeToUTC('2030-01-02', '00:15', 'Asia/Karachi'), '2030-01-01T19:15:00.000Z');
  assert.deepEqual(domain.localDateTime('2030-01-01T19:15:00Z', 'Asia/Karachi'), { date: '2030-01-02', time: '00:15' });
  assert.equal(domain.wallTimeToUTC('2030-01-02', '09:30', 'America/New_York'), '2030-01-02T14:30:00.000Z');
  for (const [date, time] of [['2026-03-08', '02:30'], ['2026-11-01', '01:30']]) assert.throws(() => domain.wallTimeToUTC(date, time, 'America/New_York'), /missing or ambiguous/);
  assert.throws(() => domain.wallTimeToUTC('2030-02-30', '10:00', 'Asia/Karachi'));
});

test('server snapshots and precise UTC instants survive catalog edits', () => {
  const appointment = domain.appointmentFromAPI(dto, records, 'Asia/Karachi');
  assert.equal(appointment.price, 1500.5); assert.equal(appointment.minutes, 30);
  assert.equal(appointment.startUTC, dto.starts_at); assert.equal(appointment.date, input.date); assert.equal(appointment.time, input.time);
  assert.equal(appointment.status, 'Confirmed'); assert.equal(appointment.customerId, 'customer');
  assert.throws(() => domain.appointmentFromAPI({ ...dto, status: 'unknown' }, records, 'Asia/Karachi'));
  assert.throws(() => domain.appointmentFromAPI({ ...dto, customer_id: 'foreign' }, records, 'Asia/Karachi'));
});

test('create payload derives scheduled UTC and leaves walk-in timing to the server', () => {
  const scheduled = domain.bookingPayload(input, 'Asia/Karachi');
  assert.equal(scheduled.starts_at, '2030-01-02T05:00:00.000Z'); assert.equal(scheduled.booking_type, 'scheduled');
  const walkIn = domain.bookingPayload({ ...input, bookingType: 'Walk-in', date: '', time: '' }, 'Asia/Karachi');
  assert.equal(walkIn.booking_type, 'walk_in'); assert.equal('starts_at' in walkIn, false);
  for (const field of ['business_id', 'status', 'booked_price', 'booked_duration_minutes', 'ends_at']) assert.equal(field in scheduled, false);
});

test('patch payload omits unchanged instants and requires explicit snapshot recalculation', () => {
  const original = domain.appointmentFromAPI(dto, records, 'Asia/Karachi');
  assert.equal(domain.bookingPayload(input, 'Asia/Karachi', original), null);
  assert.deepEqual(domain.bookingPayload({ ...input, customerId: 'other' }, 'Asia/Karachi', original), { customer_id: 'other' });
  assert.deepEqual(domain.bookingPayload({ ...input, recalculateService: true }, 'Asia/Karachi', original), { recalculate_service: true });
  assert.equal(domain.bookingPayload({ ...input, time: '11:00' }, 'Asia/Karachi', original).starts_at, '2030-01-02T06:00:00.000Z');
});

test('booking validation enforces availability, full duration, active records and past-time restrictions', () => {
  assert.equal(domain.validateAppointment(input, records, 'Asia/Karachi', undefined, now), null);
  assert.match(domain.validateAppointment({ ...input, time: '17:30' }, records, 'Asia/Karachi', undefined, now), /entire service/);
  assert.match(domain.validateAppointment(input, { ...records, staff: [{ ...records.staff[0], hours: null }] }, 'Asia/Karachi', undefined, now), /not configured/);
  assert.match(domain.validateAppointment(input, { ...records, services: [{ ...records.services[0], active: false }] }, 'Asia/Karachi', undefined, now), /active/);
  assert.match(domain.validateAppointment(input, records, 'Asia/Karachi', undefined, Date.parse('2030-01-03T00:00Z')), /future/);
  assert.equal(domain.validateAppointment({ ...input, bookingType: 'Walk-in', date: '', time: '' }, records, 'Asia/Karachi', undefined, Date.parse('2030-01-02T05:00Z')), null);
});

test('conflicts use booked intervals, exclude self and release cancelled/completed slots', () => {
  const original = domain.appointmentFromAPI(dto, records, 'Asia/Karachi');
  assert.match(domain.validateAppointment(input, { ...records, appointments: [original] }, 'Asia/Karachi', undefined, now), /overlapping/);
  assert.equal(domain.validateAppointment(input, { ...records, appointments: [original] }, 'Asia/Karachi', original, now), null);
  for (const status of ['Cancelled', 'Completed']) assert.equal(domain.validateAppointment(input, { ...records, appointments: [{ ...original, status }] }, 'Asia/Karachi', undefined, now), null);
  assert.match(domain.validateAppointment(input, records, 'Asia/Karachi', { ...original, status: 'Completed' }, now), /Only confirmed/);
  const shifted = { ...input, time: '17:30' };
  assert.equal(domain.validateAppointment(shifted, records, 'Asia/Karachi', original, now), null);
  assert.match(domain.validateAppointment({ ...shifted, recalculateService: true }, records, 'Asia/Karachi', original, now), /entire service/);
});

test('customer history uses stable IDs and UTC ordering even when wall-clock times repeat', () => {
  const view = domain.appointmentFromAPI(dto, records, 'Asia/Karachi');
  const early = { ...view, id: 'early', status: 'Completed', date: '2026-11-01', time: '01:30', startUTC: '2026-11-01T05:30:00Z' };
  const late = { ...early, id: 'late', customer: 'Renamed customer', startUTC: '2026-11-01T06:30:00Z' };
  const result = customerHistory('customer', [early, late, { ...late, id: 'cancelled', status: 'Cancelled' }]);
  assert.equal(result.completedVisits, 2); assert.equal(result.lastCompleted.id, 'late'); assert.equal(result.history.length, 3);
});

test('staff/customer edits keep snapshots and service changes require explicit current-terms acknowledgement', () => {
  const original = domain.appointmentFromAPI(dto, records, 'Asia/Karachi');
  assert.deepEqual(domain.bookingPayload({ ...input, staffId: 'another' }, 'Asia/Karachi', original), { staff_id: 'another' });
  const expanded = { ...records, services: [...records.services, { ...records.services[0], id: 'other', name: 'Other service' }] };
  assert.match(domain.validateAppointment({ ...input, serviceId: 'other' }, expanded, 'Asia/Karachi', original, now), /Confirm/);
  assert.equal(domain.validateAppointment({ ...input, serviceId: 'other', recalculateService: true }, expanded, 'Asia/Karachi', original, now), null);
});
