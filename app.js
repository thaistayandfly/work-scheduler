const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
// "email" lets us show who's signed in and pass it as login_hint when the token needs renewing
const SCOPES = CALENDAR_SCOPE + " email";
const APP_TAG = "shiftboard";
const WORK_TYPES = ["Event", "Warehouse"];
const MIN_RESTORE_MS = 5 * 60 * 1000; // skip restoring a saved token that's about to expire

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;

let calendars = [];
let selectedCalendarId = localStorage.getItem("sb_calendarId") || "primary";

let currentWeekStart = getMonday(new Date());
// daysState[dateStr][type] = { active, originalActive, eventIds }
//   originalActive/eventIds: what the calendar had when the week loaded; active: what's selected now
let daysState = {};
let loadSeq = 0; // lets a slow events response for a previous week/calendar be ignored

const el = (id) => document.getElementById(id);

// ---------- Auth ----------

window.addEventListener("load", () => {
  waitForGoogle(() => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: onTokenReceived,
    });
  });
  el("signInBtn").addEventListener("click", () => {
    if (!tokenClient) return; // Google's script hasn't loaded yet
    // prompt "" only shows the consent screen when it's actually needed (e.g. first sign-in)
    const opts = { prompt: "" };
    const email = localStorage.getItem("sb_email");
    if (email) opts.login_hint = email;
    tokenClient.requestAccessToken(opts);
  });
  el("prevWeek").addEventListener("click", () => changeWeek(-7));
  el("nextWeek").addEventListener("click", () => changeWeek(7));
  el("newCalendarBtn").addEventListener("click", createNewCalendar);
  el("calendarSelect").addEventListener("change", (e) => {
    if (!confirmDiscard()) {
      e.target.value = selectedCalendarId;
      return;
    }
    selectedCalendarId = e.target.value;
    localStorage.setItem("sb_calendarId", selectedCalendarId);
    renderWeek();
  });
  el("saveBtn").addEventListener("click", saveChanges);
  window.addEventListener("beforeunload", (e) => {
    if (isDirty()) {
      e.preventDefault();
      e.returnValue = true;
    }
  });

  restoreSession();
});

function waitForGoogle(cb) {
  if (window.google && google.accounts && google.accounts.oauth2) cb();
  else setTimeout(() => waitForGoogle(cb), 100);
}

// A browser-only app can't renew a token without a popup, so keep the current one for its
// lifetime (~1h) instead of starting signed out on every page load.
function restoreSession() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem("sb_token"));
  } catch (e) {}
  if (saved && saved.accessToken && saved.expiresAt - Date.now() > MIN_RESTORE_MS) {
    startSession(saved.accessToken, saved.expiresAt);
  } else {
    localStorage.removeItem("sb_token");
  }
}

function onTokenReceived(resp) {
  if (resp.error) {
    showToast("Sign-in failed: " + resp.error, true);
    return;
  }
  if (!google.accounts.oauth2.hasGrantedAllScopes(resp, CALENDAR_SCOPE)) {
    showToast("Calendar access wasn't granted — sign in again and allow Google Calendar", true);
    return;
  }
  const expiresAt = Date.now() + (resp.expires_in || 3500) * 1000;
  localStorage.setItem("sb_token", JSON.stringify({ accessToken: resp.access_token, expiresAt }));
  startSession(resp.access_token, expiresAt);
}

function startSession(token, expiresAt) {
  accessToken = token;
  tokenExpiresAt = expiresAt;

  el("signInBtn").textContent = "Signed in";
  el("signInBtn").disabled = true;
  el("controls").hidden = false;
  el("weekGrid").hidden = false;
  el("saveBar").hidden = false;
  el("emptyState").hidden = true;

  fetchUserEmail();
  // Signing back in after the token expired mid-edit: refresh what's saved but keep the unsaved toggles
  if (isDirty()) loadEventsForWeek();
  else loadCalendars();
}

// Only used to display the email and pre-fill the next sign-in, so it uses plain fetch():
// a failure here must never count as "session expired" and sign the user out.
function fetchUserEmail() {
  fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + accessToken } })
    .then((r) => r.json())
    .then((info) => {
      if (info.email) {
        localStorage.setItem("sb_email", info.email);
        el("userEmail").textContent = info.email;
        el("userEmail").hidden = false;
      }
    })
    .catch(() => {});
}

function apiFetch(url, options = {}) {
  if (Date.now() > tokenExpiresAt - 5000) {
    showToast("Session expired — please sign in again", true);
    resetToSignedOut();
    return Promise.reject(new Error("token expired"));
  }
  options.headers = Object.assign({}, options.headers, {
    Authorization: "Bearer " + accessToken,
  });
  return fetch(url, options).then((r) => {
    if (r.status === 401) {
      showToast("Session expired — please sign in again", true);
      resetToSignedOut();
      throw new Error("unauthorized");
    }
    // fetch() only rejects on network errors — Google's 4xx/5xx replies have to be failures too
    if (!r.ok) {
      return r
        .json()
        .catch(() => ({}))
        .then((body) => {
          throw new Error((body.error && body.error.message) || "HTTP " + r.status);
        });
    }
    return r;
  });
}

