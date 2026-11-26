import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';
const directory = mkdtempSync(join(tmpdir(), 'salonpulse-dashboard-'));
let dashboardStats, readCatalog;
try {
  for (const name of ['api', 'customers', 'services', 'appointments', 'catalog', 'dashboardMetrics']) {
    let code = stripTypeScriptTypes(readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'));
    for (const dependency of ['api', 'customers', 'services', 'appointments']) code = code.replaceAll(`'./${dependency}'`, `'./${dependency}.mjs'`);
    writeFileSync(join(directory, name + '.mjs'), code);
  }
  ({ dashboardStats } = await import(pathToFileURL(join(directory, 'dashboardMetrics.mjs'))));
  ({ readCatalog } = await import(pathToFileURL(join(directory, 'catalog.mjs'))));
} finally { rmSync(directory, { recursive: true, force: true }); }
const now = Date.parse('2030-01-02T07:00:00Z'); // Noon in Lahore.
const staff = [{ id: 'one', name: 'First employee', active: true }, { id: 'two', name: 'Former employee', active: false }, { id: 'idle', name: 'No bookings', active: true }];
const booking = (id, startUTC, status = 'Confirmed', staffId = 'one', minutes = 30) => ({ id, startUTC, endUTC: new Date(Date.parse(startUTC) + minutes * 60000).toISOString(), status, staffId, minutes, price: 100, date: 'wrong cached date' });

test('daily statuses use business start date across UTC midnight, including exact boundaries', () => {
  const rows = [booking('before', '2030-01-01T18:59:59Z'), booking('boundary', '2030-01-01T19:00:00Z', 'Completed'), booking('running', '2030-01-02T06:45:00Z', 'In progress'), booking('future', '2030-01-02T08:00:00Z'), booking('cancel', '2030-01-02T09:00:00Z', 'Cancelled'), booking('next', '2030-01-02T19:00:00Z')];
  const result = dashboardStats(rows, staff, 'Asia/Karachi', now);
  assert.equal(result.today, '2030-01-02'); assert.equal(result.total, 4); assert.equal(result.active, 3);
  assert.deepEqual(result.statuses, { Confirmed: 1, 'In progress': 1, Completed: 1, Cancelled: 1 });
  assert.equal(result.remainingToday, 1); assert.equal('revenue' in result, false); // Bookings are not collected revenue.
  assert.equal(dashboardStats(rows, staff, 'UTC', now).total, 4);
  assert.equal(dashboardStats(rows, staff, 'UTC', now).statuses.Completed, 0);
});

test('upcoming includes all future confirmed records in order, excluding terminal and running bookings', () => {
  const rows = [booking('later', '2030-01-03T05:00:00Z'), booking('done', '2030-01-03T06:00:00Z', 'Completed'), booking('cancel', '2030-01-03T07:00:00Z', 'Cancelled'), booking('old', '2030-01-02T05:00:00Z'), booking('next', '2030-01-02T08:00:00Z'), booking('running', '2030-01-02T06:50:00Z', 'In progress')];
  assert.deepEqual(dashboardStats(rows, staff, 'Asia/Karachi', now).upcoming.map(item => item.id), ['next', 'later']);
});

test('workload includes retained inactive staff and booked duration, excluding cancelled bookings', () => {
  const rows = [booking('a', '2030-01-02T05:00:00Z', 'Completed', 'one', 45), booking('b', '2030-01-02T06:00:00Z', 'In progress', 'one', 60), booking('c', '2030-01-02T08:00:00Z', 'Confirmed', 'two', 20), booking('d', '2030-01-02T09:00:00Z', 'Cancelled', 'two', 90)];
  const result = dashboardStats(rows, staff, 'Asia/Karachi', now);
  assert.deepEqual(result.workload.map(item => [item.id, item.appointments, item.minutes]), [['one', 2, 105], ['two', 1, 20], ['idle', 0, 0]]);
});

test('empty businesses and midnight rollover have independent zero totals', () => {
  assert.equal(dashboardStats([], [], 'Asia/Karachi', now).active, 0);
  const rows = [booking('a', '2030-01-02T18:59:00Z')];
  assert.equal(dashboardStats(rows, staff, 'Asia/Karachi', Date.parse('2030-01-02T18:59:59Z')).total, 1);
  assert.equal(dashboardStats(rows, staff, 'Asia/Karachi', Date.parse('2030-01-02T19:00:00Z')).total, 0);
});

test('all API pages contribute to statistics and workload before display pagination', async () => {
  const business = '11111111-1111-4111-8111-111111111111', id = index => `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`;
  const requests = [];
  const api = { request: async path => {
    const url = new URL(path, 'http://localhost'), resource = url.pathname.split('/').at(-1), offset = Number(url.searchParams.get('offset'));
    requests.push([resource, offset]);
    const base = { id: id(1), business_id: business, name: 'Record' };
    let items, total;
    if (resource === 'appointments') {
      total = 205; items = Array.from({ length: Math.min(100, total - offset) }, (_, index) => ({ ...base, id: id(index + offset + 10), customer_id: id(1), staff_id: id(1), service_id: id(1), starts_at: '2030-01-02T08:00:00Z', ends_at: '2030-01-02T08:30:00Z', booked_price: '100.00', booked_duration_minutes: 30, status: index + offset === 204 ? 'cancelled' : 'confirmed', booking_type: 'scheduled' }));
    } else { total = 1; items = [resource === 'customers' ? { ...base, phone: null, notes: null } : resource === 'staff' ? { ...base, phone: null, specialty: null, active: true, hours: null } : { ...base, category: null, description: '', duration_minutes: 30, price: '100.00', active: true }]; }
    return { items, total, offset, limit: 100 };
  } };
  const records = await readCatalog(api, business, new AbortController().signal, 'Asia/Karachi');
  const result = dashboardStats(records.appointments, records.staff, 'Asia/Karachi', now);
  assert.equal(result.total, 205); assert.equal(result.active, 204); assert.equal(result.upcoming.length, 204); assert.equal(result.workload[0].minutes, 6120);
  assert.deepEqual(requests.filter(item => item[0] === 'appointments').map(item => item[1]), [0, 100, 200]);
});
