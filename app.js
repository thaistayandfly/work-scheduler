const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
// "email" lets us show who's signed in and pass it as login_hint when the token needs renewing
const SCOPES = CALENDAR_SCOPE + " email";
const APP_TAG = "shiftboard";
const WORK_TYPES = ["Event", "Warehouse"];
const OTHER = "Other"; // the rare one-off paid job, kept off the two main tapes
const EXPENSE_TYPES = ["Travel", "Food", "Hotel", "Other"];
const MIN_RESTORE_MS = 5 * 60 * 1000; // skip restoring a saved token that's about to expire
const WEEKS_PER_PAGE = 4; // weeks on the board at first, and how many "Show 4 more weeks" adds

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;

let calendars = [];
let selectedCalendarId = localStorage.getItem("sb_calendarId") || "primary";

// Mondays of the weeks on the board, earliest first
let weeks = [];
// daysState[dateStr][type] = { active, originalActive, eventIds, events }
//   originalActive/eventIds/events: what the calendar had when that week loaded; active: what's selected now
// daysState[dateStr].others = that day's saved "Other" jobs (calendar events)
let daysState = {};
// Board elements, so one day or week can be updated without re-rendering the rest
let dayButtons = {}; // dateStr -> { Event: <button>, Warehouse: <button> }
let dayMeta = {}; // dateStr -> the line under a day's tapes showing its times and extras
let weekEls = {}; // Monday's dateStr -> { section, error, loaded, failed }
let boardSeq = 0; // bumped whenever the board is rebuilt, so responses meant for the old one are ignored
let saving = false;

const el = (id) => document.getElementById(id);
const rangeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

// ---------- Auth ----------

window.addEventListener("load", () => {
  waitForGoogle(() => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: SCOPES,
      callback: onTokenReceived,
    });
  });
  el("signInBtn").addEventListener("click", signIn);
  el("signOutBtn").addEventListener("click", signOut);
  el("earlierBtn").addEventListener("click", () => addWeeks(-1));
  el("moreWeeksBtn").addEventListener("click", () => addWeeks(WEEKS_PER_PAGE));
  el("newCalendarBtn").addEventListener("click", createNewCalendar);
  el("calendarSelect").addEventListener("change", (e) => {
    if (!confirmDiscard()) {
      e.target.value = selectedCalendarId;
      return;
    }
    selectedCalendarId = e.target.value;
    localStorage.setItem("sb_calendarId", selectedCalendarId);
    resetBoard();
  });
  el("saveBtn").addEventListener("click", saveChanges);
  el("needsTimesBtn").addEventListener("click", openMissingTimes);
  el("boardHint").hidden = !!localStorage.getItem("sb_hintSeen");
  el("toast").addEventListener("click", () => (el("toast").hidden = true));
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

function signIn() {
  if (!tokenClient) return; // Google's script hasn't loaded yet
  // prompt "" only shows the consent screen when it's actually needed (e.g. first sign-in)
  const opts = { prompt: "" };
  const email = localStorage.getItem("sb_email");
  if (email) opts.login_hint = email;
  tokenClient.requestAccessToken(opts);
}

// Forgets this browser's session and whose it was, so a coworker can sign in with their own account
function signOut() {
  if (!confirmDiscard()) return;
  localStorage.removeItem("sb_email");
  localStorage.removeItem("sb_calendarId");
  selectedCalendarId = "primary";
  calendars = [];
  el("accountEmail").textContent = "";
  clearBoard();
  resetToSignedOut();
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
  showSignedIn(true);
  fetchUserEmail();
  // Signing back in after the token expired mid-edit: refresh what's saved but keep the unsaved toggles
  if (isDirty()) loadWeeks(weeks);
  else loadCalendars();
}

function showSignedIn(signedIn) {
  document.body.classList.toggle("is-signed-in", signedIn);
  el("welcome").hidden = signedIn;
  el("workspace").hidden = !signedIn;
  el("saveBar").hidden = !signedIn;
  el("account").hidden = !signedIn;
}

