# SalonPulse frontend

A responsive salon-owner workspace with a desktop sidebar and mobile drawer.
All data is fictional and browser-local. There are no API calls or persistence.
The displayed date is part of the fixed demo dataset, not the current date.

## Run in Windows PowerShell

```powershell
Set-Location 'D:\PROJECTS\Portfolio Projects\salonpulse\frontend'
npm.cmd install
npm.cmd run dev
```

Open http://localhost:5173. Stop with Ctrl+C.

```powershell
npm.cmd run build
```

The build runs TypeScript checking before Vite. If dependency installation has
not completed, the build cannot run; finish `npm.cmd install` first.

## Source

- `src/main.tsx`: application shell, hash navigation, reusable KPI and appointment
  components, dashboard, schedule preview, and placeholders. Browser Back works.
- `src/data.ts`: typed mock appointments and PKR formatting.
- `src/styles.css`: Tailwind import, design tokens, component and responsive styles.
- `index.html`: title, viewport, theme colour, and page description.

Dashboard, Appointments, Customers, Staff, Services, and Analytics are reachable
through navigation. The new appointment button displays an explanatory notice;
creation is not implemented. No backend setup is required for this preview.
