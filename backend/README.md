# SalonPulse backend

Run commands below from `backend/` in Windows PowerShell. Use the existing
virtual environment; no PostgreSQL tables are created by this application.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -m pip check
$env:DEBUG = 'false'
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload
```

With the environment activated, the startup command is also
`python -m uvicorn app.main:app --reload`. This machine previously inherited
`DEBUG=release`; the explicit override above supplies a valid boolean.

## Private local configuration

Create or edit `backend/.env` privately in your editor. If it does not already
exist, copy `.env.example` to `.env`. Do not overwrite existing configuration.
Never put real credentials in source, shell commands, logs, or chat.

Set this line with your actual password only in the private `.env` file:

```dotenv
DATABASE_URL=postgresql+psycopg://salonpulse_app:REPLACE_WITH_URL_ENCODED_PASSWORD@localhost:5432/salonpulse_dev
```

Percent-encode special characters in the password, such as `@`, `:`, `/`, `#`,
and `%`, before putting it into the URL. Do this privately, not through a public
online encoder. `.env` is ignored by Git. Environment variables override `.env`;
restart the backend after changing configuration. JWT configuration is described
under Authentication below.

## Connection behavior

`app/db/session.py` owns one lazy synchronous SQLAlchemy engine and session
factory per application process. It requires the explicit `postgresql+psycopg`
driver. The psycopg binary extra supplies Windows-compatible driver libraries.
No database is contacted at import time or startup.

The pool allows 5 persistent connections plus 5 overflow connections per worker,
checks connections before reuse, recycles them after 1,800 seconds, and waits up
to 5 seconds for a pool slot. Connection and statement timeouts are 5 seconds.
These conservative defaults should be revisited when deployment worker counts
and PostgreSQL connection limits are known.

`get_db` provides a session per request. Session exit closes the session and
rolls back any uncommitted transaction. Registration explicitly commits its
business/user transaction atomically. Application
shutdown disposes the engine pool. SQL logging is disabled, parameters are hidden,
and handled database failures return a generic response.

## Health checks

- `GET /health`: HTTP 200, `{"status":"ok"}`, independent of the database.
- `GET /health/db`: executes `SELECT 1`; returns HTTP 200, `{"status":"ok"}`,
  or HTTP 503, `{"detail":"Database unavailable"}`. Missing or invalid
  configuration also returns 503. This check verifies connectivity only.
- `GET /docs`: existing Swagger documentation, unchanged.

