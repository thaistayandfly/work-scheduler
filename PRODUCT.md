# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who work two kinds of shifts: event crew ("Event") and warehouse ("Warehouse"), plus the occasional one-off paid job ("Other"). The owner and a few coworkers each sign in with their own Google account and manage only their own shifts and pay, mostly on their phones. Some are more comfortable in Hebrew, others in English.

## Product Purpose

**Part 1 (built):** ShiftBoard turns "which days am I working, and where" into Google Calendar events. Users mark every work day they already know, often one or more weeks at a time, and save once.

**Part 2 (in progress; phases 1 and 2 of 3 built):** after the shifts happen, users record the real start and end times, nights slept at work, expenses and "Other" jobs. ShiftBoard works out the pay from each person's own rates, fills a monthly table in their own Google Sheet, and at month end, after the user has reviewed it, emails a PDF of the month to the company.

Success means the calendar, the sheet and the PDF always agree: no duplicates, no lost shifts, no wrong pay.

## Positioning

A two-tap shift board that writes straight into each person's own Google Calendar and Sheets: no backend, no extra account, no shared spreadsheet.

## Operating Context

- Opened on a phone, sometimes in the evening at home and sometimes during the day at work, so the interface follows the phone's light/dark setting.
- Typical planning session: add the known shifts for the coming week or weeks, save, close.
- After shifts: enter the real times and extras for the shifts that happened.
- Month end: review the month and send it. Nothing is ever sent automatically.
- The company receives one PDF per person per month at one shared company email address. It is usually in Hebrew; each person can choose English instead.
- Google Calendar is the source of truth for shifts. A day counts as Event or Warehouse when the chosen calendar has an event with that title on it.

## Capabilities and Constraints

- Static site on GitHub Pages. Google Identity Services token flow; Google APIs called directly from the browser.
- A sign-in lasts about an hour (one Google access token); longer sessions would need a backend.
- The Google OAuth app is in Testing mode: at most 100 approved test users, and each coworker must be added as one. Users see an "unverified app" warning once when approving.
- Works with any calendar the user can edit. Saves all-day events titled "Event" or "Warehouse" (plus a hidden tag) and also recognises "Work: Event" / "Work: Warehouse" from earlier versions.

### Part 2 rules (confirmed; everything except the PDF and sending is built)

- **Work types:** Event and Warehouse are the main ones. "Other" is rare and stays visually minor: it needs start and end times and an amount; the description is optional. It never depends on an Event or Warehouse that day: "+ Other job" in each week's header, or tapping an empty day, opens its form directly.
- **Times:** every shift needs a real start and end before its month can be sent. A shift can cross midnight and has no length limit. An all-day calendar event means "times not entered yet"; entering times turns it into a timed event.
- **Pay** (each person has their own rates):
  - Warehouse: exact hours × the Warehouse hourly rate.
  - Event: a fixed amount per event day covers up to 12 hours; from the 13th hour on, the Event extra-hours rate per hour. Each day of a multi-day event (e.g. build day and event day) is its own Event.
  - Slept at work: a fixed night rate, switched on per shift by the user (Event only). For a multi-day event that is every day except the last.
  - Other: the amount entered for that job.
  - Expenses: amount + type (travel, food, hotel, other), several per shift, paid back at cost.
  - No break deductions, minutes count exactly, and a shift is paid in the month it starts.
- **Salary and expenses stay apart:** the total to pay is the gross salary (shift pay, extra hours, nights and Other jobs). Expenses are reimbursed separately and never added to it: they were already paid with taxed money, while the salary is taxed when paid.
- **Rates:** a change applies to every month not yet sent, for the whole month (a mid-month raise covers that month). Sent months never change.
- **The monthly report:** the summary first (name, month, year, total to pay (gross salary), expenses reimbursement), then a small hours summary for anyone who wants it, then one row per shift with a totals row. Rates never appear on it.
- **Languages:** each person picks the app's language (English or Hebrew, right to left in Hebrew) on their device, and separately the report language (Hebrew by default, or English). A report and the sheet's tabs are always entirely one language, never mixed.
- **Currency:** Israeli shekel (₪).
- **Sending:** a review screen shows every shift, the pay and the totals; Send stays locked until every shift has times. Send emails the month's PDF from the user's Gmail to the company address, keeps a copy in the user's Drive and marks the month sent. A sent month can be reopened, fixed and resent marked "Corrected".
- **Identity on the PDF:** the user's full name, which the user must confirm or correct before the first send (Google account names can be nicknames).
- **Sheet:** the app creates its own spreadsheet in each person's Drive, in the same layout for everyone. The calendar stays the source of truth: the app rebuilds its table from it, warns before replacing hand edits, and never fails on them.
- **Old setup:** the owner's existing spreadsheet and Apps Script stay untouched. The app's sheet starts from the month the user switches; past months are not imported.
- **Permissions:** Google Calendar, Google Drive (only files the app creates) and Gmail send.
- **Privacy:** the company email, rates and pay data live only in each user's own Google account, never in this public repository.

## Brand Commitments

- Name: ShiftBoard.
- Blue means Event, orange means Warehouse, in either language. Calendar events keep the titles "Event" and "Warehouse" whatever the app's language.
- Tap a type to select it and tap again to remove it; shifts loaded from the calendar look exactly like freshly selected ones.

## Evidence on Hand

- The app itself.
- The owner's current spreadsheet (a monthly table template and a pay rate sheet) and the Apps Script that calculates hours and pay exist, but have not been shared yet. The monthly table and PDF layout should follow that template once it is seen.
- There are no testimonials, user counts, or other claims; do not invent any.

## Product Principles

1. The calendar is the truth: never show a shift the calendar doesn't have, and never drop one the user marked.
2. A tap per shift and one save for everything.
3. Quiet until it matters: speak up for unsaved changes, missing times, failures, and an expired sign-in, nothing else.
4. Each person touches only their own calendar, sheet and pay.
5. Nothing goes to the company until the user has reviewed it.
