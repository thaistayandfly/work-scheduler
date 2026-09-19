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
- **One job per screen.** The board is for taping days and saving them; the Pay tab is for checking a month and sending it; the gear in the top bar opens **Your details and rates**, which is where you set yourself up once. Each screen has a single main button.
- Pick or create a calendar under the gear. Only calendars you can edit are listed; it defaults to your main calendar. The board just says which one it's writing to — tap that line to change it.
- The board shows this week and the next three; **Show 4 more weeks** and **Show the week before** add more. Tap **Event** / **Warehouse** on any day (both can be on at once) and tap again to remove it.
- A day shows **Event** / **Warehouse** as selected when the calendar has an event with that title on it (`Event`, `Warehouse`, `Work: Event` or `Work: Warehouse`, any case) — including events from the first version of the app or added by hand. Other events are ignored.
- **Save to Calendar** saves every week at once. It compares your selection with what the calendar had: newly selected types become all-day events titled `Event` or `Warehouse`, and types you turned off have that day's matching events deleted (duplicates included). Anything that fails stays marked so you can save again.
- **Tap a date** to enter a shift's real start and end (it can run past midnight), mark a night slept at work (Event), add expenses (Travel, Fuel, Food, or Other — and an Other expense can carry a short description, never required), or add an **Other** job (times and amount required, description optional). An Other job never needs an Event or Warehouse that day: **+ Other job** in each week's header opens one directly, and tapping an empty day opens its form straight away. Entering times turns the calendar event from all-day into a timed one. A red banner lists shifts from this month and last that still need their times — today's included, so you can fill them in the moment you finish rather than waiting for tomorrow.
- **Dates and times** follow the app's language to start with — Hebrew shows 24-hour times and day-first dates, English shows AM/PM and month-first — and both can be changed under the gear, after which your choice stands whatever the language does afterwards. That includes the boxes in a day's panel: a browser draws a native date or time box in the phone's own language and ignores the page entirely — neither a page locale nor a `lang` attribute moves it — so those boxes are the app's own, showing and accepting your format, with the phone's real picker behind the button beside each one for anyone who'd rather tap than type. They read `1830`, `18:30` and `6.30 pm` alike, and refuse a date that doesn't exist rather than rolling it into next month. The one thing outside all this is the sheet and the PDF, which always use `dd/mm/yyyy` and 24-hour times: they're payroll records going to the company and shouldn't change shape from one coworker to the next.
- **Your details and rates** (the gear): which calendar the board writes to, how times are shown on this phone, your full name (in the report's language: Hebrew letters for a Hebrew report, English letters for an English one), the company email, an optional address to send yourself a blind copy of every report, the report language and your four rates. Everything but the calendar is saved in your pay sheet's Settings tab, so it needs Google Drive connected first. Switching the report language tells you straight away if the name no longer matches it, instead of waiting for Save to refuse. One **Save details** button, which stays out of reach until the name is there and in the right letters, and it puts you back on the screen you came from. Leaving with something typed but not saved asks first, in the app's own panel rather than a browser box; closing that panel any other way means "keep editing".
- **Pay** tab: connect Google Drive once and ShiftBoard creates a "ShiftBoard pay" sheet in your own Drive (it can only open files it creates). Each month shows every shift's pay, the total to pay (gross salary) and, kept apart from it, the expenses reimbursement (expenses are already taxed; the salary isn't). The total is the whole month, the same figure the company is sent, so part of it may be work that hasn't happened yet — a line under it says how much, and for how many of the shifts still to come, since an Event is worth its day rate the moment it's worked while a Warehouse day is worth nothing until its hours are in. That line also guesses the finished month with every Warehouse day missing hours taken as a typical day (eight hours unless you set your own under the gear). The guess is only ever said beside the total, never added to it: the total goes into your pay sheet and to the company, and stays fact. Shifts still to come read "Still to come" rather than being chased for times they can't have, and only shifts you've actually worked count towards "no times yet". The one button on it is **Review and send** — or **Reopen to correct** once the month has gone. Under **More**: **Update my sheet**, which writes the month into its own tab (e.g. `2026-09`) — name, month and year, the two totals, a small hours summary, then every shift, never your rates, and it asks first if that tab was changed by hand — along with links to the sheet and to the PDF that was sent.
- **Send the month:** once every shift in a month has its times, **Review and send** shows who it goes to, the name on the report, the totals, and the month's PDF to check (A4 landscape, in the same layout as the sheet). The first time, you confirm your name and the company email, and Google asks once to let ShiftBoard send email from your Gmail. **Send** emails the PDF from your own Gmail to the company email, in the report language, saves a copy in a "ShiftBoard" folder in your Drive and marks the month sent. A sent month keeps the rates it was sent with and says so if your calendar changes afterwards; **Reopen to correct** lets you fix it and send it again, marked "Corrected". A banner on the board reminds you when last month hasn't been sent. Only one red banner ever shows at a time, and that's the one that wins — the missing times may not even be in the month you're owed for, and the reminder takes you to the Pay tab, which says so itself.
- **Language:** the button at the top switches the app between English and Hebrew (right to left). It starts in the phone's language and each device remembers the choice. The report language is a separate choice in **Your details and rates**: Hebrew by default, or English. A report is always entirely one language. Calendar events stay titled `Event` / `Warehouse` either way. In Hebrew the week starts on Sunday.
- **Install it on a phone:** Android offers to add ShiftBoard to the home screen by itself; on an iPhone, tap Share → Add to Home Screen. It then opens like an app, without the browser bar. Once it has been opened on that phone it also works with no signal: the app itself loads, and so do the shifts it last read — the board keeps a copy of them, and the note at the top says exactly when they were read, so nobody mistakes an old week for today's. Changes you make with no signal aren't lost either: taping a day, entering times, adding expenses or an Other job are all kept on the phone as drafts, the day says so ("1 change waiting to be saved"), and nothing pretends it reached the calendar. When the signal comes back the app lists exactly what's waiting and asks before saving any of it — anything that then fails stays waiting rather than disappearing. The note clears itself and the board catches up on its own. Only the parts of an event ShiftBoard understands are kept, so nothing else from your calendar is written to the phone. Nothing is installed from a store and there's nothing to pay.
- **Sign out** forgets this browser's session so a coworker can sign in with their own Google account. Each coworker has to be added under **Test users** first (step 2).

## Checks

```bash
node tests/run.js      # or: npm test
```

About 200 checks run against the real `app.js`, `i18n.js` and `index.html` in a minute — the pay rules, the
report in both languages, the email, the PDF, and the app itself driven in headless Chrome on an emulated
phone, with Google faked. The last of them serves the real site over localhost and cuts the network, to prove
it still opens. [tests/README.md](tests/README.md) says what each one covers; GitHub Actions runs the same
command on every push.

## Known limits

- Testing-mode OAuth caps at 100 approved test users.
- No offline/local storage of schedule data — Calendar is the source of truth.
- If two ShiftBoard sessions edit the same week at once, last save wins.
- Staying signed in longer than an hour would need a backend — a browser-only app can't safely hold a refresh token.
- The PDF is drawn by the app, one image per page, so its text can't be selected or searched; the email itself gives both totals as text. (Google only exports a single tab to apps allowed to read your whole Drive, which ShiftBoard doesn't ask for.)
