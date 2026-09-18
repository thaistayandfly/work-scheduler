# Checks

Everything here runs against the real `app.js`, `i18n.js` and `index.html` — nothing is mocked except Google.

```bash
node tests/run.js      # or: npm test
```

About 200 checks run in a minute and the command fails if any of them does.
[GitHub Actions](../.github/workflows/tests.yml) runs the same command on every push to `main`.
Chrome is found automatically; set `CHROME=/path/to/chrome` if yours lives somewhere unusual.

## What runs

**On their own** (`tests/checks/`, Node with a small fake browser around the real app):

| File | Covers |
| --- | --- |
| `pay.js` | Pay rules per shift and per month, both report languages, the email as Gmail receives it, the PDF file itself, the name-language rule |
| `flow.js` | Signing in and out, the board across weeks, saving and deleting, duplicates, switching calendars, switching language |
| `dates.js` | Every day card maps to its own calendar date, including the weeks the clocks change |
| `offline.js` | The manifest, the icons it names (and their real sizes), and the files the service worker keeps |

**In real Chrome** (`tests/pages/`, run inside a preview page on an emulated phone):

| File | Covers |
| --- | --- |
| `phase1.js` | A day's panel: times past midnight, nights, expenses, Other jobs, the missing-times list |
| `pay.js` | The Pay tab: totals, each shift's line, rates, settings |
| `sheet.js` | Writing a month into the pay sheet, in both report languages, and hand-edit protection |
| `send.js` | The whole send: review, PDF, Gmail, the Drive copy, frozen rates, reopening, a correction |
| `reminder.js` | The nudge when last month hasn't been sent |
| `connect.js` | The Pay tab before Google Drive is connected |
| `hebrew-board.js`, `hebrew-pay.js` | The app in Hebrew, right to left, with no English left over |

`review.js`, `pdf-pages.js` and `wait.js` aren't checks: the tools below drive them to produce screenshots.

**With the network cut** (in `run.js` itself): a browser only allows a service worker on a page it trusts, and
`file://` isn't one, so this last check serves the real site over localhost, waits for the service worker to
take charge, switches the network off in the browser, and asks the page for its own files. It also asks for a
Google URL and expects that to fail — shifts must never come from a cache.

## How the preview pages work

`tests/lib/preview.js` takes the real `index.html` and swaps Google's sign-in script for a fake: a fake
Calendar, Drive, Sheets, Gmail and PDF export that keep everything in memory and record every write in
`window.__requests`, `window.__mail` and `window.__uploads`. It also fixes the clock to 16 September 2026, so a
check that expects "August 2026" keeps passing next year. Each scenario (`loaded`, `pay`, `panel-filled`,
`reminder`, …) taps its own way into the state being checked. Pages land in `tests/.out/`, which is ignored by git.

## Tools (not part of the checks)

```bash
node tests/tools/screenshots.js [board|phase1|pay|hebrew]   # the app's states as PNGs
node tests/tools/sheet-preview.js                           # the month tab as Sheets would draw it, with a fit check
node tests/tools/report-pages.js [he|en]                    # the PDF's pages as PNGs
```

Everything they produce also lands in `tests/.out/`.
