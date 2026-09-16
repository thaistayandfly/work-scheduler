# ShiftBoard

Client-only shift board: pick "Event" or "Warehouse" for each day and save them to a Google Calendar of your choice; after the shifts, add the real times and extras, see your pay, and at month end email the month's report to the company.

## Setup (10 min)

1. **Google Cloud Console** (same project as your login button):
   - APIs & Services → Library → confirm **Google Calendar API**, **Google Sheets API**, **Google Drive API** and **Gmail API** are enabled (Sheets and Drive for the Pay tab's sheet, Gmail for sending the monthly report).
   - APIs & Services → Credentials → **Create Credentials → OAuth client ID → Web application**.
     - Under **Authorized JavaScript origins**, add your GitHub Pages URL, e.g. `https://yourname.github.io`.
     - No redirect URI needed.
   - Copy the generated **Client ID**.

2. **OAuth consent screen** → Data access (Scopes) → add `.../auth/calendar` (full access — needed to create calendars, not just events), `.../auth/drive.file` (only files ShiftBoard creates) and `.../auth/gmail.send` (sends the monthly report; asked for only at someone's first Send). Keep the app in **Testing** mode and add your Google account(s) under **Test users** (up to 100).

3. **Edit `config.js`** in this folder and paste your Client ID:
   ```js
   const GOOGLE_CLIENT_ID = "xxxxxxxx.apps.googleusercontent.com";
   ```

4. **Deploy to GitHub Pages**:
   - Push this folder to a GitHub repo.
   - Repo Settings → Pages → deploy from the branch/folder containing these files.
   - Visit the published URL — it must exactly match the origin you added in step 1.

## How it works

- Sign-in uses Google Identity Services in the browser — no server. The access token (good for about an hour) is kept in `localStorage`, so reloading the page keeps you signed in. When it expires, one click on **Sign in with Google** gets a new one without the consent screen, and unsaved toggles are kept.
- Pick or create a calendar from the dropdown. Only calendars you can edit are listed; it defaults to your main calendar.
- The board shows this week and the next three; **Show 4 more weeks** and **Show the week before** add more. Tap **Event** / **Warehouse** on any day (both can be on at once) and tap again to remove it.
- A day shows **Event** / **Warehouse** as selected when the calendar has an event with that title on it (`Event`, `Warehouse`, `Work: Event` or `Work: Warehouse`, any case) — including events from the first version of the app or added by hand. Other events are ignored.
- **Save to Calendar** saves every week at once. It compares your selection with what the calendar had: newly selected types become all-day events titled `Event` or `Warehouse`, and types you turned off have that day's matching events deleted (duplicates included). Anything that fails stays marked so you can save again.
- **Tap a date** to enter a shift's real start and end (it can run past midnight), mark a night slept at work (Event), add expenses, or add an **Other** job (times and amount required, description optional). An Other job never needs an Event or Warehouse that day: **+ Other job** in each week's header opens one directly, and tapping an empty day opens its form straight away. Entering times turns the calendar event from all-day into a timed one. A red banner lists past shifts from this month and last that still need their times.
- **Pay** tab: connect Google Drive once and ShiftBoard creates a "ShiftBoard pay" sheet in your own Drive (it can only open files it creates). Enter your full name (in the report's language: Hebrew letters for a Hebrew report, English letters for an English one), the company email, the report language and your four rates; they're saved in the sheet's Settings tab. Each month shows every shift's pay, the total to pay (gross salary) and, kept apart from it, the expenses reimbursement (expenses are already taxed; the salary isn't). **Update my sheet** writes the month into its own tab (e.g. `2026-09`): name, month and year, the two totals, a small hours summary, then every shift. It never shows your rates. It asks first if that tab was changed by hand.
- **Send the month:** once every shift in a month has its times, **Review and send** shows who it goes to, the name on the report, the totals, and the month's PDF to check (A4 landscape, in the same layout as the sheet). The first time, you confirm your name and the company email, and Google asks once to let ShiftBoard send email from your Gmail. **Send** emails the PDF from your own Gmail to the company email, in the report language, saves a copy in a "ShiftBoard" folder in your Drive and marks the month sent. A sent month keeps the rates it was sent with and says so if your calendar changes afterwards; **Reopen to correct** lets you fix it and send it again, marked "Corrected". A banner on the board reminds you when last month hasn't been sent.
- **Language:** the button at the top switches the app between English and Hebrew (right to left). It starts in the phone's language and each device remembers the choice. The report language is a separate choice in **Your details and rates**: Hebrew by default, or English. A report is always entirely one language. Calendar events stay titled `Event` / `Warehouse` either way. In Hebrew the week starts on Sunday.
- **Sign out** forgets this browser's session so a coworker can sign in with their own Google account. Each coworker has to be added under **Test users** first (step 2).

## Checks

```bash
node tests/run.js      # or: npm test
```

About 180 checks run against the real `app.js`, `i18n.js` and `index.html` in a minute — the pay rules, the
report in both languages, the email, the PDF, and the app itself driven in headless Chrome on an emulated
phone, with Google faked. [tests/README.md](tests/README.md) says what each one covers; GitHub Actions runs
the same command on every push.

## Known limits

- Testing-mode OAuth caps at 100 approved test users.
- No offline/local storage of schedule data — Calendar is the source of truth.
- If two ShiftBoard sessions edit the same week at once, last save wins.
- Staying signed in longer than an hour would need a backend — a browser-only app can't safely hold a refresh token.
- The PDF is drawn by the app, one image per page, so its text can't be selected or searched; the email itself gives both totals as text. (Google only exports a single tab to apps allowed to read your whole Drive, which ShiftBoard doesn't ask for.)
