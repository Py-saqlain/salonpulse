# SalonPulse frontend

React + TypeScript + Vite with Tailwind. Authentication uses the FastAPI backend;
Customers, Staff, Services and Appointments use authenticated backend data.
Customer history and visit statistics are derived from saved appointment records.

## Windows PowerShell

Start the configured backend in a separate terminal:

```powershell
Set-Location 'D:\PROJECTS\Portfolio Projects\salonpulse\backend'
$env:DEBUG = 'false' # process-only override for an inherited DEBUG=release
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

Then start the frontend (existing dependencies require no additional packages):

```powershell
Set-Location 'D:\PROJECTS\Portfolio Projects\salonpulse\frontend'
# Optional first-time configuration; do not overwrite an existing .env.local:
if (-not (Test-Path .env.local)) { Copy-Item .env.example .env.local }
npm.cmd run dev
```

Open http://localhost:5173. `VITE_API_BASE_URL` defaults to
`http://127.0.0.1:8000`; set it in `.env.local` to change the API origin, then
restart Vite. Vite variables are public build configuration: never put passwords,
JWT signing secrets or database URLs in them. The backend must allow the exact
frontend origin in `CORS_ORIGINS`; localhost and 127.0.0.1 are different origins.
Use HTTPS for deployed frontend and backend URLs.

## Authentication contracts

- `#/register`: POST `/api/auth/register` with `business_name`, `full_name`,
  `email`, `password` (12-128 characters). Role and business identity are assigned
  by the backend. Successful registration is followed by JSON login.
- `#/login`: POST `/api/auth/login` with `email`, `password`; the response contains
  `access_token` and `token_type: bearer`.
- Before rendering the workspace, GET `/api/auth/me` and `/api/business/me` with
  the Bearer token. Their business IDs must match and the user must be active.
- Protected hash navigation redirects unauthenticated visitors to login. Logout,
  expiry (including focus/visibility after sleep), or authenticated HTTP 401 clears
  the session and unmounts the workspace. Refresh requires login again.
- Tokens live only in provider memory, never localStorage, sessionStorage, cookies
  or URLs. The local expiry decoder only schedules logout; backend JWT validation
  remains authoritative. There are no refresh tokens or password reset screens.

`api.ts` provides typed auth methods plus reusable typed JSON requests, timeout,
network handling, safe server errors and inline 422 validation. Requests omit
cookies, refuse redirects and prohibit external request paths. The context guards
late responses from earlier sessions from restoring a logged-out account.

## Business directories and session isolation

The shared `useCatalog` hook loads `/api/customers`, `/api/staff`, `/api/services`
and `/api/appointments`
using server UUIDs and tenant-checked response records. It follows all backend
100-record pages; screens search/filter the complete loaded directory and display
20 records per UI page. This preserves global search and complete appointment
selectors until server-side search is available. Loading all records is a prototype
scaling limitation; large directories need backend search and cursor pagination.
If pagination changes mid-load, the UI requests a refresh rather than merging an
inconsistent list. Refresh and window focus reload data; no background polling.
Focus refresh is deferred while a customer, staff, service or appointment
editor is mounted, preserving drafts and inline feedback when returning from a
native confirmation dialog or another window. Closing the editor permits the next
focus refresh. Explicit refreshes preserve mounted editors and their drafts.
Retry remains available after a failure; an in-flight guard coalesces repeated
clicks/focus events. Cached records and failure feedback stay intact during retry,
and writes remain disabled until a successful reload makes the data current.

Create/edit/delete operations use POST/PATCH/DELETE. Mutations reload shared data,
show loading/errors, and prevent concurrent form submissions. Blank nullable
fields map to null; hours retain Sunday=0 and use the business timezone. Service
`minutes` maps to `duration_minutes`; Decimal prices are returned as strings and
sent with exactly two decimal places. The verified API/database maximum is PKR
9,999,999,999.99 (`NUMERIC(12,2)`); negative, nonfinite and excess-precision values
are rejected. Name/specialty limits are 200, notes 4,000, category 100, description
2,000 characters. Existing phone and availability validation remains.

Owners manage all three directories. Staff users manage customers and see staff
and service directories read-only; the backend authorizes every request. Deletes
require confirmation and referenced records return a conflict. Deactivation with
active bookings first receives the backend warning; explicit confirmation retries
with `confirm_upcoming: true`. Cancelling the dialog leaves the record unchanged.
Hours changes that conflict with real appointments remain rejected. Referenced
records cannot be deleted; the backend remains authoritative for these protections.

No legacy `salonpulse.demo.*` storage is read or imported. Catalogs are cleared
on logout and fetched anew after login, so database records persist across sessions
without browser storage. In-flight reads are aborted/versioned and old session
results cannot hydrate another account. Failed refreshes retain last-loaded records
with an explicit stale-data warning and block writes until retry succeeds. Initial
loading failures can also be retried. A write followed by failed reload may already be saved;
refresh before submitting it again. Tokens still live only in memory.