After configuring the private URL and starting the server, verify locally:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8000/health'
Invoke-RestMethod 'http://127.0.0.1:8000/health/db'
```

Automated database tests mock SQLAlchemy or override FastAPI dependencies. They
do not require PostgreSQL or a real password. Live database connectivity must be
verified after you enter the private local URL. No credentials are generated.

## Migration configuration

Alembic reads `DATABASE_URL` from the same Pydantic Settings as FastAPI. No URL
is stored in `alembic.ini`; URL objects are passed directly to SQLAlchemy so
percent-encoded passwords do not pass through INI interpolation. All ORM
models are registered through `app.models` before metadata is inspected.

From `backend/`, inspect the revision and database state with:

```powershell
$env:DEBUG = 'false'
.\.venv\Scripts\python.exe -m alembic heads
.\.venv\Scripts\python.exe -m alembic history
.\.venv\Scripts\python.exe -m alembic current
```

The initial revision is `b56e17b6641d` (`create initial salonpulse schema`). It
has been applied to the local development database. Other environments require
a separate migration deployment step; application startup does not create tables.

Future revision generation uses `python -m alembic revision --autogenerate -m
"describe schema change"` after the previous revision has been applied.
CLI autogeneration, `current`, and `check` use a PostgreSQL read-only transaction
and disable Alembic's automatic version-table creation. Programmatic callers of
inspection/autogeneration commands must set `config.attributes["read_only"] = True`.

Type and server-default comparisons are enabled. The named CHECK constraint
plugin detects added/removed checks; it does **not** detect expression changes
under an unchanged constraint name. Always review generated revisions, including
enum checks and any proposed drops. Model `onupdate` timestamps remain a
SQLAlchemy behavior, not a database trigger. Migration tests compile and compare
PostgreSQL DDL using a mock engine without executing database operations.

The active-service-name index uses `lower(TRIM(BOTH FROM name))` in the ORM,
matching PostgreSQL's reflected spelling of the original `lower(trim(name))`.
The existing index and initial revision are unchanged; index comparison remains
enabled without custom filters. The applied schema, including users, has no
drift.

## Optional live database integrity tests

The default suite does not connect to PostgreSQL. To include the live integrity
tests, run from `backend/` with the private `.env` configured:

```powershell
$env:DEBUG = 'false'
$env:SALONPULSE_RUN_DB_TESTS = '1'
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
Remove-Item Env:SALONPULSE_RUN_DB_TESTS
```

The live suite refuses any URL except the local `salonpulse_dev` database on port
5432 as `salonpulse_app`, and verifies the connected database/role/port too. Each
test creates unique temporary records inside an outer transaction, uses savepoints
for expected constraint violations, and rolls back on success or failure. Tests
never commit the outer transaction or run DDL. They check record IDs before/after the suite and confirm
that the existing service index was not recreated. No existing records are used
as update/delete targets. Both the initial and users revisions must already be
applied. Integrity fixtures use unusable test-only hash values; authentication
fixtures exercise real hashing. No persistent login accounts are created.

A live downgrade/upgrade round-trip requires a separately provisioned disposable
database. Never run that round-trip against `salonpulse_dev`.

## User model foundation

Revision `6d7519d70bb2` (`add users table`) depends on `b56e17b6641d`. It only
adds `users`, a business-ID index, and a global unique index on `lower(email)`.
The local development database is at `6d7519d70bb2`, with the users table present
and no persistent user accounts. `alembic heads` and `alembic current` show this
revision, and `alembic check` reports no pending changes. Other environments
require a separate migration deployment step.

User is a login identity independent of the employee Staff record. Email is
trimmed/lowercased on ORM assignment; database checks require normalized nonblank
email and a case-insensitive unique index prevents duplicates across businesses,
including inactive users. There is no redundant plain-email unique index.
Full name and password hash must be nonblank. The business foreign key uses
`RESTRICT`, and ORM relationships do not cascade-delete users. Timestamps and
UUID generation follow the existing models.

Roles are restricted to `owner` and `staff` in the ORM and database. Registration
uses an explicit input schema excluding role, business_id, is_active, and
password_hash; unknown fields are rejected. Server code assigns the new business
and active owner role and hashes the password before constructing a User. Future
staff invitation/role changes must require explicit authorization. Email syntax
is validated, while ownership/deliverability verification is not implemented.

Unit tests compile PostgreSQL migration DDL without executing it. Opt-in live
tests validate all six tables and check required membership, global normalized
email uniqueness, valid roles, business foreign keys, restricted deletion, and
server defaults. Fixtures are always rolled back and all six tables are checked
for unchanged record IDs afterward. Tests never apply migrations implicitly.

## Authentication

Install the pinned requirements in the existing virtual environment. Passwords
use pwdlib with Argon2id and independent random salts. Registration passwords
must contain 12–128 characters and cannot be entirely whitespace; spaces within
a password are preserved. Passwords and hashes are excluded from responses and
submitted values are omitted from validation errors.

Both endpoints accept **JSON**, documented at `/docs`:

| Endpoint | Request fields | Success |
| --- | --- | --- |
| `POST /api/auth/register` | `business_name`, `full_name`, `email`, `password` | HTTP 201: public user fields including `id`, `business_id`, `full_name`, `email`, `role`, `is_active` |
| `POST /api/auth/login` | `email`, `password` | HTTP 200: `access_token`, `token_type: "bearer"` |

Names are trimmed and emails are trimmed/lowercased. A globally unique email
conflict returns HTTP 409; PostgreSQL's unique index resolves concurrent races,
and registration rolls back both records if either insert or commit fails.
Missing users, wrong passwords, and inactive users receive the same HTTP 401
message. Unknown users still perform dummy Argon2 verification. Login responses
use `Cache-Control: no-store` and `Pragma: no-cache`.

Tokens use fixed HS256 with `sub` (canonical User UUID), `iat`, and `exp` claims.
Signature, algorithm, expiry, issued-at time, required claims, and subject format
are validated. `get_current_user` loads the live User and rejects deleted/inactive
accounts. Roles and businesses come from the database, not client-provided token
claims. Customer, staff, and service CRUD endpoints are described below;
appointment endpoints are described in the appointment-management section.

### Private signing-key setup

The signing key is read from `JWT_SECRET_KEY` through Pydantic Settings and must
contain at least 32 bytes. Use a cryptographically random key, not a memorable
password. To generate a key from **32 random bytes** and save it directly into
the existing ignored `backend/.env` without displaying it, run from `backend/`:

```powershell
.\.venv\Scripts\python.exe scripts/configure_jwt.py
```

This command only provisions a missing/blank JWT key. It retains an existing
valid key and preserves other settings; it stops if an existing key is too short.
It is a manual setup command, never executed automatically at server startup.
Do not paste the key into chat, source code, command arguments, or logs. Protect
the private file with your normal local account permissions. No real key is
included in `.env.example`. Restart the backend after provisioning. Environment
variables take precedence over `.env`, so remove any unintended JWT override
privately before starting the server.

Set `ACCESS_TOKEN_EXPIRE_MINUTES` privately if needed (default 30; allowed range
1–1440). A missing signing key leaves health/docs available while auth endpoints
return HTTP 503 without registering users. An explicitly configured key shorter
than 32 bytes fails settings validation with input values hidden.

### Authentication checks and deployment limits

The opt-in test command above includes live registration/login tests on the
guarded local development database. Registration commits occur inside an outer
test transaction, so all fixtures are rolled back; all six tables are checked
for unchanged IDs afterward. Tests use random, process-local signing keys rather
than the real `.env` key. Commit-time unique-conflict handling is also simulated
to exercise the concurrent-registration error path.

Before internet deployment, add rate limiting/abuse controls and HTTPS. Email
ownership verification, refresh tokens, password reset, MFA, token revocation,
and signing-key rotation are not implemented. Existing tokens expire naturally;
account deactivation is checked by the bearer dependency. Frontend token storage
and integration remain outside this backend task.

## Authorization and tenant isolation

`GET /api/auth/me` returns the active authenticated user's safe profile.
`GET /api/business/me` returns that user's own business: ID, name, timezone,
currency, and timestamps. Both accept `Authorization: Bearer <access token>`,
allow owner and staff identities, and send `Cache-Control: no-store`. Query
parameters or headers such as `business_id`, `role`, and `X-Business-ID` cannot
override identity, role, or business context. Passwords, hashes, and internal
settings are never included. No public test endpoints are registered.

Reusable FastAPI dependencies in `app/api/dependencies.py`:

- `get_current_user`: validates the JWT and loads the active login identity.
- `require_owner`: permits only owners; staff receives HTTP 403.
- `require_owner_or_staff`: permits both supported roles.
- `get_current_business`: loads the tenant root using the live user's business ID.
- `get_tenant_scope`: creates an immutable scope from that same user record.

Missing/invalid authentication returns HTTP 401 with a Bearer challenge.
Insufficient role permission returns HTTP 403. The current database role is
checked on each request, so a role change takes effect even for an older token.

CRUD services receive `TenantScope` via `Depends(get_tenant_scope)`.
`app/db/tenant.py` provides scoped `select`, `get`, `update`, and `delete` methods
for Customer, Staff, Service, and Appointment. Single-record operations combine
the business ID and resource UUID in the SQL predicate, including update/delete
statements. Missing and cross-business records produce the same HTTP 404.
Updates cannot change IDs, tenant ownership, or timestamps. Login users and
Business roots are excluded from these generic write helpers. Helpers do not
commit: the calling service owns transactions and must validate mutable fields.

Select role permission separately from scoping when introducing mutation
routes. Scoping does not itself grant permission to write or bypass historical
foreign-key restrictions. Existing composite foreign keys remain unchanged.
Login identity lookup by signed subject and tenant-root resolution are distinct
from tenant resource lookups. This is explicit application-level scoping, not
PostgreSQL row-level security: future code must consistently use these helpers.

Opt-in rollback-only tests cover independent business profiles, bearer failures,
deleted/inactive users, owner/staff permissions, role/tenant claim manipulation,
and cross-tenant reads/updates/deletes for all four resource models. Role test
routes are attached only to isolated test app instances.

## Customer, staff, and service CRUD

Each collection supports the following authenticated JSON API:

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/customers`, `/api/staff`, `/api/services` | HTTP 201 with the created record |
| GET | same collection paths | HTTP 200 paginated list |
| GET | collection path + `/{id}` | HTTP 200 with one tenant-scoped record |
| PATCH | collection path + `/{id}` | HTTP 200 with the updated record |
| DELETE | collection path + `/{id}` | HTTP 204 with no body |

