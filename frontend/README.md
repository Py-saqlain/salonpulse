# SalonPulse frontend

A responsive salon-owner workspace with a desktop sidebar and mobile drawer.
All data is fictional. Bookings persist in this browser's localStorage under
`salonpulse.appointments.v1`; there are no API calls or backend persistence.
The dashboard uses the current date and time in Lahore (PKT, UTC+05:00).
On first use, five sample appointments are created for the current Lahore date.

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
- `src/data.ts`: typed demo directories, booking validation, Lahore time handling,
  localStorage loading, and PKR formatting.
- `src/AppointmentForm.tsx`: accessible native dialog with customer, service,
  staff, date, and time inputs, plus duration and price details.
- `src/styles.css`: Tailwind import, design tokens, component and responsive styles.
- `index.html`: title, viewport, theme colour, and page description.

Dashboard, Appointments, Customers, Staff, Services, and Analytics are reachable
through navigation. New appointment opens a form. All fields are required;
past bookings and staff overlaps are rejected, including overlaps across midnight.
Back-to-back bookings are allowed. Successful saves update the appointment list
and dashboard counts. Revenue sums completed appointments only. The dashboard
shows today's appointments; the Appointments page shows all dates.

If browser storage is blocked or full, the form reports the error and does not
claim the appointment was saved. Clearing browser site data removes bookings.
No backend setup is required for this preview.

## Appointment management

The Appointments page searches customer names (case-insensitive) and combines
date and status filters. Clear filters restores the complete local history.
Confirmed and in-progress appointments can be edited, cancelled after a browser
confirmation, or marked completed. Editing uses the creation form and validation,
excluding the edited booking from overlap checks. Past start times remain invalid.

Cancelled bookings stay in history and do not reserve staff availability.
Completed bookings stay in history and retain their original details. Both final
statuses are read-only. Today's appointment KPI excludes cancellations; upcoming
counts exclude both final statuses, and revenue sums completed bookings only.
All changes use the same localStorage save path; failed writes leave state intact.

Scheduled bookings and walk-ins share the same form, validation, and storage.
Walk-in mode prefills the next clock minute in Lahore, with an adjustable start
time for customers who need to wait. It still requires a customer from the demo
directory, a service and a staff member, and never bypasses overlap checks.
Existing saved bookings without a booking type display as Scheduled. Customer
search covers scheduled, walk-in, completed and cancelled records, preserving a
single customer appointment history. No records are deleted by status changes.