// Only used to display the email and pre-fill the next sign-in, so it uses plain fetch():
// a failure here must never count as "session expired" and sign the user out.
function fetchUserEmail() {
  fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + accessToken } })
    .then((r) => r.json())
    .then((info) => {
      if (info.email) {
        localStorage.setItem("sb_email", info.email);
        el("accountEmail").textContent = info.email;
        el("accountEmail").title = info.email;
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
  showSignedIn(false);
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
      el("calendarEmpty").hidden = calendars.length > 0;
      if (calendars.length) resetBoard();
      else clearBoard();
    })
    .catch((err) => showApiError("Couldn't load your calendars", err));
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
    .catch((err) => showApiError("Couldn't create the calendar", err));
}

// ---------- Dates ----------

function getMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Local calendar date. toISOString() converts to UTC first, which in UTC+ timezones
// turns local midnight into the previous day.
function dateStr(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function weekDates(monday) {
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    dates.push(dateStr(d));
  }
  return dates;
}

// "This week" / "Next week" / "Last week" for nearby weeks; the rest go by their dates alone
function weekName(monday) {
  const diff = Math.round((monday - getMonday(new Date())) / (7 * 24 * 60 * 60 * 1000));
  return { "-1": "Last week", 0: "This week", 1: "Next week" }[diff] || "";
}

function formatRange(from, to) {
  if (rangeFormat.formatRange) return rangeFormat.formatRange(from, to);
  return rangeFormat.format(from) + " – " + rangeFormat.format(to);
}

// ---------- Board ----------

function clearBoard() {
  boardSeq++;
  weeks = [];
  daysState = {};
  dayButtons = {};
  dayMeta = {};
  weekEls = {};
  missingTimes = [];
  el("needsTimesBtn").hidden = true;
  el("board").innerHTML = "";
  updateSaveState();
}

// Starts the board over at this week for the selected calendar, dropping unsaved toggles
function resetBoard() {
  clearBoard();
  addWeeks(WEEKS_PER_PAGE);
  loadMissingTimes();
}

// Adds weeks after the last one (count > 0) or before the first (count < 0), then loads their shifts
function addWeeks(count) {
  const board = el("board");
  const added = [];
  for (let i = 0; i < Math.abs(count); i++) {
    let monday;
    if (!weeks.length) {
      monday = getMonday(new Date());
    } else {
      monday = new Date(count > 0 ? weeks[weeks.length - 1] : weeks[0]);
      monday.setDate(monday.getDate() + (count > 0 ? 7 : -7));
    }
    const section = renderWeek(monday);
    if (count > 0) {
      weeks.push(monday);
      board.appendChild(section);
    } else {
      weeks.unshift(monday);
      board.insertBefore(section, board.firstChild);
    }
    added.push(monday);
  }
  loadWeeks(added);
}

function renderWeek(monday) {
  const key = dateStr(monday);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);

  const section = document.createElement("section");
  section.className = "week";
  section.setAttribute("aria-labelledby", "week-" + key);

  const title = document.createElement("h2");
  title.className = "week-title";
  title.id = "week-" + key;
  const name = weekName(monday);
  const range = formatRange(monday, sunday);
  title.innerHTML = name ? name + ' <span class="week-dates">' + range + "</span>" : range;
  section.appendChild(title);

  const error = document.createElement("p");
  error.className = "week-error";
  error.hidden = true;
  error.textContent = "Couldn't load this week.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn-text";
  retry.textContent = "Try again";
  retry.addEventListener("click", () => loadWeeks([monday]));
  error.appendChild(retry);
  section.appendChild(error);

  const list = document.createElement("ol");
  list.className = "days";
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(d.getDate() + i);
    list.appendChild(renderDay(d));
  }
  section.appendChild(list);

  weekEls[key] = { section, error, loaded: false, failed: false };
  return section;
}

