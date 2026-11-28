# SalonPulse

Mobile-first salon management for barbershops and beauty salons in Pakistan.
The existing monorepo contains a React/TypeScript/Vite/Tailwind frontend and a
FastAPI/SQLAlchemy/psycopg/PostgreSQL backend.

Implemented workflows include registration/login, business-scoped customers,
staff and working hours, services, appointments, walk-ins, receipt recording and
revenue reporting. Tokens remain in memory; refreshing requires login again.

- [Frontend setup and browser verification](frontend/README.md)
- [Backend configuration, API contracts and migrations](backend/README.md)
- [Vercel, Render and Neon deployment](docs/deployment.md)
- [Performance, mobile coverage and load testing](docs/performance.md)
- API entry point: `backend/app/main.py`; interactive docs: `/docs`.
- Private `.env`, virtual environments, caches, dependencies and build output are
  Git-ignored. Never put real credentials in tracked examples or frontend settings.

## Windows PowerShell: existing development checkout

Use Node.js 24 and the existing native Windows Python virtual environment. Before
first use, configure PostgreSQL and private backend settings using the backend
README. Do not overwrite an existing `backend/.env`. The frontend uses
`VITE_API_BASE_URL` (default `http://127.0.0.1:8000`); this setting is public and
must never contain secrets. Dependencies are installed; if rebuilding them on a
new checkout, use `npm.cmd ci` in frontend and the backend requirements file.

Frontend terminal:

```powershell
Set-Location 'D:\PROJECTS\Portfolio Projects\salonpulse\frontend'
npm.cmd run dev -- --host 127.0.0.1
```

Backend terminal:

