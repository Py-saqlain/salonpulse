# SalonPulse frontend

A responsive salon-owner workspace with a desktop sidebar and mobile drawer.
All data is fictional. Bookings persist in this browser's localStorage under
`salonpulse.demo.v3`; there are no API calls or backend persistence.
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

## Staff management

Staff has a shared directory with stable employee IDs, name, optional Pakistani
mobile, optional specialty, active status, and weekly working hours. Phone
normalization matches Customers, with duplicates checked within the staff
directory. Today's counts come from assigned appointments and exclude cancelled
bookings. Search covers names, phone numbers and specialties; filter by active
or inactive status. There is no deletion.

Working hours use Lahore time (Asia/Karachi, UTC+05:00), with one same-day shift
per working day. End must be after start. Days not selected are days off. New
employees default to hours not configured, which explicitly blocks new bookings.
The seeded demo team has clearly labeled sample hours of 09:00-20:00 daily.
Overnight shifts, breaks, holidays, and time off are not implemented yet.

New and edited appointments require an active employee with configured hours;
the entire service must fit that day's shift. Overlaps use staff IDs and exclude
cancelled bookings and the booking being edited. Existing bookings assigned to
an inactive employee remain visible; editing requires choosing an active employee.
Completed and cancelled history remains read-only, as before.

Deactivation with unfinished future or ongoing appointments requires explicit
browser confirmation. It never cancels or reassigns them. Changes to hours also
leave existing appointments intact; review those bookings manually. No automatic
rescheduling is performed.

`staff.ts` owns employee types, validation, availability and pending-booking
queries. `StaffPage.tsx` and `staff.css` provide the responsive directory/editor.
Appointments use `staffId` and retain a name snapshot. Renaming staff keeps all
bookings linked. Current names display from the shared directory.

The store now uses `salonpulse.demo.v3`. Existing v2 customer data and v1
appointment data migrate automatically while retaining their original keys.
Known employee names map to seed IDs; unknown legacy names are retained as
inactive employees with unconfigured hours. Migration does not reject existing
bookings for hours or activity conflicts. A failed migration write preserves
loaded bookings in memory and displays a warning.

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

## Customer management

Customers is a searchable directory with add/edit forms, optional Pakistani
mobile numbers and notes. Accepted mobile formats include `03xx xxxxxxx`,
`+92 3xx xxxxxxx`, `923xxxxxxxxx` and `00923xxxxxxxxx`. Numbers are stored as
`+923xxxxxxxxx`; duplicate non-empty numbers are rejected within this demo business.
Duplicate names and customers without phone numbers are allowed.

Customer IDs link every booking to its owner. Name edits update the display
without changing appointment history. Completed visit counts and the last
completed date are derived from appointments. History includes all statuses.
Customers cannot be deleted or deactivated in this version.

New appointment includes Add customer, using the same form and store. Saving a
new customer selects them automatically and preserves the rest of the booking.
Cancelling the booking does not remove an already saved customer.

Customers, staff and bookings are written together to `salonpulse.demo.v3`. Existing
Day 2 `salonpulse.appointments.v1` bookings migrate to customer IDs on load; the
old key is retained. Failed migration or storage writes show a warning. Data
remains browser-local and is removed by clearing site storage.

`customers.ts` owns customer types, validation, normalization and history queries;
`CustomerEditor.tsx` is reused by Customers and booking. `CustomersPage.tsx` owns
directory and history presentation. `data.ts` owns versioned store loading and
booking validation. React holds the shared store in `main.tsx`.

Run the focused domain regression tests with Node.js 24:

```powershell
npm.cmd test
npm.cmd run build
```