Owners and staff identities can read all three resources and manage customers.
Only owners can create, edit, or delete staff and services. Every operation
derives the business ID from the current database user. Input fields such as
`business_id`, `id`, or `role` are rejected rather than mass-assigned. Cross-tenant
and missing UUIDs return the same HTTP 404; invalid UUID syntax returns HTTP 422.

Create fields (all records require a trimmed nonblank `name`, max 200 characters):

- Customer: optional `phone`, `notes` (max 4,000 characters).
- Staff: optional `phone`, `specialty` (max 200 characters), `active` (default true).
- Service: required integer `duration_minutes` (1–1,440), required `price` (PKR,
  nonnegative, max 12 digits including two decimal places); optional `category`
  (max 100 characters), `active` (default true).

Pakistani mobile formats `03...`, `923...`, `00923...`, and `+923...` are normalized
to `+923...`; spaces, parentheses, and hyphens are accepted. Missing/blank phone
numbers become NULL. Nonblank phones must be unique per business within their
resource type. Names need not be unique for customers/staff. Active service names
must be unique within a business after trimming and case normalization; inactive
duplicates are allowed, and reactivation is checked against that same index.

PATCH requires at least one supported field. Omitted fields are preserved;
explicit NULL clears nullable phone/notes/specialty/category fields. Required
fields cannot be cleared. Boolean fields require JSON booleans, and money values
are returned as decimal strings to preserve precision.

