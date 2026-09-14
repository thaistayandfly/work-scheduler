# ShiftBoard

Client-only weekly scheduler: pick "Event" or "Warehouse" for each day, save as all-day events on a Google Calendar of your choice.

## Setup (10 min)

1. **Google Cloud Console** (same project as your login button):
   - APIs & Services → Library → confirm **Google Calendar API**, **Google Sheets API** and **Google Drive API** are enabled (the last two are for the Pay tab's sheet).
   - APIs & Services → Credentials → **Create Credentials → OAuth client ID → Web application**.
     - Under **Authorized JavaScript origins**, add your GitHub Pages URL, e.g. `https://yourname.github.io`.
     - No redirect URI needed.
   - Copy the generated **Client ID**.

2. **OAuth consent screen** → Scopes → add `.../auth/calendar` (full access — needed to create calendars, not just events). Keep the app in **Testing** mode and add your Google account(s) under **Test users** (up to 100).

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
- **Tap a date** to enter a shift's real start and end (it can run past midnight), mark a night slept at work (Event), add expenses, or add an **Other** job (times and amount required, description optional). Entering times turns the calendar event from all-day into a timed one. A red banner lists past shifts from this month and last that still need their times.
- **Pay** tab: connect Google Drive once and ShiftBoard creates a "ShiftBoard pay" sheet in your own Drive (it can only open files it creates). Enter your full name, the company email and your four rates; they're saved in the sheet's Settings tab. Each month shows every shift's pay, the breakdown and the total to pay. **Update my sheet** writes the month into its own tab (English and Hebrew), and asks first if that tab was changed by hand.
- **Sign out** forgets this browser's session so a coworker can sign in with their own Google account. Each coworker has to be added under **Test users** first (step 2).

## Known limits

- Testing-mode OAuth caps at 100 approved test users.
- No offline/local storage of schedule data — Calendar is the source of truth.
- If two ShiftBoard sessions edit the same week at once, last save wins.
- Staying signed in longer than an hour would need a backend — a browser-only app can't safely hold a refresh token.
