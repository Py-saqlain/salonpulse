# Vercel + Render + Neon deployment runbook

Prepared 28 November 2026. This prepares source/configuration only: no hosting
project, paid resource, hosted role, certificate or production migration has been
provisioned or verified. Keep the existing local `backend/.env` unchanged.

## Release topology and account decisions

- Vercel hosts only `frontend/dist`, with Node 24.x and the committed npm lockfile.
- Render runs one Python 3.13.17 process from `backend/`, behind its TLS ingress.
- Neon PostgreSQL 17 holds a new dedicated `salonpulse_prod` database. Choose a
  region close to Render and benchmark latency from Pakistan before launch.
- Choose the real frontend/API domains and create the projects with your own
  accounts. Review plan/billing, backup/PITR retention, resource limits and region
  availability first. Nothing in this task authorizes a paid subscription.

The Render Blueprint is `render.yaml` (JSON syntax, a valid YAML subset). It
explicitly selects the free plan and disables automatic deploys. Free-tier sleep,
capacity and availability are unsuitable assumptions for a commercial launch;
choosing a paid plan is a separate owner decision. The Blueprint contains no
Neon provisioning, automatic migrations or shared migration credentials.

## 1. Neon: dedicated database and limited roles

1. In Neon, select/create the intended project and production branch, PostgreSQL
   17, then create an **empty dedicated database named `salonpulse_prod`**, owned
   by the project administrator. Do not import the local development database.
2. Obtain its **direct** endpoint hostname from Connection Details; do not use the
   `-pooler` hostname with this release configuration. Record the endpoint and
   branch privately, and verify the database/role selection before any command.
3. Connect as the project administrator using `psql` and an interactive password
   prompt. Configure a trusted CA bundle and `PGSSLMODE=verify-full`. Do not put a
   password or connection URL in shell arguments, SQL editor history or chat.

Example PowerShell (replace public host and CA path; passwords are prompted):

```powershell
$env:PGHOST = 'ep-REPLACE.REGION.aws.neon.tech'
$env:PGPORT = '5432'
$env:PGDATABASE = 'salonpulse_prod'
$env:PGUSER = 'YOUR_NEON_ADMIN_ROLE'
$env:PGSSLMODE = 'verify-full'
$env:PGSSLROOTCERT = 'C:\PRIVATE\trusted-ca-bundle.pem'
& 'D:\PostgreSQL\17\bin\psql.exe' -X -W
```

Inside this private interactive session, from the repository's backend directory:

```text
\set ON_ERROR_STOP on
\conninfo
\i scripts/neon-bootstrap.sql
\password salonpulse_migrator
\password salonpulse_runtime
\q
```

Use independent password-manager-generated random passwords (at least 24 random
bytes encoded safely), saved only in private secret stores. The bootstrap script
contains no passwords. It refuses the wrong database, existing public tables,
elevated existing roles or role memberships. Do not bypass those guards. It can
be repeated only before application tables exist; later grants are managed by
the migration runner. No production role SQL is executed against the local DB.