function renderDay(d) {
  const ds = dateStr(d);
  const today = dateStr(new Date());
  daysState[ds] = {};
  WORK_TYPES.forEach((type) => (daysState[ds][type] = { active: false, originalActive: false, eventIds: [], events: [] }));
  daysState[ds].others = [];

  const row = document.createElement("li");
  row.className = "day" + (ds === today ? " is-today" : ds < today ? " is-past" : "");
  row.dataset.date = ds;

  const longDate = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const label = document.createElement("button");
  label.type = "button";
  label.className = "day-label";
  label.setAttribute("aria-label", longDate + (ds === today ? ", today" : "") + ": times, nights, expenses and Other jobs");
  label.addEventListener("click", () => openDayPanel(ds));
  label.innerHTML =
    '<span class="dow">' +
    d.toLocaleDateString(undefined, { weekday: "short" }) +
    '</span><span class="dnum">' +
    d.getDate() +
    "</span>" +
    (ds === today ? '<span class="sr-only">Today</span>' : "");
  row.appendChild(label);

  const slots = document.createElement("div");
  slots.className = "slots";
  dayButtons[ds] = {};
  WORK_TYPES.forEach((type) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tape type-" + type.toLowerCase();
    btn.dataset.type = type;
    btn.disabled = true; // until the week's shifts have loaded, so a saved one can't be added twice
    btn.setAttribute("aria-label", type + ", " + longDate);
    btn.innerHTML = '<span class="strip"></span><span class="tape-label">' + type + "</span>";
    btn.addEventListener("click", () => toggleShift(ds, type));
    slots.appendChild(btn);
    dayButtons[ds][type] = btn;
  });
  row.appendChild(slots);

  const meta = document.createElement("button");
  meta.type = "button";
  meta.className = "day-meta";
  meta.hidden = true;
  meta.addEventListener("click", () => openDayPanel(ds));
  row.appendChild(meta);
  dayMeta[ds] = meta;

  syncDay(ds);
  return row;
}

function syncDay(ds) {
  WORK_TYPES.forEach((type) => {
    const entry = daysState[ds][type];
    const btn = dayButtons[ds][type];
    btn.classList.toggle("is-on", entry.active);
    btn.classList.toggle("is-changed", entry.active !== entry.originalActive);
    btn.setAttribute("aria-pressed", String(entry.active));
  });
  // Under the tapes: real times and extras once entered, and a nudge for past shifts still missing times
  const parts = savedShifts(ds)
    .filter(({ event }) => isTimed(event) || ds <= dateStr(new Date()))
    .map(({ type, event }) => shiftSummary(type, event));
  dayMeta[ds].hidden = parts.length === 0;
  dayMeta[ds].classList.toggle("needs-times", parts.some((p) => p.endsWith("add times")));
  dayMeta[ds].textContent = parts.join("\n");
}

function savedShifts(ds) {
  const day = daysState[ds];
  const list = [];
  WORK_TYPES.forEach((type) => day[type].events.forEach((event) => list.push({ type, event })));
  day.others.forEach((event) => list.push({ type: OTHER, event }));
  return list;
}

const moneyFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "ILS" });
const clock = (d) => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");

function shiftSummary(type, event) {
  if (!isTimed(event)) return type + ": add times";
  const start = new Date(event.start.dateTime);
  const end = new Date(event.end.dateTime);
  const laterDays = Math.round((new Date(dateStr(end) + "T00:00") - new Date(dateStr(start) + "T00:00")) / 864e5);
  let text = type + " " + clock(start) + "–" + clock(end) + (laterDays > 0 ? " (+" + laterDays + ")" : "");
  const props = privateProps(event);
  if (type === OTHER) text += ", " + moneyFormat.format(Number(props.amount) || 0);
  if (props.slept === "1") text += ", night";
  const spent = expensesOf(event).reduce((sum, x) => sum + Number(x.amount), 0);
  if (spent) text += ", " + moneyFormat.format(spent) + " expenses";
  return text;
}

function toggleShift(ds, type) {
  const entry = daysState[ds][type];
  entry.active = !entry.active;
  syncDay(ds);
  updateSaveState();
}