List query parameters are `limit` (default 20, range 1–100) and `offset` (default 0,
nonnegative). Responses contain `items`, `total`, `limit`, and `offset`. Counts
and rows are tenant-filtered, ordered by creation time descending then UUID for
stable pagination. There are no search/filter parameters yet.

Duplicate conflicts return HTTP 409 without exposing database details. Deleting
a record referenced by an appointment returns HTTP 409; history is never cascaded
away. Staff/services can instead be explicitly marked inactive using PATCH.
Service price/duration edits do not rewrite appointment snapshots or timing.
Staff working-hours models and frontend integration remain outside this CRUD task.

The shared resource service commits validated writes atomically, including the
transaction opened by authentication; failures roll back the request session.
Deletion is permanent only for unreferenced records. Rollback-only integration
tests cover CRUD, tenant isolation, owner/staff permissions, pagination, invalid
inputs, normalized duplicates, and appointment-reference protection.

## Appointment management

Owners and staff can use POST/GET `/api/appointments` and GET/PATCH/DELETE
`/api/appointments/{id}`. All lookups and writes are tenant-scoped. Foreign or
missing customer/staff/service/appointment IDs return HTTP 404 without disclosing
another business's records. No migrations or schema changes were needed.

POST accepts `customer_id`, `staff_id`, `service_id`, optional `booking_type`
(`scheduled` by default), and `starts_at` as an ISO datetime **with a timezone**.
Scheduled appointments require a future start time and begin `confirmed`.
Walk-ins use `booking_type: "walk_in"`, omit `starts_at`, and receive the server's
current UTC start and `in_progress` status. Both require active staff/services.
The server derives business ID, end time, price, duration, and initial status;
clients cannot supply snapshot/end/identity fields.