## Appointment workflow

Bookings use POST/GET `/api/appointments`, PATCH `/api/appointments/{id}` for
confirmed-booking edits or status changes, and DELETE for cancellation. Both
owners and staff can manage appointments. Cancellation keeps history; completed
appointments have no destructive action. Start is available only once the scheduled
time arrives; in-progress records can be completed or cancelled. Failed writes
leave form inputs and inline feedback intact. Quick Add Customer saves and selects
a real customer UUID.

Dates and filters use the business IANA timezone. Scheduled wall-clock input is
converted to aware UTC; missing/ambiguous daylight-saving times are rejected.
Walk-ins omit `starts_at`, use server time and begin `in_progress`. Active staff,
configured working hours, full service duration and overlap rules are checked in
the UI and again by the backend. Concurrent requests are resolved by backend locks;
a losing request displays its conflict without discarding the draft.

Responses use saved `booked_price`/`booked_duration_minutes`, never current catalog
terms for historical calculations. Ordinary edits retain snapshots. Recalculation
requires explicit acknowledgement; changing service requires the current-terms
checkbox. PATCH omits unchanged start times so server sub-minute precision survives.
Only confirmed bookings can change booking details; status changes are separate.

All server pages are loaded for complete customer history and client-side filters
(customer name, date, staff, status), with 20 rows per display page. Completed visit
counts and last completed visit use stable customer IDs and UTC ordering. This
whole-business loading approach is a scaling limitation; future work can introduce
backend search/summary contracts. No authentication persistence, new packages,
backend changes or migrations are introduced here. Refresh still requires login;
server appointments persist across refresh/logout.

## Verification

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Tests use Node 24's built-in test runner/type stripping; no new test dependencies
are needed. Production output is `dist/` (ignored by Git).


`tests/browser-auth.mjs` is an opt-in real Chrome check (not part of `npm test`).
It requires the frontend on 127.0.0.1:5173, backend on 127.0.0.1:8000, and a
separate temporary Chrome profile exposing CDP on localhost:9223. Run
`node tests/browser-auth.mjs` from `frontend`. It uses the existing backend venv
for guarded database checks and cleanup, accepts only local `salonpulse_dev` as
`salonpulse_app`, and removes only its uniquely marked temporary businesses/users.
Passwords are generated in memory and never logged. It verifies live auth forms,
422 errors, loading, duplicate registration, account isolation, expiry, refresh,
network errors, a simulated protected 401, mobile navigation and overflow.

Run `node tests/browser-auth.mjs --crud` with the same Chrome CDP setup for live
CRUD verification. It creates two uniquely marked businesses, tests real forms,
HTTP tenant isolation, staff permissions, price bounds, persistence, pagination,
network failure and deactivation/deletion constraints. Its guarded fixture helper
changes only its temporary user role and creates one temporary appointment to
exercise reference restrictions; it always cleans up those businesses and restores
the database record-ID baseline. It does not implement frontend appointment APIs.

Run `node tests/browser-auth.mjs --appointments` for the appointment browser
suite. It races two authenticated Chrome tabs against the same staff slot,
verifies booking/edit/cancellation/status flows, snapshots, history, walk-ins,
permissions, tenant isolation, persistence and network errors. The shared harness
always removes only its uniquely marked test businesses and restores the database
baseline. `--crud` additionally covers failed refresh followed by successful retry,
request coalescing, and preservation of cached records, draft inputs and feedback.


The dashboard uses authenticated records from every API page, with daily counts
based on the appointment start date in the business timezone. Cancelled bookings
remain in status totals but are excluded from the appointment KPI and staff
workload. Upcoming shows the next five future confirmed bookings and the full
count. Workload includes retained inactive staff and booked duration snapshots.
Business data is not seeded or persisted in localStorage.

Run `node tests/browser-auth.mjs --dashboard` for two-business live dashboard
checks, including pagination, timezone boundaries, statistics, CRUD refresh,
persistence, tenant isolation and mobile layout. To use another isolated local
Chrome debugging session, set `$env:SALONPULSE_CDP_URL='http://127.0.0.1:9224'`.
After renaming modules that differ only by case, restart Vite if its development
module graph retains an old path; the production compiler uses the current files.

The unit suite now contains 61 tests. The earlier 56-to-36 count change came from
replacing 33 demo-era customer/storage tests with eight API-era domain tests and
adding five dashboard tests. A further 25 API regression tests preserve relevant
validation, history, snapshot, availability, pagination and isolation coverage.
Obsolete demo-storage migration behavior is no longer part of the application.