// Skips the toast when apiFetch just signed the user out — it already said "Session expired"
function showApiError(prefix, err) {
  console.error("ShiftBoard: " + prefix, err);
  if (accessToken) showToast(prefix + ": " + err.message, true);
}

function resetToSignedOut() {
  accessToken = null;
  tokenExpiresAt = 0;
  localStorage.removeItem("sb_token");
  el("signInBtn").textContent = "Sign in with Google";
  el("signInBtn").disabled = false;
  el("controls").hidden = true;
  el("weekGrid").hidden = true;
  el("saveBar").hidden = true;
  el("emptyState").hidden = false;
}

// ---------- Calendars ----------

function loadCalendars() {
  apiFetch("https://www.googleapis.com/calendar/v3/users/me/calendarList")
    .then((r) => r.json())
    .then((data) => {
      // Read-only calendars (Holidays, Birthdays, subscriptions) reject new events
      calendars = (data.items || []).filter((cal) => cal.accessRole === "owner" || cal.accessRole === "writer");
      const select = el("calendarSelect");
      select.innerHTML = "";
      calendars.forEach((cal) => {
        const opt = document.createElement("option");
        opt.value = cal.id;
        opt.textContent = cal.summary + (cal.primary ? " (main)" : "");
        select.appendChild(opt);
      });
      // The list holds real IDs, never the "primary" alias, so fall back to the calendar flagged
      // primary rather than whichever one the API happened to return first
      if (!calendars.some((c) => c.id === selectedCalendarId)) {
        const fallback = calendars.find((c) => c.primary) || calendars[0];
        selectedCalendarId = fallback ? fallback.id : "primary";
      }
      localStorage.setItem("sb_calendarId", selectedCalendarId);
      select.value = selectedCalendarId;
      renderWeek();
    })
    .catch((err) => showApiError("Couldn't load calendars", err));
}

function createNewCalendar() {
  if (!confirmDiscard()) return;
  const name = prompt("Name for the new calendar (e.g. Work):");
  if (!name) return;
  apiFetch("https://www.googleapis.com/calendar/v3/calendars", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary: name }),
  })
    .then((r) => r.json())
    .then((cal) => {
      selectedCalendarId = cal.id;
      localStorage.setItem("sb_calendarId", selectedCalendarId);
      showToast('Calendar "' + name + '" created');
      loadCalendars();
    })
    .catch((err) => showApiError("Couldn't create calendar", err));
}

// ---------- Week rendering ----------

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function changeWeek(deltaDays) {
  if (!confirmDiscard()) return;
  currentWeekStart.setDate(currentWeekStart.getDate() + deltaDays);
  renderWeek();
}

// Local calendar date. toISOString() converts to UTC first, which in UTC+ timezones
// turns local midnight into the previous day.
function dateStr(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function renderWeek() {
  const grid = el("weekGrid");
  grid.innerHTML = "";
  daysState = {};

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(currentWeekStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }

  const fmt = { month: "short", day: "numeric" };
  el("weekLabel").textContent =
    days[0].toLocaleDateString(undefined, fmt) +
    " – " +
    days[6].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  const today = dateStr(new Date());

  days.forEach((d) => {
    const ds = dateStr(d);
    daysState[ds] = {
      Event: { active: false, originalActive: false, eventIds: [] },
      Warehouse: { active: false, originalActive: false, eventIds: [] },
    };

    const card = document.createElement("div");
    card.className = "day-card" + (ds === today ? " is-today" : "");
    card.dataset.date = ds;

    const label = document.createElement("div");
    label.className = "day-label";
    label.innerHTML =
      '<div class="day-name">' +
      d.toLocaleDateString(undefined, { weekday: "short" }) +
      '</div><div class="day-num">' +
      d.getDate() +
      "</div>";
    card.appendChild(label);

    const group = document.createElement("div");
    group.className = "pill-group";
    WORK_TYPES.forEach((type) => {
      const pill = document.createElement("button");
      pill.className = "pill";
      pill.type = "button";
      pill.dataset.type = type;
      pill.textContent = type;
      pill.addEventListener("click", () => togglePill(ds, type, pill, card));
      group.appendChild(pill);
    });
    card.appendChild(group);

    grid.appendChild(card);
  });

  if (accessToken) loadEventsForWeek();
}

function togglePill(ds, type, pillEl, cardEl) {
  const entry = daysState[ds][type];
  entry.active = !entry.active;
  pillEl.classList.toggle("is-active", entry.active);
  const anyActive = WORK_TYPES.some((t) => daysState[ds][t].active);
  cardEl.classList.toggle("has-selection", anyActive);
  updateSaveState();
}

function loadEventsForWeek() {
  if (!accessToken) return;
  const seq = ++loadSeq;
  const start = new Date(currentWeekStart);
  start.setDate(start.getDate() - 1); // pad a day either side to dodge timezone edge effects on all-day events
  const end = new Date(currentWeekStart);
  end.setDate(end.getDate() + 8);

  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: "true",
  });

  const url =
    "https://www.googleapis.com/calendar/v3/calendars/" +
    encodeURIComponent(selectedCalendarId) +
    "/events?" +
    params.toString();

  apiFetch(url)
    .then((r) => r.json())
    .then((data) => {
      if (seq !== loadSeq) return; // a newer week/calendar load has started since
      const saved = {}; // "2026-09-14|Event" -> [eventId, ...]
      (data.items || []).forEach((item) => {
        const ds = eventDate(item);
        const type = workTypeOf(item);
        if (ds && type) (saved[ds + "|" + type] = saved[ds + "|" + type] || []).push(item.id);
      });
      console.log("ShiftBoard: work events this week", saved);
      // Rebuild from what's actually in the calendar (so deleted events don't linger as "unsaved"),
      // keeping toggles the user hasn't saved yet — including ones that just failed to save
      Object.entries(daysState).forEach(([ds, day]) => {
        WORK_TYPES.forEach((type) => {
          const entry = day[type];
          const unsaved = entry.active !== entry.originalActive;
          entry.eventIds = saved[ds + "|" + type] || [];
          entry.originalActive = entry.eventIds.length > 0;
          if (!unsaved) entry.active = entry.originalActive;
        });
      });
      syncPillsToState();
      updateSaveState();
    })
    .catch((err) => showApiError("Couldn't load events", err));
}

