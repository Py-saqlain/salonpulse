# Performance and mobile verification - 28 November 2026

## Scope and measured results

Measured on the local Windows development workstation and PostgreSQL 17, using
one Uvicorn process, a production-sized connection pool (5 persistent + 5 overflow),
and synthetic data in owned disposable schemas. These are local measurements,
not a production throughput guarantee or internet/mobile network benchmark.
Raw results: [baseline](performance-baseline.json),
[optimized stress profile](performance-optimized.json),
[typical salon profile](performance-typical.json).

| Measurement | Before | After |
| --- | ---: | ---: |
| Stress dashboard catalog requests | 252 | 1 |
| Records materialized for dashboard | 25,200 | 25 |
| Catalog/workspace response bytes | 11,796,638 | 6,181 |
| Catalog/workspace load time | 25,609.65 ms | 116.19 ms |
| Mixed reads, 10 concurrent: p50 | 558.13 ms | 287.59 ms |
| Mixed reads, 10 concurrent: p95 | 1,501.74 ms | 627.95 ms |
| Mixed reads, 100 requests: errors | 0 | 0 |
| Reconciliation standalone median | 296.84 ms | 189.25 ms |

The baseline loaded four complete directories; the replacement returns the SQL
summary and bounded display rows. These response shapes intentionally differ.
Mixed reads cover directory/appointments before, workspace dashboard/appointments
after, and revenue/reconciliation in both versions. All use one authenticated
owner identity with 10 concurrent request workers, not 10 distinct active users.
Five sequential samples precede each 100-request run. The isolated harness uses
a 10-second statement timeout versus the application's 5 seconds; observed
responses stayed well below both limits. Local scheduling, caches
and concurrent workstation activity introduce noise. Standalone revenue median
was 116.75 ms before and 152.05 ms after; this is not a claim that every query is
faster. The main gains are bounded transfer/memory and concurrent reporting.

The stress profile contains 5,000 customers, 100 staff, 100 services, 20,000
appointments and 12,000 payments (plus matching audit rows). A second profile
uses 1,000 customers, 10 staff, 30 services, 5,000 appointments and 3,000 payments,
with 09:00-18:00 Pakistan working hours and non-overlapping half-hour slots.
Its dashboard returned 15 rows/5,028 bytes in 85.76 ms; mixed-read p95 was
579.64 ms with zero errors. The stress profile uses broad working hours to match
the pre-change workload. Seed prices are PKR 1,000 and partial receipts PKR 500;
independent Decimal oracles verify collected/outstanding totals before and after
concurrent writes. Twenty identical retries produce one receipt; twenty distinct
one-paisa partial payments produce twenty receipts with exact reconciliation.

## Changes and query review

- PostgreSQL applies tenant-scoped search, filters, counts and 20-row pagination.
  Customer history is bounded separately; visits/last visit remain global SQL
  aggregates. Dashboard status totals and workload include all matching records.
- Booking selectors search the whole tenant through bounded option pages. The
  selected historical record is pinned separately. No production code calls the
  legacy full-catalog loader; its compatibility helper now refuses over 200 rows.
- Appointment names are joined, and payment balances are aggregated once per
  returned page. No per-row balance requests are needed on the appointment list.
- Four additive indexes cover tenant-first directory ordering and payment date
  aggregation. EXPLAIN ANALYZE showed an Index Only Scan under Limit for the
  customer page (0.239 ms stress, 0.383 ms typical). Existing tenant/count/FK and
  appointment interval indexes are retained. No PostgreSQL extension installed.
- Reporting uses shared business locks: readers coexist but still exclude
  financial/booking writers. Writers keep existing serialization, retry handling,
  tenant checks, snapshots and atomic audit records. Tests verify both reader
  coexistence and reader/writer exclusion.
- The pool stays bounded at 10 connections/process with pre-ping, 5-second wait
  and statement limits and 1,800-second recycling. Increasing worker count must
  fit PostgreSQL's connection budget; no arbitrary pool expansion was made.
- Search debounces 250 ms and aborts obsolete requests. Only the active screen
  loads data; financial analytics are requested only on Dashboard/Analytics.
  Editors, drafts and feedback survive refreshes. Failed requests remain retryable.
- Screens and booking editor are lazy chunks with shell-preserving loading/error
  recovery. The shell clock renders once per minute, with targeted midnight and
  booking-start refreshes. Intl formatters are cached in a small bounded map.

