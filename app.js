const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
// Only the files this app creates (the pay sheet), nothing else in the user's Drive
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
// "email" lets us show who's signed in and pass it as login_hint when the token needs renewing
const SCOPES = CALENDAR_SCOPE + " " + DRIVE_SCOPE + " email";
const APP_TAG = "shiftboard";
const WORK_TYPES = ["Event", "Warehouse"];
const OTHER = "Other"; // the rare one-off paid job, kept off the two main tapes
const EXPENSE_TYPES = ["Travel", "Food", "Hotel", "Other"];
const MIN_RESTORE_MS = 5 * 60 * 1000; // skip restoring a saved token that's about to expire
const WEEKS_PER_PAGE = 4; // weeks on the board at first, and how many "Show 4 more weeks" adds

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let grantedScopes = ""; // what the current token may do; older saved tokens predate the Drive permission

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
  el("tabShifts").addEventListener("click", () => showView("shifts"));
  el("tabPay").addEventListener("click", () => showView("pay"));
  el("connectDriveBtn").addEventListener("click", () => {
    pendingView = "pay"; // come back to Pay once the Drive permission is granted
    signIn();
  });
  el("prevMonth").addEventListener("click", () => changePayMonth(-1));
  el("nextMonth").addEventListener("click", () => changePayMonth(1));
  el("settingsForm").addEventListener("submit", submitSettings);
  el("writeSheetBtn").addEventListener("click", updateSheet);
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
  forgetSheet();
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
    startSession(saved.accessToken, saved.expiresAt, saved.scope || "");
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
  localStorage.setItem("sb_token", JSON.stringify({ accessToken: resp.access_token, expiresAt, scope: resp.scope || "" }));
  startSession(resp.access_token, expiresAt, resp.scope || "");
}

function startSession(token, expiresAt, scope) {
  accessToken = token;
  tokenExpiresAt = expiresAt;
  grantedScopes = scope || "";
  showSignedIn(true);
  fetchUserEmail();
  // Signing back in after the token expired mid-edit: refresh what's saved but keep the unsaved toggles
  if (isDirty()) loadWeeks(weeks);
  else loadCalendars();
  if (pendingView) {
    showView(pendingView);
    pendingView = null;
  }
}

function showSignedIn(signedIn) {
  document.body.classList.toggle("is-signed-in", signedIn);
  el("welcome").hidden = signedIn;
  el("workspace").hidden = !signedIn;
  el("saveBar").hidden = !signedIn;
  el("account").hidden = !signedIn;
  el("viewTabs").hidden = !signedIn;
  el("payView").hidden = true; // every sign-in starts on the Shifts view
  el("tabShifts").setAttribute("aria-pressed", "true");
  el("tabPay").setAttribute("aria-pressed", "false");
  document.body.classList.toggle("is-pay", false);
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

// "06:00–04:00 (+1)": the (+n) says how many days later the shift ended
function timeRange(event) {
  const start = new Date(event.start.dateTime);
  const end = new Date(event.end.dateTime);
  const laterDays = Math.round((new Date(dateStr(end) + "T00:00") - new Date(dateStr(start) + "T00:00")) / 864e5);
  return clock(start) + "–" + clock(end) + (laterDays > 0 ? " (+" + laterDays + ")" : "");
}

function shiftSummary(type, event) {
  if (!isTimed(event)) return type + ": add times";
  let text = type + " " + timeRange(event);
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
      refreshAfterShiftChange();
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
      refreshAfterShiftChange();
    })
    .catch((err) => showApiError("Couldn't remove the job", err));
}

function refreshAfterShiftChange() {
  loadWeeks(weeks);
  loadMissingTimes();
  if (!el("payView").hidden) renderPayMonth();
}