// Reads the calendar for the given weeks and shows what's saved, keeping toggles not saved yet
function loadWeeks(list) {
  if (!accessToken || !list.length) return;
  const seq = boardSeq;
  const start = new Date(Math.min(...list));
  start.setDate(start.getDate() - 1); // pad a day either side to dodge timezone edge effects on all-day events
  const end = new Date(Math.max(...list));
  end.setDate(end.getDate() + 8);
  setWeeksBusy(list, true);

  fetchEvents(start, end)
    .then((items) => {
      if (seq !== boardSeq) return; // the board was rebuilt (e.g. another calendar) in the meantime
      const saved = {}; // "2026-09-14|Event" -> [calendar event, ...]; "Other" jobs are grouped the same way
      items.forEach((item) => {
        const ds = eventDate(item);
        const type = workTypeOf(item);
        if (ds && type) (saved[ds + "|" + type] = saved[ds + "|" + type] || []).push(item);
      });
      // Rebuild from what's actually in the calendar (so deleted events don't linger as "unsaved"),
      // keeping toggles the user hasn't saved yet — including ones that just failed to save
      list.forEach((monday) => {
        weekDates(monday).forEach((ds) => {
          WORK_TYPES.forEach((type) => {
            const entry = daysState[ds][type];
            const unsaved = entry.active !== entry.originalActive;
            entry.events = saved[ds + "|" + type] || [];
            entry.eventIds = entry.events.map((ev) => ev.id);
            entry.originalActive = entry.events.length > 0;
            if (!unsaved) entry.active = entry.originalActive;
          });
          daysState[ds].others = saved[ds + "|" + OTHER] || [];
          syncDay(ds);
        });
      });
      setWeeksBusy(list, false);
    })
    .catch((err) => {
      if (seq !== boardSeq) return;
      setWeeksBusy(list, false, true);
      showApiError("Couldn't load your shifts", err);
    });
}

function setWeeksBusy(list, busy, failed = false) {
  list.forEach((monday) => {
    const week = weekEls[dateStr(monday)];
    if (!week) return;
    if (!busy && !failed) week.loaded = true;
    week.failed = failed;
    week.section.setAttribute("aria-busy", String(busy));
    week.error.hidden = !failed || week.loaded;
    // Taps wait for a week's first load; later reloads keep unsaved toggles, so they stay tappable
    weekDates(monday).forEach((ds) => WORK_TYPES.forEach((type) => (dayButtons[ds][type].disabled = !week.loaded)));
    if (!busy) {
      week.section.dataset.settling = "";
      setTimeout(() => delete week.section.dataset.settling, 80);
    }
  });
  updateSaveState();
}

function fetchEvents(start, end, pageToken, items = []) {
  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: "true",
    maxResults: "250",
  });
  if (pageToken) params.set("pageToken", pageToken);
  const url =
    "https://www.googleapis.com/calendar/v3/calendars/" +
    encodeURIComponent(selectedCalendarId) +
    "/events?" +
    params.toString();
  return apiFetch(url)
    .then((r) => r.json())
    .then((data) => {
      items.push(...(data.items || []));
      return data.nextPageToken ? fetchEvents(start, end, data.nextPageToken, items) : items;
    });
}

// Events this app creates carry a hidden tag. Others — from the first version of the app, or added
// by hand — count when their title is the work type, e.g. "Warehouse" or "Work: Warehouse".
function workTypeOf(item) {
  const tag = item.extendedProperties && item.extendedProperties.private;
  if (tag && tag.appTag === APP_TAG && (WORK_TYPES.includes(tag.workType) || tag.workType === OTHER)) return tag.workType;
  const title = (item.summary || "").trim().replace(/^work:\s*/i, "").toLowerCase();
  if (/^other(\s*[-–:]|$)/.test(title)) return OTHER; // "Other" or "Other – move gear to X"
  return WORK_TYPES.find((type) => type.toLowerCase() === title) || null;
}

// Shifts start as all-day events; entering the real times turns them into timed events
function isTimed(item) {
  return !!(item.start && item.start.dateTime && item.end && item.end.dateTime);
}

function hoursOf(item) {
  return isTimed(item) ? (new Date(item.end.dateTime) - new Date(item.start.dateTime)) / 3600000 : null;
}

function privateProps(item) {
  return (item.extendedProperties && item.extendedProperties.private) || {};
}

function expensesOf(item) {
  try {
    const list = JSON.parse(privateProps(item).expenses || "[]");
    return Array.isArray(list) ? list.filter((e) => e && Number(e.amount) > 0) : [];
  } catch (e) {
    return []; // hand-edited or broken data mustn't stop the board
  }
}

