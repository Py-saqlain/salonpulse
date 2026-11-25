# SalonPulse frontend

React + TypeScript + Vite with Tailwind. Authentication uses the FastAPI backend;
the existing Dashboard, Appointments, Customers, Staff and Services UI remains a
**session-only demo**, with no business-resource API calls yet.

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
  `email`, `password` (12?128 characters). Role and business identity are assigned
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

## Demo isolation and retained UI

Every login mounts a new empty workspace. No legacy `salonpulse.demo.*` data is
read, migrated or copied into authenticated accounts. Old browser data remains
untouched but inaccessible through this UI. Demo edits live only in React state
and clear on logout or refresh, including when logging back into the same account.
Account/business labels come from the backend, and all temporary resource data
is clearly labeled. Add demo customers, staff and services to exercise the existing
booking/history workflow. No seeded people or business records are shown as real.

Existing resource editors, stable IDs, validation, staff hours, service snapshots,
appointment conflicts, customer history, filters and responsive navigation remain.
These demo controls do not grant backend permissions or persist salon records;
real resource CRUD integration and role-aware resource controls are future tasks.
The demo scheduling UI still uses Lahore time; other timezones require later mapping.
Legacy storage/migration helpers remain in `data.ts` for existing tests, but the
application no longer calls them. Staff is separate from an authenticated user.

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