Migration `795150f8a1a2`, parent `1deb66be8c11`, adds only the four indexes; it was
reviewed and applied to the guarded local development target. No prior migration,
table, financial record, constraint or audit trigger was removed or weakened.

The production entry chunk fell from 325.70 KB (99.16 KB gzip) to 263.66 KB
(84.07 KB gzip): about 19% less initial JavaScript, before loading individual
screens. Total bytes across all lazy chunks are not claimed to decrease.

## Mobile and regression coverage

Chrome browser checks cover widths 320, 390, 768 and 1,280 px: every page,
navigation, customer/staff/service forms, booking and quick-customer dialogs,
and payment dialogs with long unbroken names. The payment dialog now wraps long
headings correctly. Route-load failure recovery is exercised without bypassing
authentication. Existing CRUD, two-tenant isolation, pagination/search, dashboards,
working hours, payment recovery, permissions and audit checks remain active.

## Reproduction (Windows PowerShell)

Run from `backend/` using the existing virtual environment and private local
configuration. No credentials appear in these commands or saved results.

```powershell
$env:DEBUG = 'false'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:SALONPULSE_RUN_DB_TESTS = '1'
.\.venv\Scripts\python.exe -B tests/performance_probe.py ../docs/performance-optimized.json --optimized
.\.venv\Scripts\python.exe -B tests/performance_probe.py ../docs/performance-typical.json --optimized --typical
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -B tests/live_payments.py
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe -B -m alembic current
.\.venv\Scripts\python.exe -B -m alembic check
```

Run probes serially without other tests to reduce measurement interference. They
migrate a uniquely marked schema, start an isolated API on a free local port,
seed disposable records, verify financial results, stop the API and remove only
the owned test schema. Public row identities are compared before/after. Database
target guards restrict these scripts to local `salonpulse_dev`/`salonpulse_app`.
The baseline JSON was captured before the implementation; default probe mode
retains the old full-directory request workload for comparison, but running it
now uses the current backend/indexes and does not recreate the original baseline.

Frontend verification from `frontend/`:

```powershell
npm.cmd test
npm.cmd run typecheck
$env:VITE_API_BASE_URL = 'https://api.salon.example' # verification-only public placeholder
npm.cmd run build
```

Use the isolated Chrome/API/Vite setup in [frontend README](../frontend/README.md)
for browser modes auth, crud, appointments, dashboard, analytics, payments, audit,
mobile and loading. Tests never remove public audit records or disable triggers.

## Remaining deployment limits

Offset pagination is bounded (workspace pages 0-5,000; API offsets at most
100,000). Deep offsets still cost more; filter results before paging. Cursor
pagination is a future improvement for larger datasets. Substring search scans
the tenant's matching directory; no trigram extension or speculative index was
added without production evidence. Financial aggregation still reads all relevant
ledger records in SQL; larger deployments may need reviewed summaries rather
than browser materialization. Shared reports can delay a writer until the short
report transaction ends; per-business writes remain serialized deliberately.

This test is not a sustained soak, many-tenant capacity test, provider settlement
check, device-farm test or simulated slow-network benchmark. Deployment needs TLS,
static caching/compression for lazy chunks, monitored PostgreSQL/worker limits and
production load measurements. Initial JavaScript savings refer to the entry
chunk; users visiting every screen eventually download additional lazy chunks.

## Final acceptance results

- Backend: 238/238 tests, including live rollback/disposable-schema regressions.
- Frontend: 102/102 tests; TypeScript and guarded production build pass.
- Browser: 720 checks across auth (19), CRUD (121), appointments (72), dashboard
  (126), analytics (135), payments (82), audit (47), mobile (112), loading (6).
- Additional live HTTP payment suite: 64 checks across two businesses.
- `pip check`: clean. Alembic: `795150f8a1a2 (head)`, no pending schema operations.
- Both health endpoints: HTTP 200. All nine public application tables empty;
  no disposable schemas remain. 32 checks, 17 foreign keys, nine uniqueness
  constraints and 20 explicit indexes verified; audit trigger remains enabled.
- Source/build/history secret review found no URL/signing-key exposure or new
  password literals. Pre-existing numeric overlap in phone fixtures was verified
  against HEAD; no credential values are recorded here. Private `.env` stays
  ignored and untracked.