// <input type="datetime-local"> speaks local "YYYY-MM-DDTHH:MM"
function toInputValue(d) {
  return dateStr(d) + "T" + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

// All-day events carry a plain date; timed ones count on the local day they start
function eventDate(item) {
  if (!item.start) return null;
  if (item.start.date) return item.start.date;
  return item.start.dateTime ? dateStr(new Date(item.start.dateTime)) : null;
}

// ---------- Day panel: real times, a night at work, expenses and Other jobs ----------

// Empties the shared panel and gives it a title and a Close button; the caller fills and shows it
function openPanel(titleText) {
  const panel = el("dayPanel");
  panel.innerHTML = "";
  const head = document.createElement("div");
  head.className = "panel-head";
  const title = document.createElement("h2");
  title.id = "dayPanelTitle";
  title.tabIndex = -1;
  title.autofocus = true; // opening the panel lands on its title, not on Close
  title.textContent = titleText;
  head.append(title, makeButton("Close", "btn-text", () => panel.close()));
  panel.appendChild(head);
  return panel;
}

function openDayPanel(ds) {
  const panel = openPanel(new Date(ds + "T00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }));
  localStorage.setItem("sb_hintSeen", "1"); // they found the date button, so the hint has done its job
  el("boardHint").hidden = true;

  const shifts = savedShifts(ds);
  if (!shifts.length) {
    const empty = document.createElement("p");
    empty.className = "panel-note";
    empty.textContent = "No saved shifts on this day yet. Tap Event or Warehouse on the board and save first, or add an Other job.";
    panel.appendChild(empty);
  }
  shifts.forEach(({ type, event }) => panel.appendChild(shiftForm(ds, type, event)));

  const addOther = makeButton("Add an Other job", "btn-quiet add-other", () => addOther.replaceWith(shiftForm(ds, OTHER, null)));
  panel.appendChild(addOther);
  panel.showModal();
}

function makeButton(text, className, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = text;
  btn.addEventListener("click", onClick);
  return btn;
}

function formatHours(hours) {
  const minutes = Math.round(hours * 60);
  return Math.floor(minutes / 60) + " h " + String(minutes % 60).padStart(2, "0") + " min";
}

function shiftForm(ds, type, event) {
  const timed = !!event && isTimed(event);
  const start = timed ? new Date(event.start.dateTime) : null;
  const end = timed ? new Date(event.end.dateTime) : null;
  const props = event ? privateProps(event) : {};

  const form = document.createElement("form");
  form.className = "shift-form type-" + type.toLowerCase();
  form.noValidate = true; // our own messages instead of the browser's bubbles
  form.innerHTML =
    "<h3>" + type + "</h3>" +
    '<div class="when"><span class="when-label">Start</span><input name="startDate" type="date" aria-label="Start date"><input name="startTime" type="time" aria-label="Start time"></div>' +
    '<div class="when"><span class="when-label">End</span><input name="endDate" type="date" aria-label="End date"><input name="endTime" type="time" aria-label="End time"></div>' +
    '<p class="duration" aria-live="polite"></p>' +
    (type === OTHER
      ? '<label class="field">Amount paid (₪)<input name="amount" type="number" min="0" step="0.01" inputmode="decimal"></label>' +
        '<label class="field">What was it? <span class="optional">(optional)</span><input name="note" type="text" maxlength="120"></label>'
      : "") +
    (type === "Event" ? '<label class="check"><input name="slept" type="checkbox"> Slept at work (night)</label>' : "") +
    '<fieldset class="expenses"><legend>Expenses</legend><div class="expense-list"></div></fieldset>' +
    '<p class="form-error" role="alert" hidden></p>' +
    '<div class="form-actions"><button type="submit" class="btn-primary">Save ' + type + "</button></div>";

  const f = form.elements;
  f.startDate.value = start ? dateStr(start) : ds;
  f.startTime.value = start ? clock(start) : "";
  f.endDate.value = end ? dateStr(end) : ds;
  f.endTime.value = end ? clock(end) : "";
  if (type === OTHER) {
    f.amount.value = props.amount || "";
    f.note.value = props.note || "";
  }
  if (type === "Event") f.slept.checked = props.slept === "1";

  const list = form.querySelector(".expense-list");
  expensesOf(event || {}).forEach((x) => list.appendChild(expenseRow(x)));
  form.querySelector(".expenses").appendChild(
    makeButton("Add an expense", "btn-text", () => list.appendChild(expenseRow({ type: "Travel", amount: "" })))
  );

  const showDuration = () => {
    const hours = (new Date(f.endDate.value + "T" + f.endTime.value) - new Date(f.startDate.value + "T" + f.startTime.value)) / 3600000;
    form.querySelector(".duration").textContent =
      hours > 0 ? formatHours(hours) + (type === "Event" && hours > 12 ? ", of which " + formatHours(hours - 12) + " extra" : "") : "";
  };
  // An end time earlier than the start means the shift finished the next day (night shifts)
  const rollEnd = () => {
    if (f.startTime.value && f.endTime.value && f.endDate.value === f.startDate.value && f.endTime.value <= f.startTime.value) {
      const next = new Date(f.startDate.value + "T00:00");
      next.setDate(next.getDate() + 1);
      f.endDate.value = dateStr(next);
    }
    showDuration();
  };
  [f.startDate, f.startTime, f.endTime].forEach((input) => input.addEventListener("change", rollEnd));
  f.endDate.addEventListener("change", showDuration);
  showDuration();

  if (event && type === OTHER) {
    form.querySelector(".form-actions").prepend(makeButton("Remove job", "btn-text", () => removeOtherJob(event)));
  }
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submitShiftForm(form, type, event);
  });
  return form;
}

function expenseRow(x) {
  const row = document.createElement("div");
  row.className = "expense";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Expense type");
  EXPENSE_TYPES.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    select.appendChild(opt);
  });
  select.value = EXPENSE_TYPES.includes(x.type) ? x.type : "Other";
  const amount = document.createElement("input");
  amount.type = "number";
  amount.min = "0";
  amount.step = "0.01";
  amount.inputMode = "decimal";
  amount.placeholder = "₪";
  amount.setAttribute("aria-label", "Expense amount in shekels");
  amount.value = x.amount;
  row.append(select, amount, makeButton("Remove", "btn-text", () => row.remove()));
  return row;
}

