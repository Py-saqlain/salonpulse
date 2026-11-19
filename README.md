# SalonPulse

Mobile-first, multi-tenant SaaS for barbershops and beauty salons in Lahore,
Pakistan. This existing repository contains two independent applications.

## Files

- `frontend/`: React + TypeScript + Vite + Tailwind CSS. `src/main.tsx` contains
  a responsive placeholder, `src/styles.css` imports Tailwind, `vite.config.ts`
  configures its plugins, and `tsconfig.json` enables strict TypeScript checks.
- `backend/main.py`: FastAPI application with `GET /health` returning
  `{"status":"ok"}`. `requirements.txt` pins installed Python dependencies.
- `docs/architecture.md`: React → FastAPI → PostgreSQL and planned tenant isolation.
- `.gitignore`: excludes virtual environments, Python caches, `node_modules`,
  `.env` variants, and build outputs. Safe `.env.example` files may be tracked.

No authentication, database models, business features, or AI are implemented.

## Windows PowerShell setup

Install Node.js 24 LTS with npm and native Windows Python 3.13+ with pip.
Use two terminals, starting from the repository root. This machine has native
Python 3.13 at the path below; update that path on another machine. Avoid the
MSYS2 Python on this machine's PATH when creating the Windows environment.
`npm.cmd` and the virtual environment's Python work without changing PowerShell
execution policy or activating the environment.

Frontend terminal:

```powershell
Set-Location 'D:\PROJECTS\Portfolio Projects\salonpulse\frontend'
npm.cmd install
npm.cmd run dev
```

Open <http://localhost:5173>. Stop with Ctrl+C.

Backend terminal:

```powershell
Set-Location 'D:\PROJECTS\Portfolio Projects\salonpulse'
& "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe" -m venv .\backend\.venv
.\backend\.venv\Scripts\python.exe -m pip install -r .\backend\requirements.txt
Set-Location .\backend
.\.venv\Scripts\python.exe -m uvicorn main:app --reload --host 127.0.0.1 --port 8000
```

Open <http://127.0.0.1:8000/health> or the API docs at
<http://127.0.0.1:8000/docs>. Stop with Ctrl+C. PostgreSQL is planned and is not
required yet. The frontend currently makes no API requests.

## Checks

With the backend running, use another PowerShell terminal:

```powershell
Set-Location 'D:\PROJECTS\Portfolio Projects\salonpulse'
Push-Location .\frontend
npm.cmd run build
Pop-Location
.\backend\.venv\Scripts\python.exe -m pip check
$response = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/health' -UseBasicParsing
if ($response.StatusCode -ne 200 -or $response.Content -cne '{"status":"ok"}') {
    throw 'Health endpoint check failed'
}
$response.Content
```

The build checks TypeScript and generates `frontend/dist/`. Python dependencies
are pinned in `requirements.txt`. The local `backend/.venv/` is ignored by Git.

Installation is currently incomplete because registry downloads stalled and
connections were reset. React is installed, but frontend development tools and
backend packages still need installation using the commands above. Development
tools marked `latest` resolve the registry's stable default release. After a
successful install, pin the resolved versions and use `npm.cmd ci` with the
completed lockfile. The current lockfile contains only the React installation.