Create these roles **with the SQL script**, not the Neon Console's default role
creation: console/API-created roles can inherit `neon_superuser`. SQL-created
roles start with limited privileges. See [Neon roles](https://neon.com/docs/manage/roles).

| Role | Purpose and permissions |
| --- | --- |
| `salonpulse_migrator` | LOGIN, owns application tables/functions, CREATE in public schema; no superuser, CREATEDB, CREATEROLE, replication, bypass-RLS or inherited role memberships |
| `salonpulse_runtime` | LOGIN, CONNECT/USAGE; CRUD on operational tables; SELECT/INSERT only on payments and audit logs; SELECT only on alembic_version; no DDL, TEMP, TRUNCATE, REFERENCES, TRIGGER or owner membership |

UUID keys need no sequence grants. Default PUBLIC table/function grants are
revoked. New tables need an explicit reviewed runtime grant. The append-only
audit trigger stays enabled; runtime cannot own/replace it or delete receipts.
The migrator remains a privileged release identity and must never be given to
the running API. Runtime is still shared across tenants: application filters and
composite foreign keys provide tenant isolation; PostgreSQL RLS is not implemented.

## 2. Separate migration operator

Use a trusted release machine/job, separate from Render's runtime environment.
Use this exact commit and its pinned backend requirements. Copy
`backend/.env.migration.example` to a **private ignored** file outside source,
for example `C:\PRIVATE\salonpulse.env`. Never copy over `backend/.env`.
Set these privately:

| Setting | Value |
| --- | --- |
| `MIGRATION_DATABASE_URL` | `postgresql+psycopg` URL for **salonpulse_migrator**, direct Neon host, `salonpulse_prod`, `sslmode=verify-full` and `sslrootcert` pointing at the release machine's trusted PEM CA bundle |
| `DEPLOY_DATABASE_HOST` | Exact direct Neon endpoint hostname |
| `DEPLOY_DATABASE_NAME` | `salonpulse_prod` |

URL-encode the password and CA path query value privately. Never paste the real
URL into command arguments, logs, issue reports or frontend variables. The
migration runner does not load the local `.env` and needs no JWT secret. Restrict
the private file to your OS account and exclude it from sync/backup tooling that
does not protect secrets. Do not run from an untrusted pull request or preview.

Review the migration history and SQL before release; take a verified provider
backup/PITR checkpoint or isolated Neon branch and rehearse restoration. Current
head is `795150f8a1a2`. First release on the new empty database:

```powershell
Set-Location 'D:\PROJECTS\Portfolio Projects\salonpulse\backend'
.\.venv\Scripts\python.exe -B -m app.deployment migrate --env-file 'C:\PRIVATE\salonpulse.env' --expected-revision empty
```

For later releases, replace `empty` with the **verified currently applied revision**
from the production database. The runner verifies exact Neon host/database/user,
TLS and non-elevated role, uses NullPool, acquires a transaction advisory lock,
checks the expected revision, upgrades to this checkout's head, and grants reviewed
runtime privileges in the same transaction. Lock timeout is 5 seconds; statement
timeout is 60 seconds. A fresh read-only Alembic comparison follows. Failures print
only a safe message and exit nonzero. If the final comparison fails after commit,
do not start/promote the API; inspect privately and fix forward. No automatic
downgrade, reset, stamp or destructive cleanup is provided.

This command is intentionally **not** the Render build/start command. Do not add
`MIGRATION_DATABASE_URL` to the web service, and do not run upgrades as runtime.
Render pre-deploy commands require an eligible paid service; using one would also
make its environment available to the runtime unless separately isolated. A
separate protected release job/operator is the chosen boundary here. See
[Render deploy lifecycle](https://render.com/docs/deploys).

## 3. Render backend

1. Connect GitHub `Py-saqlain/salonpulse`, branch `main`. Review `render.yaml`
   before creating a Blueprint; leave automatic deployment off.
2. Root Directory: `backend`. Python: `3.13.17`. Build command:
   `python -m pip install -r requirements.txt && python -m pip check`.
3. Start command:
   `python -m app.deployment check-runtime && python -m app.serve --host 0.0.0.0 --port $PORT`.
   Render expands `$PORT` in its Linux shell; do not use PowerShell syntax there.
4. Set the following dashboard environment variables. Values ending `.example`
   are public placeholders and must be replaced with your real hosts.

| Variable | Required production value |
| --- | --- |
| `APP_ENV` | `production` |
| `DEBUG` | `false` |
| `HTTPS_ONLY` | `true` |
| `DOCS_ENABLED` | `false` |
| `DATABASE_URL` | Secret runtime URL, user **salonpulse_runtime**, direct Neon host, database `salonpulse_prod`, `sslmode=verify-full&sslrootcert=/etc/ssl/certs/ca-certificates.crt` |
| `DEPLOY_DATABASE_HOST` | Exact direct Neon hostname matching DATABASE_URL |
| `DEPLOY_DATABASE_NAME` | `salonpulse_prod` |
| `JWT_SECRET_KEY` | Independent cryptographically random secret, at least 32 bytes; generate/store privately |
| `JWT_ISSUER` | Canonical API HTTPS origin, e.g. `https://api.salon.example` |
| `JWT_AUDIENCE` | `salonpulse-web` |
| `ACCESS_TOKEN_EXPIRE_MINUTES` | `30` |
| `CORS_ORIGINS` | JSON array of exact frontend origins, e.g. `["https://salon.example"]` |
| `TRUSTED_HOSTS` | JSON array of exact API hosts, e.g. `["api.salon.example","YOUR-SERVICE.onrender.com"]` |
| `TRUSTED_PROXIES` | JSON array of **verified ingress transport IPs/narrow CIDRs**; must be confirmed with Render for the actual topology |
| `PYTHONDONTWRITEBYTECODE` | `1` |
| `PYTHON_VERSION` | `3.13.17` |

Optional security tunables retain safe production defaults: `LOGIN_RATE_LIMIT=10`,
`LOGIN_RATE_WINDOW_SECONDS=60`, `REGISTRATION_RATE_LIMIT=5`,
`REGISTRATION_RATE_WINDOW_SECONDS=3600`, `RATE_LIMIT_MAX_CLIENTS=10000`,
`AUTH_MAX_BODY_BYTES=16384`. `APP_NAME` defaults to `SalonPulse API`.

The launch preflight checks the role's actual privileges/table ownership and exact
migration head read-only. It fails closed for missing proxy configuration,
incorrect endpoints, a pooled endpoint, owner/admin credentials or unexpected
runtime grants. It never prints URLs/passwords or changes schema at startup.

### Required Render proxy verification before traffic

Render terminates TLS before the HTTP application. Obtain confirmation of the
actual transport peer addresses/ranges and header sanitation from Render for your
service. Configure only those ranges and ensure the first trusted edge overwrites
client-supplied forwarding headers. Do not guess private ranges, use Render egress
IP lists as ingress trust, trust `0.0.0.0/0`, set `FORWARDED_ALLOW_IPS=*`, or disable
HTTPS enforcement. If a trustworthy boundary cannot be confirmed, deployment is
blocked until a reviewed ingress topology is available. Nonempty CIDRs alone do
not prove a secure network boundary.

The secure launcher disables Uvicorn proxy rewriting/access logs. The application
alone validates forwarded scheme/client IP from verified peers. Verify real TLS,
host validation, allowed/disallowed CORS, spoofed-forwarding rejection and rate
limiting on the deployed service before launch. No credentials or request bodies
should enter independent Render/proxy/monitoring logs.

The Blueprint intentionally omits `healthCheckPath`: Render defaults to a TCP
probe. TCP verifies a listening server, not application/database readiness. After
the exact HTTPS-forwarding/Host behavior of Render's probes is confirmed, enable
`/health/db` as an HTTP probe only if it passes the same security policy. Do not
add a general HTTP exemption. Use external HTTPS checks of `/health` and
`/health/db` as release gates in all cases. See [Render health checks](https://render.com/docs/health-checks).

### Pooling

This release uses the direct Neon endpoint with the existing SQLAlchemy QueuePool:
5 persistent + 5 overflow connections, pre-ping, 5-second connection/pool/statement
timeouts and 1,800-second recycling. One API process is fixed. Budget at least
10 connections per overlapping instance during deploys, plus operator/provider
connections. Measure Neon wake-up/region latency and choose capacity before launch.

Do not switch this configuration to Neon's `-pooler` endpoint: transaction pooling
does not preserve arbitrary session state, while this application sets a session
statement timeout at connect. Supporting that mode needs a separately tested
transaction-local timeout strategy. Migration/backup connections always use direct
endpoints. See [Neon pooling guidance](https://neon.com/docs/connect/connection-pooling).

## 4. Vercel frontend

1. Import the same GitHub repo; set **Root Directory `frontend`**, Framework Vite,
   Node **24.x**, install `npm ci`, output `dist`. The checked-in `vercel.json`
   supplies the build command: `node scripts/check-deployment.mjs && npm run build`.
2. Set production `VITE_API_BASE_URL` to the real Render/custom HTTPS API origin.
   Set it separately for any staging environment. No backend/database/JWT secret
   belongs in Vercel build variables or `VITE_*`.
3. Replace only `https://api.salon.example` in `vercel.json`'s CSP `connect-src`
   with that same exact API origin and commit that public hostname change. The
   deployment validator rejects mismatches and insecure script/frame policies.
4. Add/verify the frontend custom domain and HTTPS certificate. Set that exact
   origin in backend CORS; API hosts go in backend TRUSTED_HOSTS, not CORS.
5. Deploy the production build, then verify browser login and a normal workflow.
   Vercel project Root Directory is a dashboard setting, not a vercel.json field;
   see [Vercel monorepos](https://vercel.com/docs/monorepos) and
   [configuration](https://vercel.com/docs/project-configuration/vercel-json).

Headers enforce nosniff, frame denial, no-referrer, restricted device permissions,
HSTS and CSP with only the selected API allowed for cross-origin connections.
HTML revalidates; hashed assets are immutable. The app uses hash navigation, so
no blanket SPA rewrite hides missing assets. CSP has no unsafe-inline/unsafe-eval.
Test charts/forms under the actual headers; do not broaden CSP to bypass errors.
Keep platform toolbar/script injection disabled for production if it conflicts.

Untrusted PR previews must never receive production secrets/API access. Use a
separate staging Neon branch/database, backend and exact preview origin for
approved integration previews; do not wildcard all `*.vercel.app` in CORS/CSP.
Deploying a frontend preview alone does not isolate its backend data.

## 5. Release checks and recovery

Before promoting: verify migration result, runtime preflight, actual HTTPS health
responses, frontend security/cache headers, CORS/hosts, authentication, one-owner/
staff permissions and tenant isolation in an isolated staging environment. Never
seed production just to run the local destructive disposable-schema harness.
The local DB tests deliberately refuse hosted database targets.

```powershell
Set-Location 'D:\PROJECTS\Portfolio Projects\salonpulse\backend'
$env:DEBUG = 'false'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:SALONPULSE_RUN_DB_TESTS = '1'
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -v
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe -B -m alembic check
Set-Location '..\frontend'
npm.cmd test
$env:VITE_API_BASE_URL = 'https://api.salon.example' # use the matching real origin for deployment
node scripts/check-deployment.mjs
npm.cmd run build
```

These are local tests; use private hosted configuration only for the guarded
release commands above. After hosting setup, public-only probes can use:

```powershell
Invoke-WebRequest 'https://api.salon.example/health'
Invoke-WebRequest 'https://api.salon.example/health/db'
Invoke-WebRequest 'https://salon.example/'
```

For an application regression, roll back frontend/API artifacts only when they
are compatible with the already-applied schema. Fix migrations forward; do not
automatically downgrade financial/audit data. Establish backup restoration drills,
restricted monitoring access, alerting, a shared edge rate limiter and Argon2-aware
resource budgets before commercial traffic. Per-process rate limits reset on
restart and do not protect multiple replicas; free-tier resource caps and sleeping
services are not a production SLA. Local validation cannot certify managed TLS,
provider IAM, actual proxy trust, real CA paths, backups or deployed browser behavior.

Account access/user input still needed: provider projects/plans/region, real
domains and DNS, verified Render ingress trust, independently generated secrets,
Neon admin bootstrap/password setup, backup policy and protected migration runner.

## Local verification for this change

- 247 backend tests and 105 frontend tests passed, including deployment target,
  role-policy, revision, redaction, secret-separation and CSP regression tests.
- TypeScript, guarded production build and deployment configuration checks passed
  with the public HTTPS example origin. No new package was installed.
- An additional 64 live HTTP payment checks passed using disposable local schemas.
- `pip check` and Alembic comparison passed; local revision remains
  `795150f8a1a2`. Both local health endpoints returned HTTP 200.
- All nine local application tables remain empty and no disposable schemas remain.
- Source/build review found no new secrets; private `.env` is ignored/untracked.

New hosted role policies and the migration operator were tested with mocks/guards;
the SQL role scripts were reviewed but not applied to local or hosted databases.
Actual Render/Vercel/Neon deployment validation and hosted browser checks require
the account/domain/secret/proxy setup above. The Blueprint has not been submitted
to a hosting account, and this report does not claim a live production deployment.
