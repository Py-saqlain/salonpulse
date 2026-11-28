# SalonPulse frontend

React + TypeScript + Vite with Tailwind. Authentication uses the FastAPI backend;
Customers, Staff, Services and Appointments use authenticated backend data.
Customer history and visit statistics are derived from saved appointment records.

## Windows PowerShell

Start the configured backend in a separate terminal:

```powershell
Set-Location 'D:\PROJECTS\Portfolio Projects\salonpulse\backend'
$env:DEBUG = 'false' # process-only override for an inherited DEBUG=release
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --no-proxy-headers --no-access-log --no-server-header
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

The shared `useCatalog` hook loads one bounded `/api/workspace?view=...` response
for the current screen. PostgreSQL applies search, filters and pagination (20
records/page); the browser never downloads the entire business. Customer history
is separately paginated and visit totals are computed across all completed
appointments. Dashboard counters and staff workload are SQL aggregates, with
only five upcoming bookings and 20 workload rows returned per page.

Booking selectors use searchable `/api/booking-options/{customers|staff|services}`
pages of 20, retaining only the selected record when it is outside the page.
Inactive records remain visible for historical edits; booking validation still
rejects inactive choices for new bookings. Services accept any exact category
filter, with current-page suggestions and an uncategorized option. Booking rows
include display names and batched balances, avoiding per-row summary requests.
Search is debounced 250 ms; replaced requests are aborted. Refresh and window
focus reload the current page rather than all directories.
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
npm.cmd run build -- --mode development
```

Tests use Node 24's built-in test runner/type stripping; no new test dependencies
are needed. Production output is `dist/` (ignored by Git).


`tests/browser-auth.mjs` is an opt-in real Chrome check (not part of `npm test`).
It requires the dedicated test frontend on 127.0.0.1:5174 and a temporary
Chrome profile exposing CDP; the harness owns its isolated backend on port 8010. Run
`node tests/browser-auth.mjs` from `frontend`. It uses the existing backend venv
for guarded database checks and cleanup, accepts only local `salonpulse_dev` as
`salonpulse_app`, and removes only its own disposable schema after checking public row IDs.
Passwords are generated in memory and never logged. It verifies live auth forms,
422 errors, loading, duplicate registration, account isolation, expiry, refresh,
network errors, a simulated protected 401, mobile navigation and overflow.

Run `node tests/browser-auth.mjs --crud` with the same Chrome CDP setup for live
CRUD verification. It creates two uniquely marked businesses, tests real forms,
HTTP tenant isolation, staff permissions, price bounds, persistence, pagination,
network failure and deactivation/deletion constraints. Its guarded fixture helper
changes only its temporary user role and creates one temporary appointment to
exercise reference restrictions; it always removes its disposable schema and
verifies the public database record-ID baseline.

Run `node tests/browser-auth.mjs --appointments` for the appointment browser
suite. It races two authenticated Chrome tabs against the same staff slot,
verifies booking/edit/cancellation/status flows, snapshots, history, walk-ins,
permissions, tenant isolation, persistence and network errors. The shared harness
always removes its owned disposable schema and checks the public database
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

The Day 7 unit suite contained 61 tests. The earlier 56-to-36 count change came from
replacing 33 demo-era customer/storage tests with eight API-era domain tests and
adding five dashboard tests. A further 25 API regression tests preserve relevant
validation, history, snapshot, availability, pagination and isolation coverage.
Obsolete demo-storage migration behavior is no longer part of the application.


Day 8 adds appointment payment balances, entry and paginated receipt history.
Cash, bank transfer, JazzCash and Easypaisa use the authenticated backend API.
Amounts are validated as integer paisa before decimal strings are sent. A
scoped ledger coalesces duplicate clicks and persists only recovery UUID metadata.
The server retains frozen requests across refresh or logout. Reconciliation must
finish before another payment can be recorded; a confirmed receipt requires an
explicit Record another payment action before a new key is issued.

The dashboard and Analytics page use `/api/analytics/revenue`, never completed
booking prices, for collected revenue. Calendar days, Monday-start weeks and
calendar months use the business timezone. The chart and method breakdown cover
30 days ending today; an accessible table exposes exact daily values. Outstanding
balances and payment-status counts cover all non-cancelled appointments, across
all dates. Recorded receipts on cancelled appointments remain collected because
refunds are not implemented. Free appointments count as fully paid.

Revenue refreshes after catalog changes, confirmed payment requests, dashboard
focus refresh and business-local midnight. Refresh revenue retries failed reads;
unavailable revenue is not displayed as zero. Aggregate money uses BigInt paisa,
including totals larger than a single receipt's maximum amount. The chart uses
relative coordinates; monetary values remain exact decimal strings.

