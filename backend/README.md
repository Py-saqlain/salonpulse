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
restart the backend after changing configuration. JWT configuration is unused.

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
rolls back any uncommitted transaction. Future writes must explicitly commit. Application
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
never commit or run DDL. They check record IDs before/after the suite and confirm
that the existing service index was not recreated. No existing records are used
as update/delete targets. Both the initial and users revisions must already be
applied. User fixtures use unusable test-only hash values; no hashing utilities
or persistent login accounts are created by these tests.

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

Roles are restricted to `owner` and `staff` in the ORM and database; owner and
active are the requested defaults. These defaults are not an authorization
policy. Future public registration must use an explicit input schema excluding
role, business_id, is_active, and password_hash. Trusted server code must assign
the new business/owner relationship and hash the password before constructing a
User. Staff invitation/role changes must require explicit authorization. No
registration, login, JWT, or hashing utilities are implemented in this task.
Email syntax/deliverability validation also belongs in the future input layer.

Unit tests compile PostgreSQL migration DDL without executing it. Opt-in live
tests validate all six tables and check required membership, global normalized
email uniqueness, valid roles, business foreign keys, restricted deletion, and
server defaults. Fixtures are always rolled back and all six tables are checked
for unchanged record IDs afterward. Tests never apply migrations implicitly.