// ---------- The pay sheet: a Google Sheet in the user's own Drive ----------

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
// Settings tab: A = label, B = value, C = key. Values are found by key, so rows moved by hand still work.
const SETTINGS_ROWS = [
  ["ShiftBoard settings · הגדרות"],
  [],
  ["Full name · שם מלא", "full_name"],
  ["Company email · מייל החברה", "company_email"],
  [],
  ["Warehouse, per hour (₪) · מחסן, לשעה", "rate_warehouse"],
  ["Event, per day (₪) · אירוע, ליום", "rate_event"],
  ["Event extra hour (₪) · שעה נוספת באירוע", "rate_extra"],
  ["Night at work (₪) · לינה", "rate_night"],
];

let sheetId = localStorage.getItem("sb_sheetId");
let settings = null; // { full_name, company_email, rate_* } as last read from or saved to the sheet

const hasDrive = () => grantedScopes.split(" ").includes(DRIVE_SCOPE);

function forgetSheet() {
  sheetId = null;
  settings = null;
  localStorage.removeItem("sb_sheetId");
}

function jsonRequest(url, method, body) {
  return apiFetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
}

// Finds this user's pay sheet by a hidden Drive property (so every device finds the same one), or creates it
function ensureSheet() {
  if (sheetId) return Promise.resolve(sheetId);
  const q = encodeURIComponent("appProperties has { key='shiftboard' and value='pay-sheet' } and trashed=false");
  return apiFetch(DRIVE_FILES + "?q=" + q + "&fields=files(id)")
    .then((r) => r.json())
    .then((data) => (data.files && data.files.length ? data.files[0].id : createSheet()))
    .then((id) => {
      sheetId = id;
      localStorage.setItem("sb_sheetId", id);
      return id;
    });
}

function createSheet() {
  return jsonRequest(SHEETS_API, "POST", { properties: { title: "ShiftBoard pay" }, sheets: [{ properties: { title: "Settings" } }] })
    .then((sheet) =>
      jsonRequest(DRIVE_FILES + "/" + sheet.spreadsheetId, "PATCH", { appProperties: { shiftboard: "pay-sheet" } })
        .then(() => writeSettingsTab(sheet.spreadsheetId, {}))
        .then(() => sheet.spreadsheetId)
    );
}

function writeSettingsTab(id, values) {
  const rows = SETTINGS_ROWS.map(([label, key]) => (key ? [label, values[key] == null ? "" : values[key], key] : label ? [label] : []));
  return jsonRequest(SHEETS_API + "/" + id + "/values/Settings!A1:C" + rows.length + "?valueInputOption=RAW", "PUT", { values: rows });
}

function readSettingsTab() {
  return ensureSheet()
    .then((id) => apiFetch(SHEETS_API + "/" + id + "/values/Settings!A1:C50"))
    .then((r) => r.json());
}

// Reads the Settings tab by key. A sheet or tab deleted by hand is recreated instead of failing.
function loadSettings() {
  return readSettingsTab()
    .catch((err) => {
      if (/not found/i.test(err.message)) {
        forgetSheet();
        return readSettingsTab();
      }
      if (/parse range/i.test(err.message)) {
        return jsonRequest(SHEETS_API + "/" + sheetId + ":batchUpdate", "POST", { requests: [{ addSheet: { properties: { title: "Settings" } } }] })
          .then(() => writeSettingsTab(sheetId, {}))
          .then(readSettingsTab);
      }
      throw err;
    })
    .then((data) => {
      settings = {};
      (data.values || []).forEach((row) => {
        if (row[2]) settings[row[2]] = row[1] == null ? "" : String(row[1]).trim();
      });
      return settings;
    });
}

function saveSettings(values) {
  return ensureSheet()
    .then((id) => writeSettingsTab(id, values))
    .then(() => (settings = Object.assign({}, values)));
}

// Hand-typed rates like "₪ 55" or "55.5" still read as numbers
function ratesFrom(s) {
  const n = (v) => Number(String(v || "").replace(/[^\d.]/g, "")) || 0;
  return { warehouse: n(s.rate_warehouse), event: n(s.rate_event), extra: n(s.rate_extra), night: n(s.rate_night) };
}