function submitShiftForm(form, type, event) {
  const f = form.elements;
  const start = new Date(f.startDate.value + "T" + f.startTime.value);
  const end = new Date(f.endDate.value + "T" + f.endTime.value);
  const fail = (msg) => {
    const p = form.querySelector(".form-error");
    p.textContent = msg;
    p.hidden = false;
  };
  if (!f.startTime.value || !f.endTime.value || isNaN(start) || isNaN(end)) return fail("Enter the start and end time.");
  if (end <= start) return fail("The end has to be after the start.");

  const expenses = [...form.querySelectorAll(".expense")]
    .map((row) => ({ type: row.querySelector("select").value, amount: Number(row.querySelector("input").value) }))
    .filter((x) => x.amount > 0);
  const extras = { expenses: JSON.stringify(expenses) };
  if (type === "Event") extras.slept = f.slept.checked ? "1" : "0";
  let summary;
  if (type === OTHER) {
    const amount = Number(f.amount.value);
    if (!(amount > 0)) return fail("Enter how much this job paid.");
    extras.amount = String(amount);
    extras.note = f.note.value.trim();
    summary = extras.note ? OTHER + " – " + extras.note : OTHER;
  }

  const btn = form.querySelector('[type="submit"]');
  btn.disabled = true;
  btn.textContent = "Saving…";
  saveShiftEvent(event && event.id, { type, start, end, extras, summary })
    .then(() => {
      // In the missing-times list the other shifts stay open; everywhere else the panel is done
      const panel = el("dayPanel");
      form.remove();
      if (!form.dataset.keepOpen || !panel.querySelector("form")) panel.close();
      showToast(type + " saved to Google Calendar");
      loadWeeks(weeks);
      loadMissingTimes();
    })
    .catch((err) => {
      btn.disabled = false;
      btn.textContent = "Save " + type;
      if (accessToken) fail("Couldn't save: " + err.message);
    });
}

function removeOtherJob(event) {
  deleteEvent(event.id)
    .then(() => {
      el("dayPanel").close();
      showToast("Other job removed");
      loadWeeks(weeks);
      loadMissingTimes();
    })
    .catch((err) => showApiError("Couldn't remove the job", err));
}