Run `node tests/browser-auth.mjs --payments` and `--analytics` for opt-in real
Chrome verification. Payment tests deliberately drop a committed response, retry
after navigation, verify no duplicate receipt, and test both businesses and staff
access. Analytics tests cover timezone boundaries, collection accuracy, payment
refresh, persistence, network failure and mobile layout. The harness now verifies
all nine public application tables and removes disposable schemas without
disabling audit protection.

The unit suite currently contains 102 tests, including payment, revenue and browser
readiness regressions. Readiness predicates are converted to booleans before CDP
serialization; selectors use normal JavaScript quoting, and inherited disabled
state is checked with `:disabled` rather than the input's own disabled property.


### Persistent payment recovery and financial roles

The ledger persists only scoped user/business/appointment UUIDs and an intent UUID.
No JWT, amount, method, reference or customer data is saved in browser storage.
The server retains frozen pending details. Refresh/session loss requires login,
then payment recovery reconciles the prior request before enabling another.
Unresolved server intents are discoverable even without a local pointer. Web Locks
serialize tabs; unavailable/corrupt storage or missing Web Locks blocks new payments.
Only the recording user may resume their pending request. A deliberately new
payment by another employee is not deduplicated by amount/reference.

Only owners see receipt history, revenue analytics and Audit & reconciliation.
Staff can record payments and read appointment balances; backend authorization
remains authoritative. The audit page lists fixed actions, operator/resource UUIDs
and business-local timestamps, with server pagination/action filtering. Its ledger
report uses exact decimal strings, shows stale/error/loading states and reports
inconsistencies without modifying financial records.

### Isolated browser verification

The browser harness now creates and migrates a marked disposable PostgreSQL schema
and starts its own API on 127.0.0.1:8010. It shuts that server down through its
private stdin pipe, drops only the owned test schema, and checks that all nine
public tables are unchanged. It never disables append-only audit protection.
Do not run browser scripts against the normal development API.

Start a dedicated test frontend in a separate terminal (normal frontend/backend
ports 5173/8000 can keep running):

```powershell
Set-Location 'D:\PROJECTS\Portfolio Projects\salonpulse\frontend'
$env:VITE_API_BASE_URL = 'http://127.0.0.1:8010'
npm.cmd run dev -- --host 127.0.0.1 --port 5174 --strictPort
```

Use an isolated Chrome profile with CDP enabled, then run from frontend:

```powershell
$env:SALONPULSE_CDP_URL = 'http://127.0.0.1:9226'
node tests/browser-auth.mjs
node tests/browser-auth.mjs --crud
node tests/browser-auth.mjs --appointments
node tests/browser-auth.mjs --dashboard
node tests/browser-auth.mjs --analytics
node tests/browser-auth.mjs --payments
node tests/browser-auth.mjs --audit
node tests/browser-auth.mjs --mobile
node tests/browser-auth.mjs --loading
```

All test passwords and tokens stay in memory. Migration logs contain no connection
URLs. The harness requires the existing configured local PostgreSQL role to own
new disposable schemas, and refuses unexpected database targets or test-schema
ownership. Financial checks do not reconcile actual bank/provider settlements.

## Production build and security

The build guard requires `VITE_API_BASE_URL` to name an explicit HTTPS API host
without credentials, query or fragment. It applies to production, staging and
other custom build modes. Configure the real public deployment origin before:

```powershell
$env:VITE_API_BASE_URL = 'https://api.salon.example' # replace for deployment
npm.cmd run build
```

The local verification example uses `--mode development` intentionally; do not
ship that preview bundle as production. Vite's environment lookup is relative to
its project directory and does not depend on Node globals in the frontend type
configuration. The explicit .ts config import works with Vite's native-loader
migration and TypeScript's no-emit setting.

Rate-limited authentication returns safe HTTP 429 messages and Retry-After; the
client preserves that error instead of exposing submitted values. Production
backend CORS grants only configured HTTPS origins and never browser credentials.
The static frontend host must apply its own TLS, CSP, frame, referrer and cache
policies: see [deployment security](../docs/production-security.md). Vite preview
is not a production security-header or TLS server.

## Performance and loading

Screens and the booking editor load as separate chunks, preserving the navigation
shell during loading. A failed chunk displays a safe recovery screen; reloading
requires login again because tokens stay in memory. The shell clock updates once
per minute; a targeted booking-start timer preserves timely appointment actions.
Revenue is fetched only on Dashboard/Analytics. Focus refresh preserves editors,
unsaved drafts and feedback. Existing balances remain visible during safe refresh.

See [measured performance and limits](../docs/performance.md) for load results,
pagination bounds, mobile coverage and reproducible disposable-data probes.