// ---------- Pay ----------
// Rates are per person, in ₪: { warehouse: per hour, event: per Event day, extra: per extra Event hour, night: per night }

const EXTRA_AFTER_HOURS = 12; // an Event day covers 12 hours; from the 13th hour on, hours are extra

const round2 = (n) => Math.round(n * 100) / 100;

function startMs(event) {
  return new Date(event.start.dateTime || event.start.date + "T00:00").getTime();
}

// One shift's pay. A shift without times can't be fully worked out yet (missingTimes): Warehouse pays
// nothing until it has hours, and an Event shows only its fixed amount.
function shiftPay(type, event, rates) {
  const props = privateProps(event);
  const hours = hoursOf(event);
  const extraHours = type === "Event" && hours !== null ? Math.max(0, hours - EXTRA_AFTER_HOURS) : 0;
  let pay = 0;
  if (type === "Warehouse") pay = (hours || 0) * rates.warehouse;
  else if (type === "Event") pay = rates.event + extraHours * rates.extra;
  else pay = Number(props.amount) || 0;
  pay = round2(pay);
  const night = type === "Event" && props.slept === "1" ? rates.night : 0;
  const expenses = round2(expensesOf(event).reduce((sum, x) => sum + Number(x.amount), 0));
  return { hours, extraHours, pay, night, expenses, total: round2(pay + night + expenses), missingTimes: hours === null };
}

// Every shift that starts in the given month (0-based), in start order, with its pay
function monthLines(items, year, month, rates) {
  const prefix = year + "-" + String(month + 1).padStart(2, "0") + "-";
  return items
    .map((event) => ({ event, type: workTypeOf(event), ds: eventDate(event) }))
    .filter((line) => line.type && line.ds && line.ds.startsWith(prefix))
    .sort((a, b) => startMs(a.event) - startMs(b.event))
    .map((line) => Object.assign(line, shiftPay(line.type, line.event, rates)));
}

function monthTotals(lines) {
  const totals = {
    warehouse: { count: 0, hours: 0, pay: 0 },
    event: { count: 0, extraHours: 0, pay: 0 },
    other: { count: 0, pay: 0 },
    nights: { count: 0, pay: 0 },
    expenses: 0,
    total: 0,
    missingTimes: 0,
  };
  lines.forEach((line) => {
    const group = totals[line.type.toLowerCase()];
    group.count++;
    group.pay = round2(group.pay + line.pay);
    if (line.type === "Warehouse") group.hours += line.hours || 0;
    if (line.type === "Event") group.extraHours += line.extraHours;
    if (line.night) {
      totals.nights.count++;
      totals.nights.pay = round2(totals.nights.pay + line.night);
    }
    totals.expenses = round2(totals.expenses + line.expenses);
    totals.total = round2(totals.total + line.total);
    if (line.missingTimes) totals.missingTimes++;
  });
  return totals;
}

// ---------- The month's table (written to the pay sheet, and later the PDF) ----------

const TYPE_LABELS = { Event: "Event · אירוע", Warehouse: "Warehouse · מחסן", Other: "Other · אחר" };
const EXPENSE_LABELS = { Travel: "Travel · נסיעות", Food: "Food · אוכל", Hotel: "Hotel · מלון", Other: "Other · אחר" };
const DAY_LABELS = ["Sun · א׳", "Mon · ב׳", "Tue · ג׳", "Wed · ד׳", "Thu · ה׳", "Fri · ו׳", "Sat · ש׳"];
const TABLE_HEADINGS = [
  "Date · תאריך", "Day · יום", "Type · סוג", "Start · התחלה", "End · סיום", "Hours · שעות",
  "Extra hours · שעות נוספות", "Pay · שכר", "Night · לינה", "Expenses · הוצאות", "Total · סה״כ", "Details · פירוט",
];
const TABLE_HEAD_ROWS = 6; // title, month, name, rates, blank, headings

