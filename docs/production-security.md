# Production security and deployment contract

The application validates `APP_ENV=production` and `staging` with the same policy.
This is application hardening, not verification of a deployed TLS/proxy/network
environment. No production deployment or real production credentials were used
in local verification.

## Configuration

Use [the public deployment template](../backend/.env.production.example) as a
reference. Configure secrets in a deployment secret manager or an ignored private
environment file; never copy credentials into source, frontend variables, command
arguments, chat or logs. Keep the local development `.env` unchanged.

Production/staging startup rejects:

- Debug mode or disabled HTTPS enforcement.
- Empty CORS origins, non-HTTPS/local frontend origins, wildcard origins, or origins
  with credentials, paths, queries, fragments or control characters.
- Empty, wildcard or local/test trusted hosts. Hosts are exact lowercase names,
  without schemes/paths/ports. Configure actual API hosts, not frontend hosts.
- Missing issuer/audience or signing key, obvious weak/placeholder/repeated keys,
  and access-token lifetimes over 60 minutes. Generate at least 32 random bytes
  with a cryptographic generator; diversity checks cannot prove real entropy.
- Missing/invalid PostgreSQL connection settings, administrative `postgres`/`root`
  logins, weak/placeholder/shared passwords, or TLS modes other than `verify-full`.
  Provision a valid CA and certificate hostname through the PostgreSQL deployment.
- Zero/invalid rate limits and invalid or universally trusted proxy CIDRs.

`JWT_ISSUER` and `JWT_AUDIENCE` are checked on production tokens, with a fixed
HS256 algorithm, signature, integer issued-at/expiry claims, bounded lifetime and
canonical UUID subject. Changing signing key/issuer/audience invalidates existing
sessions; no refresh-token, automatic key rotation or token-revocation service is
implemented. Live active-user lookup and database-derived role/business context
remain authoritative. Passwords use pwdlib's recommended Argon2id parameters;
absent identities still perform a dummy verification, and login errors are generic.
Registration's existing 409 duplicate-email behavior is retained.

The existing `backend/scripts/configure_jwt.py` generates and writes a missing key
privately to an existing ignored `.env` without displaying it. It never replaces
an existing key. For hosted deployments, prefer the platform's secret manager.

## Required server/proxy boundary

Start the backend from its directory using the secure launcher:

```powershell
Set-Location 'D:\PROJECTS\Portfolio Projects\salonpulse\backend'
.\.venv\Scripts\python.exe -m app.serve --host 127.0.0.1 --port 8000
```

The launcher fixes one worker, disables Uvicorn proxy-header rewriting, disables
request access logs (including potentially sensitive URL queries), and removes
the Uvicorn Server header. Invalid startup configuration exits with a generic
message rather than dumping values. It does not terminate TLS itself.

