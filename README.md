# ShiftBoard

Client-only weekly scheduler: pick "Event" or "Warehouse" for each day, save as all-day events on a Google Calendar of your choice.

## Setup (10 min)

1. **Google Cloud Console** (same project as your login button):
   - APIs & Services → Library → confirm **Google Calendar API** is enabled.
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
- Toggle **Event** / **Warehouse** per day (both can be on at once, not two of the same type).
- **Save changes** creates all-day events tagged with a hidden marker, so the app can recognize and delete/update them later — untag any calendar events you make manually elsewhere, they won't be touched.
- Switching weeks re-reads saved days from Calendar directly (no local database). Save before switching — the app asks before discarding unsaved toggles.

## Known limits

- Testing-mode OAuth caps at 100 approved test users.
- No offline/local storage of schedule data — Calendar is the source of truth.
- If two ShiftBoard sessions edit the same week at once, last save wins.
- Staying signed in longer than an hour would need a backend — a browser-only app can't safely hold a refresh token.