// A small header, one row per shift, then the totals. Plain values rather than formulas, so the sheet always
// matches the app; money and hours stay numbers so Sheets can format and add them.
function monthTableRows(monthDate, lines, totals, rates, s) {
  const pad = (n) => String(n).padStart(2, "0");
  const rows = [
    ["Shift report · דוח משמרות"],
    ["Month · חודש", monthDate.toLocaleDateString("en-US", { month: "long", year: "numeric" })],
    ["Name · שם", s.full_name || ""],
    ["Rates · תעריפים", "Warehouse ₪" + rates.warehouse + "/h · Event ₪" + rates.event + " · Extra ₪" + rates.extra + "/h · Night ₪" + rates.night],
    [],
    TABLE_HEADINGS,
  ];
  lines.forEach((line) => {
    const day = new Date(line.ds + "T00:00");
    const [startText, endText] = line.missingTimes ? ["", ""] : timeRange(line.event).split("–");
    const details = [];
    if (line.type === OTHER && privateProps(line.event).note) details.push(privateProps(line.event).note);
    expensesOf(line.event).forEach((x) => details.push((EXPENSE_LABELS[x.type] || x.type) + " ₪" + x.amount));
    if (line.missingTimes) details.push("No times yet · אין שעות");
    rows.push([
      pad(day.getDate()) + "/" + pad(day.getMonth() + 1) + "/" + day.getFullYear(),
      DAY_LABELS[day.getDay()],
      TYPE_LABELS[line.type],
      startText,
      endText,
      line.hours === null ? "" : round2(line.hours),
      line.extraHours ? round2(line.extraHours) : "",
      line.pay,
      line.night || "",
      line.expenses || "",
      line.total,
      details.join(", "),
    ]);
  });
  // Summary amounts sit in the Total column
  const summary = (label, detail, amount) => [label, detail, "", "", "", "", "", "", "", "", amount];
  rows.push([], ["Summary · סיכום"]);
  if (totals.warehouse.count) rows.push(summary("Warehouse · מחסן", totals.warehouse.count + " shifts · " + round2(totals.warehouse.hours) + " h", totals.warehouse.pay));
  if (totals.event.count) rows.push(summary("Event · אירוע", totals.event.count + " days · " + round2(totals.event.extraHours) + " extra h", totals.event.pay));
  if (totals.nights.count) rows.push(summary("Nights · לינות", totals.nights.count + " nights", totals.nights.pay));
  if (totals.other.count) rows.push(summary("Other · אחר", totals.other.count + " jobs", totals.other.pay));
  if (totals.expenses) rows.push(summary("Expenses · הוצאות", "", totals.expenses));
  rows.push(summary("Total to pay · סה״כ לתשלום", "", totals.total));
  return rows;
}

// ---------- Writing the month's tab into the pay sheet ----------

const TABLE_KEY = "shiftboard_table"; // hidden per-tab note of what the app last wrote, to spot hand edits
const COLUMN_WIDTHS = [100, 90, 150, 70, 100, 70, 120, 100, 90, 100, 110, 300];
let payData = { lines: [], totals: null }; // exactly what the Pay view shows, so the sheet gets the same

const jsonGet = (url) => apiFetch(url).then((r) => r.json());
const monthTabTitle = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + " " + d.toLocaleDateString("en-US", { month: "long" });