```powershell
Set-Location 'D:\PROJECTS\Portfolio Projects\salonpulse\backend'
$env:DEBUG = 'false'
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --no-proxy-headers --no-access-log --no-server-header --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:5173>. Health checks are
<http://127.0.0.1:8000/health> and <http://127.0.0.1:8000/health/db>.
Stop either server with Ctrl+C. Authentication and business workflows require the
configured database, applied Alembic migrations and a private JWT signing secret.

## Payments

Owners and staff can record full/partial PKR payments and review appointment
balances. Only owners can browse receipt history and financial analytics. Methods: cash, bank transfer, JazzCash and Easypaisa.
Money is sent as decimal strings; the UI validates integer paisa. Cancelled
appointments cannot receive new payments. API writes serialize with appointment
changes to reject overpayments and preserve booked-price consistency.

- `POST /api/appointments/{id}/payments`: record a receipt using a UUID v4
  idempotency key; identical retries return the original receipt.
- `GET /api/appointments/{id}/payment-summary`: necessary balances for owners/staff.
- `GET /api/appointments/{id}/payments`: owner-only paginated history and balances.
- `GET /api/payments/{id}`: one owner-only, tenant-scoped receipt.
- `POST /api/appointments/{id}/payment-intents`: create a durable pending request.
- `GET /api/appointments/{id}/payment-intents/active`: own unresolved intent.
- `POST /api/appointments/{id}/payment-intents/{intent_id}/{action}`: reconcile,
  confirm, cancel or acknowledge; all require the original authenticated actor.

### Recovery after refresh or session loss

Payment intents retain the immutable amount, method and reference on the server.
Browser storage contains only a random intent UUID under a user/business/appointment
UUID key; JWTs, amounts, methods and references are never persisted there. After
refresh, log in again to the same account. Opening payments reconciles its unresolved
intent before enabling a new submission, even if the browser pointer was cleared.
Confirmed outcomes require explicit acknowledgment before another payment. Pending
intents can be confirmed or cancelled; cancellation never reverses a recorded payment.
Unknown requests are closed durably so a delayed submission cannot charge afterward.

Web Locks serialize same-account tabs; unsupported browsers or unavailable/corrupt
recovery storage block new payments safely. Server locking and uniqueness enforce
retry safety across devices. Recovery is scoped to the recording user: another
employee cannot reconcile their colleague's request. A deliberately new payment by
another user is not automatically deduplicated by amount or reference. Server intents
must be retained; deleting them would invalidate retry protection.

## Revenue reporting

The dashboard and Analytics page use `GET /api/analytics/revenue` for actual
collected receipts, not unpaid or completed booking prices. Optional `date` selects
a reporting date in the authenticated business timezone. Totals cover calendar
days, Monday-start weeks and calendar months. A zero-filled 30-day trend and
method breakdown share the same reporting window. Outstanding balances and
paid/partially-paid/unpaid counts cover current non-cancelled appointments across
all dates; they are not historical balances as of the reporting date.

Cancelled appointments are excluded from outstanding balances and payment counts,
but their existing receipts remain collected because refunds are not implemented.
Free appointments count as paid. Financial analytics and receipt history are owner-only.
Staff see necessary appointment balances and their own pending payment details.

## Audit history and financial reconciliation

Owners can open **Audit & reconciliation** for paginated, filterable operator history
and all-time ledger checks. Staff cannot access either API or screen.

- `GET /api/audit-logs?limit=20&offset=0&action=payment.recorded`: owner-only
  history; optional `action` and `resource_id` filters. Maximum page size 100.
- `GET /api/finance/reconciliation`: owner-only all-time receipt totals, active
  booked/paid/outstanding values, cancelled collections and inconsistency counts.

Migration `1deb66be8c11` adds immutable audit metadata. Records contain only tenant,
operator and resource UUIDs, a fixed action and database timestamp. Payments,
bookings/cancellations/repricing, service changes and payment-intent creation or
cancellation append audit rows in the same transaction. Failed audit inserts roll
back the operation; an idempotent payment replay creates no extra financial audit.
PostgreSQL rejects UPDATE, DELETE and TRUNCATE on audit history.

Reconciliation checks overpayments, missing/mismatched payment audits, inconsistent
recovery records, future-dated receipts and exact Decimal balance equations. It
never repairs records or compares bank/provider settlements. Cancelled receipts
remain collected; cancelled appointments have no outstanding balance. Older
receipts without audit attribution are flagged for review, never backfilled with
invented operators. Audit metadata does not store old/new prices or personal data.

The application role currently owns its schema and can execute privileged DDL.
Use a separate migration owner and a restricted runtime role, retention policies,
backups and external monitoring before treating logs as tamper-resistant against
a database administrator. Test fixtures use disposable marked schemas; audit
protection is never disabled to clean up records in the development schema.

## Verification

```powershell
Set-Location 'D:\PROJECTS\Portfolio Projects\salonpulse\frontend'
npm.cmd test
npm.cmd run typecheck
npm.cmd run build -- --mode development
Set-Location '..\backend'
$env:DEBUG = 'false'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:SALONPULSE_RUN_DB_TESTS = '1'
.\.venv\Scripts\python.exe -B -m unittest discover -s tests
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe -B -m alembic current
.\.venv\Scripts\python.exe -B -m alembic check
```

Live database tests accept only the guarded local development database; they use
rollback or migrated disposable schemas with guarded cleanup. Browser suites
require the dedicated Vite server on 5174 and an isolated Chrome CDP session;
the harness owns its API on 8010. See the frontend README.

## Remaining production work

Payments are recorded accounting entries, with no bank/provider settlement checks,
gateways, refunds or corrections workflow. Sensitive financial and booking changes
now have an append-only operator audit trail. Per-business transaction locks
serialize financial and booking operations; production load/latency testing is
still needed. Direct SQL writers must follow the same locking/validation protocol;
aggregate overpayment protection is enforced by application transactions rather
than a database aggregate constraint. Deployment verification, monitoring, provider
settlement and backup/restore drills remain production-readiness work.


## Production security

See [the deployment security contract](docs/production-security.md) before
hosting. Production/staging require validated HTTPS CORS origins, exact API hosts,
strong private JWT/database settings, PostgreSQL TLS hostname verification and
HTTPS enforcement. Start hosted services with `python -m app.serve` behind the
configured TLS proxy; the launcher disables Uvicorn proxy rewriting and access
logs. Only explicitly trusted proxy CIDRs can supply client IP/scheme metadata.
Authentication endpoints enforce bounded per-process limits and return HTTP 429
with Retry-After. A shared ingress limiter is required for multiple replicas.

Local development remains HTTP-compatible. The verification command above uses
an explicitly development-mode bundle for local preview. For production, set the
public `VITE_API_BASE_URL` to your actual HTTPS API hostname and run
`npm.cmd run build`; missing/insecure values fail before bundling. API security
headers do not configure the independently hosted static frontend. TLS, static
CSP/headers, network restrictions, external log redaction and distributed abuse
controls remain deployment responsibilities. No production infrastructure was
created or verified by this local hardening task.