If using another server entry point, it MUST disable server-level proxy rewriting
and request/access/header/body logging. For direct Uvicorn, the required flags are
`--no-proxy-headers --no-access-log --no-server-header`. The application cannot
recover the original transport peer after an outer server has rewritten it.
Do not set `FORWARDED_ALLOW_IPS=*` or allow untrusted outer middleware to interpret
forwarded headers first. Uvicorn's default proxy handling is not this deployment
contract: [official server settings](https://uvicorn.dev/settings/).

Terminate TLS at a maintained ingress/reverse proxy. Expose only HTTPS publicly,
keep the backend port on a private interface/firewall, restrict upstream peers,
and set `TRUSTED_PROXIES` to only those actual transport IPs or narrow CIDRs.
Preserve the canonical Host header; `X-Forwarded-Host` is never trusted. The app
ignores Forwarded/X-Real-IP and all forwarded headers from untrusted peers.
For trusted peers, it validates one X-Forwarded-For chain and one
X-Forwarded-Proto value, walking the IP chain right-to-left to the first untrusted
address. Duplicate/malformed trusted proxy headers return 400. Mapped IPv4 is
canonicalized; scoped addresses and unlimited chains are rejected.

An example for a single local Nginx proxy (adapt real domains, TLS and network
settings; it is not an installed deployment configuration):

```nginx
# In the API HTTPS server's location /:
proxy_pass http://127.0.0.1:8000;
proxy_set_header Host api.salon.example;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Forwarded "";
proxy_set_header X-Real-IP "";
proxy_set_header X-Forwarded-Host "";
proxy_hide_header Server;
access_log off;
```

For that topology only, `TRUSTED_PROXIES=["127.0.0.1/32"]`. Overwrite client-sent
forwarding headers at the first trusted edge; only verified intermediate proxies
may append their peer. Never trust ranges also occupied by untrusted clients or
containers. Proxy trust is a network boundary, not cryptographic authentication.
Production health probes are not exempt: use the canonical API Host over HTTPS
(or correctly forwarded HTTPS from the trusted ingress). Never disable host or
HTTPS validation merely for probes.

An internet-reachable ingress must additionally enforce host/SNI validation,
request/header/body size limits, read timeouts, connection limits and abuse controls.

## Authentication rate limits

Every POST attempt (including malformed input and trailing-slash routes) to
`/api/auth/login` or `/api/auth/register` consumes a per-client, per-action fixed
window before body parsing, database lookup or password work. Production defaults
are 10 logins/60 seconds and 5 registrations/3600 seconds. Development defaults
are 120/60 seconds and 60/3600 seconds. OPTIONS and unrelated business operations
do not consume these authentication buckets. HTTP 429 has a generic message and
integer `Retry-After` seconds, exposed to allowed CORS origins; responses are not
cached. Authentication bodies above 16 KiB return 413, including chunked bodies.

The limiter is thread-safe, bounded to 10,000 live client/action buckets by default,
and refuses new buckets with 429 when capacity is full instead of evicting active
limits. Expired buckets are removed using monotonic time. It stores no email,
password or token and is NOT persistent or shared: restart clears limits, multiple
workers/replicas multiply budgets, and fixed-window boundaries can permit bursts.
Use a shared ingress/WAF/distributed limiter before adding replicas or multiple
workers, plus bot/credential-stuffing controls and monitoring. IP rotation and
distributed attackers are not stopped by a per-IP limiter; shared NATs may affect
legitimate users. Bound concurrent password work at the hosting edge according to
Argon2 memory use. This local limiter is defense in depth, not distributed DDoS
protection or an account/email lockout service.

## Browser transport, CORS and headers

Backend hosts are validated without www redirects. Plain HTTP is rejected with
400 in production/staging, including authentication requests; redirect public
HTTP to HTTPS at the ingress before clients send credentials. HSTS
`max-age=31536000` is sent only on verified HTTPS production responses. API
responses include no-store/no-cache, nosniff, DENY framing, no-referrer,
restricted device permissions and a restrictive CSP for JSON. Allowed-origin CORS
headers also accompany errors and 429 responses. No wildcard or credentialed CORS
is used. Swagger/ReDoc/OpenAPI are disabled by default in production; an explicit
`DOCS_ENABLED=true` exposes their public schema intentionally, with a separate CSP
that allows the development documentation page to function.

Build the frontend with its actual public HTTPS API hostname:

```powershell
Set-Location 'D:\PROJECTS\Portfolio Projects\salonpulse\frontend'
$env:VITE_API_BASE_URL = 'https://api.salon.example'
npm.cmd run build
```

Replace the example domain for deployment. Production, staging and other custom
build modes reject missing, HTTP, local/IP-literal or credential-bearing API URLs.
`VITE_*` values are public bundle contents and MUST NOT contain secrets. For local
HTTP preview only, `npm.cmd run build -- --mode development` deliberately retains
development behavior; do not deploy that bundle as production. `npm.cmd run dev`
continues to work with the local default API URL.

API headers cannot protect the separately hosted static frontend. At the static
HTTPS host, configure nosniff, no-referrer, frame denial, Permissions-Policy and
HSTS after verifying certificates. A starting production CSP for the current
bundle is:

```text
default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self' https://api.salon.example; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'
```

Adapt only the API origin and verify real browser behavior at deployment; Vite's
development server/preview is not a production TLS/security-header host. Avoid
caching index.html across deployments; immutable hashed assets may be cached.

## Error/log policy and remaining limits

Unexpected application errors return generic 500 JSON and log one fixed marker,
without exception text, stack traces, query strings, headers or request bodies.
Validation errors omit submitted inputs, and existing database errors remain safe
503 responses. Private configuration validation is not exposed through APIs.
Configure reverse proxies, managed ingress, tracing, monitoring and hosting crash
collectors to follow the same redaction policy; application code cannot control
their independent logs. Do not enable SQL echo, HTTP body capture or Authorization
logging. Restrict access to secret files and process environments.

Tenant filters, composite foreign keys and row-locking financial protections are
covered by the full database suite. Owners alone can browse receipt history,
financial analytics and audit/reconciliation. Staff can record receipts and read
necessary balances. Persistent server payment intents plus scoped browser UUID
pointers recover uncertain outcomes across sessions without storing tokens or
sensitive payment details. Immutable operator audit records commit atomically
with sensitive writes.

Email verification, password reset, MFA, token revocation, provider reconciliation,
independent penetration testing, monitoring and backup/restore drills remain
production work. Follow the [Vercel/Render/Neon deployment runbook](deployment.md)
for restricted database roles, separate migrations, TLS/proxy release gates and
hosting limitations. Local checks do not certify hosted infrastructure.



## Verification scheduling

Run database-backed backend tests and live browser/HTTP suites serially. Each
suite compares application record IDs against its starting baseline; overlapping
fixture creation/cleanup correctly trips those guards even when functional
assertions pass. Never remove those guards or delete unrelated records to make a
check pass. After each suite, confirm cleanup before starting the next one.