// A fingerprint of a table's values; trailing empty cells and rows don't count (Sheets drops them)
function tableHash(rows) {
  const clean = rows.map((row) => {
    const cells = row.map((v) => (v == null ? "" : v));
    while (cells.length && cells[cells.length - 1] === "") cells.pop();
    return cells;
  });
  while (clean.length && !clean[clean.length - 1].length) clean.pop();
  const text = JSON.stringify(clean);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

// Writes the Pay view's month into its own tab ("2026-09 September"). If the tab was changed by hand since the
// app last wrote it, asks first. Resolves with the tab's id, or null when the user chose to keep their edits.
function writeMonthTab() {
  const title = monthTabTitle(payMonth);
  const quoted = encodeURIComponent("'" + title + "'");
  const rows = monthTableRows(payMonth, payData.lines, payData.totals || monthTotals([]), ratesFrom(settings), settings);
  let tabId;
  let note = null;
  return ensureSheet()
    .then((id) => jsonGet(SHEETS_API + "/" + id + "?fields=sheets(properties(sheetId,title),developerMetadata(metadataId,metadataKey,metadataValue))"))
    .then((meta) => {
      const tab = (meta.sheets || []).find((s) => s.properties.title === title);
      if (!tab) {
        return jsonRequest(SHEETS_API + "/" + sheetId + ":batchUpdate", "POST", { requests: [{ addSheet: { properties: { title } } }] }).then((res) => {
          tabId = res.replies[0].addSheet.properties.sheetId;
          return true;
        });
      }
      tabId = tab.properties.sheetId;
      note = (tab.developerMetadata || []).find((m) => m.metadataKey === TABLE_KEY) || null;
      return jsonGet(SHEETS_API + "/" + sheetId + "/values/" + quoted + "!A1:L500?valueRenderOption=UNFORMATTED_VALUE").then(
        (data) =>
          (note && note.metadataValue === tableHash(data.values || [])) ||
          confirm("The " + title.slice(8) + " tab in your pay sheet was changed by hand. Replace it with the app's version?")
      );
    })
    .then((go) => {
      if (!go) return null;
      const hash = tableHash(rows);
      const noteRequest = note
        ? { updateDeveloperMetadata: { dataFilters: [{ developerMetadataLookup: { metadataId: note.metadataId } }], developerMetadata: { metadataValue: hash }, fields: "metadataValue" } }
        : { createDeveloperMetadata: { developerMetadata: { metadataKey: TABLE_KEY, metadataValue: hash, location: { sheetId: tabId }, visibility: "DOCUMENT" } } };
      return jsonRequest(SHEETS_API + "/" + sheetId + "/values/" + quoted + ":clear", "POST", {})
        .then(() => jsonRequest(SHEETS_API + "/" + sheetId + "/values/" + quoted + "!A1?valueInputOption=RAW", "PUT", { values: rows }))
        .then(() => jsonRequest(SHEETS_API + "/" + sheetId + ":batchUpdate", "POST", { requests: tableFormatRequests(tabId, rows.length).concat(noteRequest) }))
        .then(() => tabId);
    });
}

function tableFormatRequests(tabId, rowCount) {
  const range = (r1, r2, c1, c2) => ({ sheetId: tabId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 });
  const format = (rng, userEnteredFormat, fields) => ({ repeatCell: { range: rng, cell: { userEnteredFormat }, fields: "userEnteredFormat(" + fields + ")" } });
  const head = TABLE_HEAD_ROWS;
  return [
    { repeatCell: { range: range(0, 500, 0, 12), cell: {}, fields: "userEnteredFormat" } }, // drop formats a longer table left behind
    format(range(0, 1, 0, 1), { textFormat: { bold: true, fontSize: 14 } }, "textFormat"),
    format(range(1, 4, 0, 1), { textFormat: { bold: true } }, "textFormat"),
    format(range(head - 1, head, 0, 12), { textFormat: { bold: true }, backgroundColor: { red: 0.92, green: 0.93, blue: 0.95 } }, "textFormat,backgroundColor"),
    format(range(head, rowCount, 5, 7), { numberFormat: { type: "NUMBER", pattern: "0.00" } }, "numberFormat"),
    format(range(head, rowCount, 7, 11), { numberFormat: { type: "CURRENCY", pattern: "₪#,##0.00" } }, "numberFormat"),
    format(range(rowCount - 1, rowCount, 0, 12), { textFormat: { bold: true } }, "textFormat"),
    { updateSheetProperties: { properties: { sheetId: tabId, gridProperties: { frozenRowCount: head } }, fields: "gridProperties.frozenRowCount" } },
  ].concat(
    COLUMN_WIDTHS.map((px, i) => ({
      updateDimensionProperties: { range: { sheetId: tabId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: "pixelSize" },
    }))
  );
}

function updateSheet() {
  const btn = el("writeSheetBtn");
  btn.disabled = true;
  btn.textContent = "Updating…";
  writeMonthTab()
    .then((tabId) => {
      if (tabId === null) return;
      const link = el("openSheetLink");
      link.href = "https://docs.google.com/spreadsheets/d/" + sheetId + "/edit#gid=" + tabId;
      link.hidden = false;
      showToast(monthTabTitle(payMonth).slice(8) + " is up to date in your pay sheet");
    })
    .catch((err) => showApiError("Couldn't update your pay sheet", err))
    .finally(() => {
      btn.disabled = false;
      btn.textContent = "Update my sheet";
    });
}

// ---------- Pay view ----------

const SETTING_KEYS = ["full_name", "company_email", "rate_warehouse", "rate_event", "rate_extra", "rate_night"];
let payMonth = null; // the 1st of the month shown on the Pay view
let pendingView = null; // the view to return to after signing in again (e.g. to grant the Drive permission)

function showView(view) {
  const pay = view === "pay";
  el("tabShifts").setAttribute("aria-pressed", String(!pay));
  el("tabPay").setAttribute("aria-pressed", String(pay));
  el("workspace").hidden = pay;
  el("saveBar").hidden = pay;
  el("payView").hidden = !pay;
  document.body.classList.toggle("is-pay", pay);
  if (pay) openPayView();
}

function openPayView() {
  const connected = hasDrive();
  el("driveConnect").hidden = connected;
  el("payContent").hidden = !connected;
  if (!connected) return;
  if (!payMonth) {
    const now = new Date();
    payMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  }
  el("payStatus").textContent = "Opening your pay sheet…";
  (settings ? Promise.resolve(settings) : loadSettings())
    .then((s) => {
      fillSettingsForm(s);
      renderPayMonth();
    })
    .catch((err) => {
      el("payStatus").textContent = "";
      showApiError("Couldn't open your pay sheet", err);
    });
}

function fillSettingsForm(s) {
  const f = el("settingsForm").elements;
  SETTING_KEYS.forEach((key) => (f[key].value = s[key] || ""));
  const r = ratesFrom(s);
  el("settingsBox").open = !(s.full_name && r.warehouse && r.event); // stays open until the basics are in
}

function submitSettings(e) {
  e.preventDefault();
  const form = el("settingsForm");
  const values = {};
  SETTING_KEYS.forEach((key) => (values[key] = form.elements[key].value.trim()));
  const error = form.querySelector(".form-error");
  const fail = (msg) => {
    error.textContent = msg;
    error.hidden = false;
  };
  if (!values.full_name) return fail("Enter your full name as the company knows it.");
  if (values.company_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.company_email)) return fail("That email address doesn't look right.");
  error.hidden = true;
  const btn = form.querySelector('[type="submit"]');
  btn.disabled = true;
  saveSettings(values)
    .then(() => {
      showToast("Saved to your pay sheet");
      el("settingsBox").open = false;
      renderPayMonth();
    })
    .catch((err) => showApiError("Couldn't save your details", err))
    .finally(() => (btn.disabled = false));
}

function changePayMonth(delta) {
  payMonth = new Date(payMonth.getFullYear(), payMonth.getMonth() + delta, 1);
  renderPayMonth();
}

let payLoadSeq = 0; // a slow response for a month the user already moved away from is ignored

function renderPayMonth() {
  if (!payMonth || !settings) return;
  const seq = ++payLoadSeq;
  const year = payMonth.getFullYear();
  const month = payMonth.getMonth();
  el("monthTitle").textContent = payMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  el("payStatus").textContent = "Loading this month's shifts…";
  el("writeSheetBtn").disabled = true; // until this month's shifts are in, so the sheet can't get another month's
  el("openSheetLink").hidden = true;
  // Up to a day into next month, so a shift starting late on the last day is included
  fetchEvents(new Date(year, month, 1), new Date(year, month + 1, 2))
    .then((items) => {
      if (seq !== payLoadSeq) return;
      const rates = ratesFrom(settings);
      const lines = monthLines(items, year, month, rates);
      const totals = monthTotals(lines);
      payData = { lines, totals };
      el("writeSheetBtn").disabled = false;
      renderPayStatus(lines, totals, rates);
      renderPayTotals(lines.length ? totals : null);
      renderPayLines(lines);
    })
    .catch((err) => showApiError("Couldn't load this month", err));
}

function renderPayStatus(lines, totals, rates) {
  const status = el("payStatus");
  status.classList.toggle("needs-times", totals.missingTimes > 0);
  if (!rates.warehouse && !rates.event) status.textContent = "Add your rates below to see your pay.";
  else if (!lines.length) status.textContent = "No shifts this month.";
  else if (totals.missingTimes === 1) status.textContent = "1 shift has no times yet, so this total isn't final.";
  else if (totals.missingTimes) status.textContent = totals.missingTimes + " shifts have no times yet, so this total isn't final.";
  else status.textContent = "Every shift has its times.";
}

function renderPayTotals(totals) {
  const box = el("payTotals");
  box.innerHTML = "";
  if (!totals) return;
  const money = (n) => moneyFormat.format(n);
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many);
  const rows = [
    ["Warehouse", totals.warehouse.count, plural(totals.warehouse.count, "shift", "shifts") + " · " + formatHours(totals.warehouse.hours) + " · " + money(totals.warehouse.pay)],
    ["Event", totals.event.count, plural(totals.event.count, "day", "days") + (totals.event.extraHours ? " · " + formatHours(totals.event.extraHours) + " extra" : "") + " · " + money(totals.event.pay)],
    ["Nights", totals.nights.count, plural(totals.nights.count, "night", "nights") + " · " + money(totals.nights.pay)],
    ["Other", totals.other.count, plural(totals.other.count, "job", "jobs") + " · " + money(totals.other.pay)],
    ["Expenses", totals.expenses, money(totals.expenses)],
  ];
  box.innerHTML =
    '<p class="total-line"><span>Total to pay</span><strong>' + money(totals.total) + "</strong></p>" +
    '<dl class="total-breakdown">' +
    rows.filter((row) => row[1]).map((row) => "<div><dt>" + row[0] + "</dt><dd>" + row[2] + "</dd></div>").join("") +
    "</dl>";
}

