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
rolls back any uncommitted transaction. Future writes must explicitly commit;
this task adds no writes, models, schemas, migrations or tables. Application
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
