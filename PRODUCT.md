# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who work two kinds of shifts: event crew ("Event") and warehouse ("Warehouse"). The owner and a few coworkers each sign in with their own Google account and plan only their own shifts, mostly on their phones.

## Product Purpose

ShiftBoard turns "which days am I working, and where" into all-day Google Calendar events. Users mark every work day they already know, often one or more weeks at a time, and save once. Success means the calendar matches the board: no duplicates, and no marked shift lost.

## Positioning

A two-tap shift board that writes straight into each person's own Google Calendar: no backend, no extra account, no shared spreadsheet.

## Operating Context

- Opened on a phone, sometimes in the evening at home and sometimes during the day at work, so the interface follows the phone's light/dark setting.
- Typical session: add the known shifts for the coming week or weeks, save, close.
- Google Calendar is the source of truth. A day counts as Event or Warehouse when the chosen calendar has an event with that title on it.

## Capabilities and Constraints

- Static site on GitHub Pages. Google Identity Services token flow and the Google Calendar API, called directly from the browser.
- A sign-in lasts about an hour (one Google access token); longer sessions would need a backend.
- The Google OAuth app is in Testing mode: at most 100 approved test users, and each coworker must be added as one.
- Works with any calendar the user can edit. Saves all-day events titled "Event" or "Warehouse" (plus a hidden tag) and also recognises "Work: Event" / "Work: Warehouse" from earlier versions.
- Exactly two work types. A day can have Event, Warehouse, both, or neither.

## Brand Commitments

- Name: ShiftBoard.
- Blue means Event, orange means Warehouse.
- Tap a type to select it and tap again to remove it; shifts loaded from the calendar look exactly like freshly selected ones.

## Evidence on Hand

Only the app itself. There are no testimonials, user counts, or other claims; do not invent any.

## Product Principles

1. The calendar is the truth: never show a shift the calendar doesn't have, and never drop one the user marked.
2. A tap per shift and one save for everything.
3. Quiet until it matters: speak up for unsaved changes, failures, and an expired sign-in, nothing else.
4. Each person touches only their own calendar.