function renderPayLines(lines) {
  const list = el("payLines");
  list.innerHTML = "";
  lines.forEach((line) => {
    const item = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pay-line type-" + line.type.toLowerCase();
    const parts = [
      ["pay-type", line.type],
      ["pay-when", lineWhen(line)],
      ["pay-detail" + (line.missingTimes ? " needs-times" : ""), lineDetail(line)],
      ["pay-amount", line.missingTimes && line.type !== "Event" ? "–" : moneyFormat.format(line.total)],
    ];
    parts.forEach(([className, text]) => {
      const span = document.createElement("span");
      span.className = className;
      span.textContent = text; // descriptions are the user's own text, so never innerHTML
      btn.appendChild(span);
    });
    btn.addEventListener("click", () => {
      const panel = openPanel(new Date(line.ds + "T00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }));
      panel.appendChild(shiftForm(line.ds, line.type, line.event));
      panel.showModal();
    });
    item.appendChild(btn);
    list.appendChild(item);
  });
}

function lineWhen(line) {
  const day = new Date(line.ds + "T00:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  return line.missingTimes ? day : day + " · " + timeRange(line.event);
}

function lineDetail(line) {
  if (line.missingTimes) return "No times yet";
  const parts = [formatHours(line.hours)];
  if (line.extraHours) parts.push(formatHours(line.extraHours) + " extra");
  if (line.night) parts.push("night " + moneyFormat.format(line.night));
  if (line.expenses) parts.push("expenses " + moneyFormat.format(line.expenses));
  const note = privateProps(line.event).note;
  if (line.type === OTHER && note) parts.push(note);
  return parts.join(" · ");
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