// ---------- Past shifts still missing their times (this month and last) ----------

let missingTimes = []; // [{ ds, type, event }]

function loadMissingTimes() {
  if (!accessToken) return;
  const seq = boardSeq;
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  fetchEvents(from, to)
    .then((items) => {
      if (seq !== boardSeq) return;
      const today = dateStr(new Date());
      missingTimes = items
        .map((event) => ({ event, type: workTypeOf(event), ds: eventDate(event) }))
        .filter((s) => s.type && s.ds && s.ds <= today && !isTimed(s.event))
        .sort((a, b) => (a.ds < b.ds ? -1 : a.ds > b.ds ? 1 : 0));
      const btn = el("needsTimesBtn");
      btn.hidden = !missingTimes.length;
      btn.textContent =
        missingTimes.length === 1 ? "1 past shift still needs its times" : missingTimes.length + " past shifts still need their times";
    })
    .catch(() => {}); // the board already reports loading problems
}

function openMissingTimes() {
  const panel = openPanel("Shifts missing times");
  missingTimes.forEach(({ ds, type, event }) => {
    const form = shiftForm(ds, type, event);
    form.dataset.keepOpen = "1";
    form.querySelector("h3").textContent =
      type + " · " + new Date(ds + "T00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    panel.appendChild(form);
  });
  panel.showModal();
}

// ---------- Saving ----------

function isDirty() {
  return Object.values(daysState).some((day) =>
    WORK_TYPES.some((type) => day[type].active !== day[type].originalActive)
  );
}

function confirmDiscard() {
  return !isDirty() || confirm("You have shifts that aren't saved yet. Discard them?");
}

function updateSaveState() {
  let adds = 0;
  let removes = 0;
  Object.values(daysState).forEach((day) => {
    WORK_TYPES.forEach((type) => {
      if (day[type].active && !day[type].originalActive) adds++;
      else if (!day[type].active && day[type].originalActive) removes++;
    });
  });
  const dirty = adds + removes > 0;
  const loading = Object.values(weekEls).some((week) => !week.loaded && !week.failed);
  const status = el("statusText");
  status.classList.toggle("is-quiet", !dirty && !saving);
  if (saving) status.textContent = "Saving to Google Calendar…";
  else if (dirty) status.textContent = [adds && adds + " to add", removes && removes + " to remove"].filter(Boolean).join(" · ");
  else if (loading) status.textContent = "Loading your shifts…";
  else status.textContent = "No unsaved changes";
  el("saveBtn").disabled = !dirty || saving;
  el("saveBtn").textContent = saving ? "Saving…" : "Save to Calendar";
}

// Compares what's selected now with what the calendar had when each week loaded:
// selected but not in the calendar -> create; in the calendar but unselected -> delete.
function saveChanges() {
  if (saving) return;
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

  saving = true;
  updateSaveState();

  Promise.allSettled(tasks).then((results) => {
    saving = false;
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length) {
      const prefix = failures.length === 1 ? "1 change couldn't be saved" : failures.length + " changes couldn't be saved";
      showApiError(prefix, failures[0].reason);
    } else {
      showToast("Saved to Google Calendar");
    }
    updateSaveState();
    loadWeeks(weeks);
    loadMissingTimes();
  });
}

function eventsUrl(eventId) {
  return (
    "https://www.googleapis.com/calendar/v3/calendars/" +
    encodeURIComponent(selectedCalendarId) +
    "/events" +
    (eventId ? "/" + encodeURIComponent(eventId) : "")
  );
}

// Writes a shift's real times and extras onto its calendar event (an all-day event becomes a timed one;
// `date: null` clears the all-day date). Extended-property values have to be strings.
function saveShiftEvent(eventId, { type, start, end, extras, summary }) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const body = {
    start: { date: null, dateTime: start.toISOString(), timeZone },
    end: { date: null, dateTime: end.toISOString(), timeZone },
    extendedProperties: { private: Object.assign({ appTag: APP_TAG, workType: type }, extras) },
  };
  if (summary) body.summary = summary;
  return apiFetch(eventId ? eventsUrl(eventId) : eventsUrl(), {
    method: eventId ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
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
  t.className = "toast" + (isError ? " is-error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 3000);
}