PATCH accepts customer/staff/service IDs, a timezone-aware start, status, and
`recalculate_service` (boolean). Only confirmed appointments can change booking
details. Booking edits must remain in the future, use active staff/services, and
pass the same overlap validation. Normal edits retain the saved price/duration.
Choosing a different service recalculates both snapshots; for the same service,
send `recalculate_service: true` explicitly to adopt current catalog values.
Recalculation also rechecks the newly computed end time for conflicts. Change
booking details and status in separate requests.

Status transitions are `confirmed -> in_progress -> completed`, with cancellation
allowed from confirmed/in-progress. Starting before the scheduled time is
rejected. In-progress booking details and terminal records cannot be edited;
cancelled bookings cannot be reactivated. Repeating the current status is an
idempotent no-op for booking fields. Early completion is allowed once started.

DELETE is **cancellation**, not permanent deletion: it returns HTTP 204 and keeps
the record available to GET/history. Repeated cancellation is safe. Completed
records cannot be cancelled/deleted (HTTP 409). Cancelled/completed records no
longer reserve a staff slot. Confirmed/in-progress intervals block overlapping
bookings for the same staff; adjacent intervals are allowed. Overlaps and invalid
transitions return HTTP 409, while invalid times/input return HTTP 422.

List responses use `items`, `total`, `limit` (1–100, default 20), and `offset`.
Optional filters are `date=YYYY-MM-DD`, `staff_id`, and `status`. Date means the
appointment's **start date in the business timezone** (Asia/Karachi by default),
with UTC boundaries calculated server-side. A foreign staff filter returns 404.
Appointment response timestamps are consistently serialized in UTC, independent
of the PostgreSQL session timezone.
Ordering is start time then UUID. Cancelled/completed rows remain included unless
filtered out.

### Concurrent booking protection

Each create/edit/status/cancellation transaction first locks its existing
Business row with PostgreSQL `FOR NO KEY UPDATE`. This serializes appointment
writes within that business, including staff reassignments and reschedules,
while other businesses remain independent. The engine explicitly uses
`READ COMMITTED`, so the conflict query after the lock sees preceding committed
bookings. Locks remain held until commit/rollback. Foreign-key checks and the
original constraints remain unchanged. No exclusion constraint was introduced.

This guarantee covers these API/service writers; direct SQL or future writers
must follow the same locking protocol. Lock timeouts safely roll back rather
than creating an unchecked booking. The coarse business lock is suitable for
this prototype; a later high-throughput design may use finer locks or a reviewed
database exclusion constraint. No staff hours/leave/actual-duration tracking is
modeled yet. Planned end times remain duration snapshots, not actual checkout.

Tests cover booking CRUD, walk-ins, snapshots, statuses, history, PKT date
boundaries, pagination, tenant checks, and two independent PostgreSQL connections
racing to create/reschedule into the same slot. Most tests roll back outer
transactions; concurrency tests commit uniquely marked disposable fixtures so
both connections can see them, then always run targeted cleanup. No persistent
test appointments or accounts are retained.