// Events this app creates carry a hidden tag. Others — from the first version of the app, or added
// by hand — count when their title is the work type, e.g. "Warehouse" or "Work: Warehouse".
function workTypeOf(item) {
  const tag = item.extendedProperties && item.extendedProperties.private;
  if (tag && tag.appTag === APP_TAG && WORK_TYPES.includes(tag.workType)) return tag.workType;
  const title = (item.summary || "").trim().replace(/^work:\s*/i, "").toLowerCase();
  return WORK_TYPES.find((type) => type.toLowerCase() === title) || null;
}

// All-day events carry a plain date; timed ones count on the local day they start
function eventDate(item) {
  if (!item.start) return null;
  if (item.start.date) return item.start.date;
  return item.start.dateTime ? dateStr(new Date(item.start.dateTime)) : null;
}

function syncPillsToState() {
  document.querySelectorAll(".day-card").forEach((card) => {
    const ds = card.dataset.date;
    let any = false;
    card.querySelectorAll(".pill").forEach((pill) => {
      const type = pill.dataset.type;
      const active = daysState[ds][type].active;
      pill.classList.toggle("is-active", active);
      if (active) any = true;
    });
    card.classList.toggle("has-selection", any);
  });
}

// ---------- Saving ----------

function isDirty() {
  return Object.values(daysState).some((day) =>
    WORK_TYPES.some((type) => day[type].active !== day[type].originalActive)
  );
}

function confirmDiscard() {
  return !isDirty() || confirm("You have unsaved changes for this week. Discard them?");
}

function updateSaveState() {
  const dirty = isDirty();
  el("saveBtn").disabled = !dirty;
  el("statusText").textContent = dirty ? "Unsaved changes" : "No changes yet";
}

// Compares what's selected now with what the calendar had when the week loaded:
// selected but not in the calendar -> create; in the calendar but unselected -> delete.
function saveChanges() {
  const tasks = [];

  Object.entries(daysState).forEach(([ds, types]) => {
    WORK_TYPES.forEach((type) => {
      const entry = types[type];
      if (entry.active && !entry.originalActive) {
        tasks.push(insertEvent(ds, type));
      } else if (!entry.active && entry.originalActive) {
        // Every matching event that day goes, so a duplicate can't make the type reappear
        entry.eventIds.forEach((id) => tasks.push(deleteEvent(id)));
      }
    });
  });

  if (tasks.length === 0) return;

  el("saveBtn").disabled = true;
  el("statusText").textContent = "Saving…";

  Promise.allSettled(tasks).then((results) => {
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length) {
      showApiError(failures.length + " change(s) failed to save", failures[0].reason);
    } else {
      showToast("Saved");
    }
    updateSaveState();
    loadEventsForWeek();
  });
}

function insertEvent(ds, type) {
  const end = new Date(ds + "T00:00:00"); // no offset = local midnight (a bare "YYYY-MM-DD" parses as UTC)
  end.setDate(end.getDate() + 1);

  const body = {
    summary: type,
    start: { date: ds },
    end: { date: dateStr(end) },
    extendedProperties: { private: { appTag: APP_TAG, workType: type } },
  };

  return apiFetch(
    "https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(selectedCalendarId) + "/events",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function deleteEvent(eventId) {
  return apiFetch(
    "https://www.googleapis.com/calendar/v3/calendars/" +
      encodeURIComponent(selectedCalendarId) +
      "/events/" +
      eventId,
    { method: "DELETE" }
  );
}

// ---------- Toast ----------

let toastTimer = null;
function showToast(msg, isError) {
  const t = el("toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3000);
}
