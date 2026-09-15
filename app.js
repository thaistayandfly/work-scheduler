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

// ---------- Language ----------
// Each person picks the app's language on their device: English or Hebrew, the phone's language until they do.
// The words live in i18n.js. A Hebrew page runs right to left.

function pickLanguage() {
  const saved = localStorage.getItem("sb_lang");
  if (UI_TEXT[saved]) return saved;
  return /^(he|iw)\b/i.test(navigator.language || "") ? "he" : "en";
}

const UI_LANG = pickLanguage();
const L = UI_TEXT[UI_LANG];
// Dates and money follow the app's language, never a phone set to the other one
const LOCALE = UI_LANG === "he" ? "he-IL" : /^en\b/i.test(navigator.language || "") ? navigator.language : "en-US";
const rangeFormat = new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric" });
const moneyFormat = new Intl.NumberFormat(LOCALE, { style: "currency", currency: "ILS" });

// index.html's words carry data-l (text), data-l-html (text with markup) or data-l-aria (a label): keys into UI_TEXT
function applyLanguage() {
  const root = document.documentElement;
  root.lang = UI_LANG;
  root.dir = UI_LANG === "he" ? "rtl" : "ltr";
  const text = (key) => key.split(".").reduce((o, k) => o[k], L);
  document.querySelectorAll("[data-l]").forEach((node) => (node.textContent = text(node.dataset.l)));
  document.querySelectorAll("[data-l-html]").forEach((node) => (node.innerHTML = text(node.dataset.lHtml)));
  document.querySelectorAll("[data-l-aria]").forEach((node) => node.setAttribute("aria-label", text(node.dataset.lAria)));
  // The switch names the other language, in that language
  const other = UI_LANG === "he" ? "en" : "he";
  el("langBtn").textContent = UI_TEXT[other].langName;
  el("langBtn").lang = other;
}
applyLanguage(); // before the first paint, so a Hebrew page never flashes English

// The page reloads in the other language. The session survives (it's in localStorage); unsaved taps would not.
function switchLanguage() {
  if (!confirmDiscard()) return;
  localStorage.setItem("sb_lang", UI_LANG === "he" ? "en" : "he");
  if (!el("payView").hidden) sessionStorage.setItem("sb_view", "pay");
  location.reload();
}

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
  el("langBtn").addEventListener("click", switchLanguage);
  el("toast").addEventListener("click", () => (el("toast").hidden = true));
  window.addEventListener("beforeunload", (e) => {
    if (isDirty()) {
      e.preventDefault();
      e.returnValue = true;
    }
  });

  // A language switch made on the Pay tab lands back on it
  if (sessionStorage.getItem("sb_view") === "pay") pendingView = "pay";
  sessionStorage.removeItem("sb_view");
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
    showToast(L.signInFailed + resp.error, true);
    return;
  }
  if (!google.accounts.oauth2.hasGrantedAllScopes(resp, CALENDAR_SCOPE)) {
    showToast(L.noCalendarAccess, true);
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
    showToast(L.sessionExpired, true);
    resetToSignedOut();
    return Promise.reject(new Error("token expired"));
  }
  options.headers = Object.assign({}, options.headers, {
    Authorization: "Bearer " + accessToken,
  });
  return fetch(url, options).then((r) => {
    if (r.status === 401) {
      showToast(L.sessionExpired, true);
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
        opt.dir = "auto"; // a calendar's name can be in either language, or an email address
        opt.textContent = cal.summary + (cal.primary ? L.mainCalendar : "");
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
    .catch((err) => showApiError(L.errLoadCalendars, err));
}

function createNewCalendar() {
  if (!confirmDiscard()) return;
  const name = prompt(L.newCalendarPrompt);
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
      showToast(L.calendarCreated(name));
      loadCalendars();
    })
    .catch((err) => showApiError(L.errCreateCalendar, err));
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

// "Monday, September 14", in the app's language
function longDay(ds) {
  return new Date(ds + "T00:00").toLocaleDateString(LOCALE, { weekday: "long", month: "long", day: "numeric" });
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
  return L.weekNames[diff] || "";
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

  // The header sticks while the week's days scroll under it, so "+ Other job" stays in reach
  const head = document.createElement("div");
  head.className = "week-head";
  const title = document.createElement("h2");
  title.className = "week-title";
  title.id = "week-" + key;
  const name = weekName(monday);
  const range = formatRange(monday, sunday);
  title.innerHTML = name ? name + ' <span class="week-dates">' + range + "</span>" : range;
  head.appendChild(title);
  const other = makeButton(L.otherJob, "btn-text week-other", () => {
    const days = weekDates(monday);
    const today = dateStr(new Date());
    openOtherJob(days.includes(today) ? today : days[0]);
  });
  other.setAttribute("aria-label", L.addOtherInWeek(range));
  head.appendChild(other);
  section.appendChild(head);

  const error = document.createElement("p");
  error.className = "week-error";
  error.hidden = true;
  error.textContent = L.weekLoadFailed;
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn-text";
  retry.textContent = L.tryAgain;
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

  const longDate = longDay(ds);
  const label = document.createElement("button");
  label.type = "button";
  label.className = "day-label";
  label.setAttribute("aria-label", L.dayAria(longDate, ds === today));
  label.addEventListener("click", () => openDayPanel(ds));
  label.innerHTML =
    '<span class="dow">' +
    L.days[d.getDay()] +
    '</span><span class="dnum">' +
    d.getDate() +
    "</span>" +
    (ds === today ? '<span class="sr-only">' + L.today + "</span>" : "");
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
    btn.setAttribute("aria-label", L.types[type] + ", " + longDate);
    btn.innerHTML = '<span class="strip"></span><span class="tape-label">' + L.types[type] + "</span>";
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
  const shown = savedShifts(ds).filter(({ event }) => isTimed(event) || ds <= dateStr(new Date()));
  dayMeta[ds].hidden = shown.length === 0;
  dayMeta[ds].classList.toggle("needs-times", shown.some(({ event }) => !isTimed(event)));
  dayMeta[ds].textContent = shown.map(({ type, event }) => shiftSummary(type, event)).join("\n");
}

function savedShifts(ds) {
  const day = daysState[ds];
  const list = [];
  WORK_TYPES.forEach((type) => day[type].events.forEach((event) => list.push({ type, event })));
  day.others.forEach((event) => list.push({ type: OTHER, event }));
  return list;
}

const clock = (d) => String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");

// How many days after its start date a timed shift ended (1 for a night shift)
function daysLater(event) {
  const start = new Date(event.start.dateTime);
  const end = new Date(event.end.dateTime);
  return Math.round((new Date(dateStr(end) + "T00:00") - new Date(dateStr(start) + "T00:00")) / 864e5);
}

// "06:00–04:00 (+1)": the (+n) says how many days later the shift ended
function timeRange(event) {
  const later = daysLater(event);
  return clock(new Date(event.start.dateTime)) + "–" + clock(new Date(event.end.dateTime)) + (later > 0 ? " " + L.later(later) : "");
}

function shiftSummary(type, event) {
  const name = L.types[type];
  if (!isTimed(event)) return L.addTimes(name);
  let text = name + " " + timeRange(event);
  const props = privateProps(event);
  if (type === OTHER) text += ", " + moneyFormat.format(Number(props.amount) || 0);
  if (props.slept === "1") text += L.night;
  const spent = expensesOf(event).reduce((sum, x) => sum + Number(x.amount), 0);
  if (spent) text += L.spent(moneyFormat.format(spent));
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
      showApiError(L.errLoadShifts, err);
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
  head.append(title, makeButton(L.close, "btn-text", () => panel.close()));
  panel.appendChild(head);
  return panel;
}

function openDayPanel(ds) {
  const panel = openPanel(longDay(ds));
  localStorage.setItem("sb_hintSeen", "1"); // they found the date button, so the hint has done its job
  el("boardHint").hidden = true;

  const shifts = savedShifts(ds);
  shifts.forEach(({ type, event }) => panel.appendChild(shiftForm(ds, type, event)));
  if (shifts.length) {
    const addOther = makeButton(L.addOther, "btn-quiet add-other", () => addOther.replaceWith(shiftForm(ds, OTHER, null)));
    panel.appendChild(addOther);
  } else {
    // Nothing saved that day: the only thing to add here is an Other job, so its form is already open
    const note = document.createElement("p");
    note.className = "panel-note";
    note.textContent = L.emptyDay;
    panel.append(note, shiftForm(ds, OTHER, null));
  }
  panel.showModal();
}

// "+ Other job" in a week's header: the job's form, dated today or the week's first day (the date can be changed)
function openOtherJob(ds) {
  const panel = openPanel(L.addOther);
  panel.appendChild(shiftForm(ds, OTHER, null));
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
  return L.hours(Math.floor(minutes / 60), String(minutes % 60).padStart(2, "0"));
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
    "<h3>" + L.types[type] + "</h3>" +
    '<div class="when"><span class="when-label">' + L.start + '</span><input name="startDate" type="date" aria-label="' + L.startDate +
    '"><input name="startTime" type="time" aria-label="' + L.startTime + '"></div>' +
    '<div class="when"><span class="when-label">' + L.end + '</span><input name="endDate" type="date" aria-label="' + L.endDate +
    '"><input name="endTime" type="time" aria-label="' + L.endTime + '"></div>' +
    '<p class="duration" aria-live="polite"></p>' +
    (type === OTHER
      ? '<label class="field">' + L.amountPaid + '<input name="amount" type="number" min="0" step="0.01" inputmode="decimal"></label>' +
        '<label class="field"><span>' + L.whatWasIt + ' <span class="optional">' + L.optional + '</span></span><input name="note" type="text" maxlength="120"></label>'
      : "") +
    (type === "Event" ? '<label class="check"><input name="slept" type="checkbox"> ' + L.slept + "</label>" : "") +
    '<fieldset class="expenses"><legend>' + L.expenses + '</legend><div class="expense-list"></div></fieldset>' +
    '<p class="form-error" role="alert" hidden></p>' +
    '<div class="form-actions"><button type="submit" class="btn-primary">' + L.saveType(type) + "</button></div>";

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
    makeButton(L.addExpense, "btn-text", () => list.appendChild(expenseRow({ type: "Travel", amount: "" })))
  );

  const showDuration = () => {
    const hours = (new Date(f.endDate.value + "T" + f.endTime.value) - new Date(f.startDate.value + "T" + f.startTime.value)) / 3600000;
    form.querySelector(".duration").textContent =
      hours > 0 ? formatHours(hours) + (type === "Event" && hours > 12 ? L.ofWhichExtra(formatHours(hours - 12)) : "") : "";
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
  // Moving the start to another day moves the end with it, keeping the shift's length
  let shownStart = f.startDate.value;
  f.startDate.addEventListener("change", () => {
    const moved = Math.round((new Date(f.startDate.value + "T00:00") - new Date(shownStart + "T00:00")) / 864e5);
    if (moved && f.endDate.value) {
      const end = new Date(f.endDate.value + "T00:00");
      end.setDate(end.getDate() + moved);
      f.endDate.value = dateStr(end);
    }
    if (f.startDate.value) shownStart = f.startDate.value;
    rollEnd();
  });
  [f.startTime, f.endTime].forEach((input) => input.addEventListener("change", rollEnd));
  f.endDate.addEventListener("change", showDuration);
  showDuration();

  if (event && type === OTHER) {
    form.querySelector(".form-actions").prepend(makeButton(L.removeJob, "btn-text", () => removeOtherJob(event)));
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
  select.setAttribute("aria-label", L.expenseType);
  EXPENSE_TYPES.forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = L.expenseTypes[t];
    select.appendChild(opt);
  });
  select.value = EXPENSE_TYPES.includes(x.type) ? x.type : "Other";
  const amount = document.createElement("input");
  amount.type = "number";
  amount.min = "0";
  amount.step = "0.01";
  amount.inputMode = "decimal";
  amount.placeholder = "₪";
  amount.setAttribute("aria-label", L.expenseAmount);
  amount.value = x.amount;
  row.append(select, amount, makeButton(L.remove, "btn-text", () => row.remove()));
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
  if (!f.startTime.value || !f.endTime.value || isNaN(start) || isNaN(end)) return fail(L.errTimes);
  if (end <= start) return fail(L.errEndAfterStart);

  const expenses = [...form.querySelectorAll(".expense")]
    .map((row) => ({ type: row.querySelector("select").value, amount: Number(row.querySelector("input").value) }))
    .filter((x) => x.amount > 0);
  const extras = { expenses: JSON.stringify(expenses) };
  if (type === "Event") extras.slept = f.slept.checked ? "1" : "0";
  let summary;
  if (type === OTHER) {
    const amount = Number(f.amount.value);
    if (!(amount > 0)) return fail(L.errAmount);
    extras.amount = String(amount);
    extras.note = f.note.value.trim();
    summary = extras.note ? OTHER + " – " + extras.note : OTHER;
  }

  const btn = form.querySelector('[type="submit"]');
  btn.disabled = true;
  btn.textContent = L.saving;
  saveShiftEvent(event && event.id, { type, start, end, extras, summary })
    .then(() => {
      // In the missing-times list the other shifts stay open; everywhere else the panel is done
      const panel = el("dayPanel");
      form.remove();
      if (!form.dataset.keepOpen || !panel.querySelector("form")) panel.close();
      showToast(L.typeSaved(type));
      refreshAfterShiftChange();
    })
    .catch((err) => {
      btn.disabled = false;
      btn.textContent = L.saveType(type);
      if (accessToken) fail(L.couldntSave + err.message);
    });
}

function removeOtherJob(event) {
  deleteEvent(event.id)
    .then(() => {
      el("dayPanel").close();
      showToast(L.jobRemoved);
      refreshAfterShiftChange();
    })
    .catch((err) => showApiError(L.errRemoveJob, err));
}

function refreshAfterShiftChange() {
  loadWeeks(weeks);
  loadMissingTimes();
  if (!el("payView").hidden) renderPayMonth();
}

// ---------- The pay sheet: a Google Sheet in the user's own Drive ----------

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_FILES = "https://www.googleapis.com/drive/v3/files";
// Settings tab: A = label (in the report's language), B = value, C = key (a hidden column). Values are found by
// key, so rows moved by hand still work. "" is an empty row.
const SETTINGS_ROWS = ["title", "", "full_name", "company_email", "report_language", "", "rate_warehouse", "rate_event", "rate_extra", "rate_night"];

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

// The tab is in the report's language, with the language itself written by name ("עברית" / "English")
function writeSettingsTab(id, values) {
  const T = REPORT_TEXT[reportLanguage(values)];
  const rtl = T === REPORT_TEXT.he;
  const shown = Object.assign({}, values, { report_language: T.langName });
  const rows = SETTINGS_ROWS.map((key) =>
    key === "title" ? [T.settings.title] : key ? [T.settings[key], shown[key] == null ? "" : shown[key], key] : []
  );
  return jsonRequest(SHEETS_API + "/" + id + "/values/Settings!A1:C" + rows.length + "?valueInputOption=RAW", "PUT", { values: rows })
    .then(() => jsonGet(SHEETS_API + "/" + id + "?fields=sheets.properties(sheetId,title)"))
    .then((meta) => {
      const tab = (meta.sheets || []).find((s) => s.properties.title === "Settings");
      if (!tab) return;
      const tabId = tab.properties.sheetId;
      const column = (i, properties, fields) => ({
        updateDimensionProperties: { range: { sheetId: tabId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties, fields },
      });
      return jsonRequest(SHEETS_API + "/" + id + ":batchUpdate", "POST", {
        requests: [
          { updateSheetProperties: { properties: { sheetId: tabId, rightToLeft: rtl }, fields: "rightToLeft" } },
          {
            repeatCell: {
              range: { sheetId: tabId, startRowIndex: 0, endRowIndex: rows.length, startColumnIndex: 0, endColumnIndex: 3 },
              cell: { userEnteredFormat: { horizontalAlignment: rtl ? "RIGHT" : "LEFT", textDirection: rtl ? "RIGHT_TO_LEFT" : "LEFT_TO_RIGHT" } },
              fields: "userEnteredFormat(horizontalAlignment,textDirection)",
            },
          },
          {
            repeatCell: {
              range: { sheetId: tabId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
              cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 12 } } },
              fields: "userEnteredFormat.textFormat",
            },
          },
          column(0, { pixelSize: 240 }, "pixelSize"),
          column(1, { pixelSize: 240 }, "pixelSize"),
          column(2, { hiddenByUser: true }, "hiddenByUser"), // the keys, for the app only
        ],
      });
    });
}

// "en", "English" or "אנגלית" mean English; anything else, blank included, is Hebrew (the usual report)
function reportLanguage(s) {
  const v = String((s && s.report_language) || "").trim().toLowerCase();
  return v === "en" || v.startsWith("english") || v === "אנגלית" ? "en" : "he";
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
      settings.report_language = reportLanguage(settings);
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
  // Salary and expenses stay apart: expenses are paid back already taxed, the salary is taxed on payment
  return { hours, extraHours, pay, night, expenses, salary: round2(pay + night), missingTimes: hours === null };
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
    salary: 0,
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
    totals.salary = round2(totals.salary + line.salary);
    if (line.missingTimes) totals.missingTimes++;
  });
  return totals;
}

// ---------- The month's table (written to the pay sheet, and later the PDF) ----------

// The report (its words are REPORT_TEXT in i18n.js), top to bottom: title; name, month and year; the total to pay (gross salary) and, apart from it,
// the expenses reimbursement; a quiet hours summary; then one row per shift and a totals row. Plain values, not
// formulas, so the sheet always matches the app. `at` says where each part starts, for the formatting.
function monthTable(monthDate, lines, totals, s, lang) {
  const T = REPORT_TEXT[lang] || REPORT_TEXT.he;
  const pad = (n) => String(n).padStart(2, "0");
  const monthName = monthDate.toLocaleDateString(T.locale, { month: "long" });
  const year = String(monthDate.getFullYear());
  const at = {};
  const rows = [];
  at.title = rows.push([T.title + " — " + monthName + " " + year]) - 1;
  at.info = rows.push([T.name, "", "", s.full_name || ""]) - 1;
  rows.push([T.month, "", "", monthName]);
  rows.push([T.year, "", "", year]);
  rows.push([]);
  at.salary = rows.push([T.salary, "", "", totals.salary]) - 1;
  at.expenses = rows.push([T.expenses, "", "", totals.expenses]) - 1;
  at.note = totals.missingTimes ? rows.push([T.notFinal(totals.missingTimes)]) - 1 : -1;
  rows.push([]);
  at.hoursTitle = rows.push([T.hoursTitle]) - 1;
  if (totals.warehouse.count) rows.push([T.warehouseLine(totals.warehouse.count, round2(totals.warehouse.hours))]);
  if (totals.event.count) rows.push([T.eventLine(totals.event.count, round2(totals.event.extraHours))]);
  if (totals.nights.count) rows.push([T.nightsLine(totals.nights.count)]);
  if (totals.other.count) rows.push([T.otherLine(totals.other.count)]);
  at.hoursEnd = rows.length;
  rows.push([]);
  at.shiftsTitle = rows.push([T.shifts]) - 1;
  at.headings = rows.push(T.headings) - 1;
  at.lines = rows.length;
  lines.forEach((line) => {
    const day = new Date(line.ds + "T00:00");
    const later = line.missingTimes ? 0 : daysLater(line.event);
    const startText = line.missingTimes ? "" : clock(new Date(line.event.start.dateTime));
    const endText = line.missingTimes ? "" : clock(new Date(line.event.end.dateTime)) + (later > 0 ? " " + T.later(later) : "");
    const details = [];
    const note = privateProps(line.event).note;
    if (line.type === OTHER && note) details.push(note);
    expensesOf(line.event).forEach((x) => details.push((T.expenseTypes[x.type] || x.type) + " ₪" + x.amount));
    if (line.missingTimes) details.push(T.noTimes);
    rows.push([
      pad(day.getDate()) + "/" + pad(day.getMonth() + 1) + "/" + day.getFullYear(),
      T.days[day.getDay()],
      T.types[line.type],
      startText,
      endText,
      line.hours === null ? "" : round2(line.hours),
      line.extraHours ? round2(line.extraHours) : "",
      line.pay,
      line.night || "",
      line.expenses || "",
      details.join(", "),
    ]);
  });
  // A totals row under the shifts, so each column can be checked at a glance
  const sum = (key) => round2(lines.reduce((acc, line) => acc + (line[key] || 0), 0));
  at.sum = rows.push([T.total, "", "", "", "", sum("hours"), sum("extraHours"), sum("pay"), sum("night"), sum("expenses"), ""]) - 1;
  return { rows, at, lines, rtl: T === REPORT_TEXT.he };
}

// ---------- Writing the month's tab into the pay sheet ----------

const TABLE_KEY = "shiftboard_table"; // hidden per-tab note of what the app last wrote, to spot hand edits
// Wide enough for every value at 10pt; headings and Details wrap instead of being cut off
const COLUMN_WIDTHS = [100, 90, 130, 80, 100, 80, 110, 110, 100, 110, 320];
// Sheet colours (0–1 RGB), matching the app: ink bands, blue Event, orange Warehouse, neutral Other
const SHEET_COLORS = {
  ink: { red: 0.11, green: 0.14, blue: 0.19 },
  white: { red: 1, green: 1, blue: 1 },
  label: { red: 0.33, green: 0.37, blue: 0.44 },
  heading: { red: 0.89, green: 0.91, blue: 0.94 },
  band: { red: 0.96, green: 0.97, blue: 0.98 },
  line: { red: 0.82, green: 0.85, blue: 0.89 },
  missing: { red: 0.72, green: 0.15, blue: 0.12 },
  Event: { red: 0.85, green: 0.9, blue: 0.98 },
  Warehouse: { red: 0.99, green: 0.89, blue: 0.78 },
  Other: { red: 0.94, green: 0.92, blue: 0.84 },
};
let payData = { lines: [], totals: null }; // exactly what the Pay view shows, so the sheet gets the same

const jsonGet = (url) => apiFetch(url).then((r) => r.json());
// Tabs are named "2026-09" whatever the report's language; an earlier version named them "2026-09 September"
const monthTabTitle = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
const legacyTabTitle = (d) => monthTabTitle(d) + " " + d.toLocaleDateString("en-US", { month: "long" });

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

// Writes the Pay view's month into its own tab ("2026-09"), in the report language. If the tab was changed by hand
// since the app last wrote it, asks first. Resolves with the tab's id, or null when the user chose to keep their edits.
function writeMonthTab() {
  const title = monthTabTitle(payMonth);
  const quoted = encodeURIComponent("'" + title + "'");
  const table = monthTable(payMonth, payData.lines, payData.totals || monthTotals([]), settings, reportLanguage(settings));
  const rows = table.rows;
  let tabId;
  let note = null;
  return ensureSheet()
    .then((id) => jsonGet(SHEETS_API + "/" + id + "?fields=sheets(properties(sheetId,title),developerMetadata(metadataId,metadataKey,metadataValue))"))
    .then((meta) => {
      const tabs = meta.sheets || [];
      const tab = tabs.find((s) => s.properties.title === title) || tabs.find((s) => s.properties.title === legacyTabTitle(payMonth));
      if (!tab) {
        return jsonRequest(SHEETS_API + "/" + sheetId + ":batchUpdate", "POST", { requests: [{ addSheet: { properties: { title } } }] }).then((res) => {
          tabId = res.replies[0].addSheet.properties.sheetId;
          return true;
        });
      }
      tabId = tab.properties.sheetId;
      note = (tab.developerMetadata || []).find((m) => m.metadataKey === TABLE_KEY) || null;
      // An older "2026-09 September" tab is renamed, so the month never ends up with two tabs
      const renamed =
        tab.properties.title === title
          ? Promise.resolve()
          : jsonRequest(SHEETS_API + "/" + sheetId + ":batchUpdate", "POST", { requests: [{ updateSheetProperties: { properties: { sheetId: tabId, title }, fields: "title" } }] });
      return renamed
        .then(() => jsonGet(SHEETS_API + "/" + sheetId + "/values/" + quoted + "!A1:Z500?valueRenderOption=UNFORMATTED_VALUE"))
        .then(
          (data) =>
            (note && note.metadataValue === tableHash(data.values || [])) ||
            confirm(L.handEdited(title))
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
        .then(() => jsonRequest(SHEETS_API + "/" + sheetId + ":batchUpdate", "POST", { requests: tableFormatRequests(tabId, table).concat(noteRequest) }))
        .then(() => tabId);
    });
}

function tableFormatRequests(tabId, { rows, at, lines, rtl }) {
  const C = SHEET_COLORS;
  const W = COLUMN_WIDTHS.length; // columns A–K
  const range = (r1, r2, c1, c2) => ({ sheetId: tabId, startRowIndex: r1, endRowIndex: r2, startColumnIndex: c1, endColumnIndex: c2 });
  const cells = (rng, format, fields) => ({ repeatCell: { range: rng, cell: { userEnteredFormat: format }, fields: "userEnteredFormat(" + fields + ")" } });
  const merge = (r, c1, c2) => ({ mergeCells: { range: range(r, r + 1, c1, c2), mergeType: "MERGE_ALL" } });
  const font = (color, bold, size) => ({ foregroundColor: color, bold: !!bold, fontSize: size || 10 });
  const fill = (r, bg, fg, bold, size) => cells(range(r, r + 1, 0, W), { backgroundColor: bg, textFormat: font(fg, bold, size) }, "backgroundColor,textFormat");
  const width = (i, px) => ({ updateDimensionProperties: { range: { sheetId: tabId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: "pixelSize" } });
  const height = (r, px) => ({ updateDimensionProperties: { range: { sheetId: tabId, dimension: "ROWS", startIndex: r, endIndex: r + 1 }, properties: { pixelSize: px }, fields: "pixelSize" } });
  const thin = { style: "SOLID", color: C.line };
  const edge = { style: "SOLID_MEDIUM", color: C.ink };
  const money = { numberFormat: { type: "CURRENCY", pattern: "₪#,##0.00" } };
  // A right-to-left tab only mirrors the columns: Sheets still writes each cell left to right and aligns it left.
  // So every cell says both, like the English table mirrored: text at the start, numbers at the end.
  const start = rtl ? "RIGHT" : "LEFT";
  const end = rtl ? "LEFT" : "RIGHT";

  const req = [
    { unmergeCells: { range: range(0, 500, 0, 26) } }, // earlier versions of the tab leave merges and formats behind
    { repeatCell: { range: range(0, 500, 0, 26), cell: {}, fields: "userEnteredFormat" } },
    { updateSheetProperties: { properties: { sheetId: tabId, rightToLeft: !!rtl, gridProperties: { frozenRowCount: 0 } }, fields: "rightToLeft,gridProperties.frozenRowCount" } },
    cells(
      range(0, rows.length, 0, W),
      { verticalAlignment: "MIDDLE", horizontalAlignment: start, textDirection: rtl ? "RIGHT_TO_LEFT" : "LEFT_TO_RIGHT", textFormat: font(C.ink) },
      "verticalAlignment,horizontalAlignment,textDirection,textFormat"
    ),
    merge(at.title, 0, W),
    fill(at.title, C.ink, C.white, true, 15),
  ];
  // Name, month and year: a label across A:C, the value across the rest
  for (let r = at.info; r < at.info + 3; r++) {
    req.push(merge(r, 0, 3), merge(r, 3, W), cells(range(r, r + 1, 0, 3), { textFormat: font(C.label, true) }, "textFormat"));
  }
  // What to pay: the gross salary in an ink band, the expenses reimbursement on its own lighter band. The amounts
  // sit right after their labels like the name, month and year (Sheets would push numbers to the far edge).
  req.push(
    merge(at.salary, 0, 3),
    merge(at.salary, 3, W),
    fill(at.salary, C.ink, C.white, true, 13),
    merge(at.expenses, 0, 3),
    merge(at.expenses, 3, W),
    fill(at.expenses, C.heading, C.ink, true, 12),
    cells(range(at.salary, at.expenses + 1, 3, 4), Object.assign({ horizontalAlignment: start }, money), "horizontalAlignment,numberFormat")
  );
  if (at.note >= 0) req.push(merge(at.note, 0, W), cells(range(at.note, at.note + 1, 0, W), { textFormat: font(C.missing, true) }, "textFormat"));
  // The hours summary: small and grey, there when wanted
  for (let r = at.hoursTitle; r < at.hoursEnd; r++) {
    req.push(merge(r, 0, W), cells(range(r, r + 1, 0, W), { textFormat: font(C.label, r === at.hoursTitle, 9) }, "textFormat"));
  }
  // Shifts: an ink band, wrapped headings, striped rows with each type in its own colour, then the totals row
  req.push(
    merge(at.shiftsTitle, 0, W),
    fill(at.shiftsTitle, C.ink, C.white, true, 12),
    cells(range(at.headings, at.headings + 1, 0, W), { backgroundColor: C.heading, textFormat: font(C.ink, true), wrapStrategy: "WRAP", horizontalAlignment: "CENTER" },
      "backgroundColor,textFormat,wrapStrategy,horizontalAlignment")
  );
  lines.forEach((line, i) => {
    const r = at.lines + i;
    if (i % 2) req.push(cells(range(r, r + 1, 0, W), { backgroundColor: C.band }, "backgroundColor"));
    req.push(cells(range(r, r + 1, 2, 3), { backgroundColor: C[line.type], textFormat: font(C.ink, true) }, "backgroundColor,textFormat"));
    if (line.missingTimes) req.push(cells(range(r, r + 1, W - 1, W), { textFormat: font(C.missing, true) }, "textFormat"));
  });
  req.push(
    cells(range(at.lines, at.sum + 1, 5, 10), { horizontalAlignment: end }, "horizontalAlignment"),
    cells(range(at.lines, at.sum + 1, 5, 7), { numberFormat: { type: "NUMBER", pattern: "0.00" } }, "numberFormat"),
    cells(range(at.lines, at.sum + 1, 7, 10), money, "numberFormat"),
    cells(range(at.lines, at.sum + 1, W - 1, W), { wrapStrategy: "WRAP" }, "wrapStrategy"),
    fill(at.sum, C.heading, C.ink, true),
    { updateBorders: { range: range(at.headings, at.sum + 1, 0, W), top: edge, bottom: edge, left: edge, right: edge, innerHorizontal: thin, innerVertical: thin } }
  );
  COLUMN_WIDTHS.forEach((px, i) => req.push(width(i, px)));
  req.push(width(W, 100)); // the previous layout's 12th column, back to normal
  // Rows grow to fit wrapped text; the bands get a little extra room
  req.push(
    { autoResizeDimensions: { dimensions: { sheetId: tabId, dimension: "ROWS", startIndex: 0, endIndex: rows.length } } },
    height(at.title, 40),
    height(at.salary, 32),
    height(at.expenses, 28),
    height(at.shiftsTitle, 30)
  );
  return req;
}

function updateSheet() {
  const btn = el("writeSheetBtn");
  btn.disabled = true;
  btn.textContent = L.updating;
  writeMonthTab()
    .then((tabId) => {
      if (tabId === null) return;
      const link = el("openSheetLink");
      link.href = "https://docs.google.com/spreadsheets/d/" + sheetId + "/edit#gid=" + tabId;
      link.hidden = false;
      showToast(L.upToDate(payMonth.toLocaleDateString(LOCALE, { month: "long", year: "numeric" })));
    })
    .catch((err) => showApiError(L.errUpdateSheet, err))
    .finally(() => {
      btn.disabled = false;
      btn.textContent = L.updateSheet;
    });
}

// ---------- Pay view ----------

const SETTING_KEYS = ["full_name", "company_email", "report_language", "rate_warehouse", "rate_event", "rate_extra", "rate_night"];
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
  el("payStatus").textContent = L.openingSheet;
  (settings ? Promise.resolve(settings) : loadSettings())
    .then((s) => {
      fillSettingsForm(s);
      renderPayMonth();
    })
    .catch((err) => {
      el("payStatus").textContent = "";
      showApiError(L.errOpenSheet, err);
    });
}

function fillSettingsForm(s) {
  const f = el("settingsForm").elements;
  SETTING_KEYS.forEach((key) => (f[key].value = s[key] || ""));
  f.report_language.value = reportLanguage(s);
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
  if (!values.full_name) return fail(L.errFullName);
  if (values.company_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(values.company_email)) return fail(L.errEmail);
  error.hidden = true;
  const btn = form.querySelector('[type="submit"]');
  btn.disabled = true;
  saveSettings(values)
    .then(() => {
      showToast(L.savedToSheet);
      el("settingsBox").open = false;
      renderPayMonth();
    })
    .catch((err) => showApiError(L.errSaveDetails, err))
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
  el("monthTitle").textContent = payMonth.toLocaleDateString(LOCALE, { month: "long", year: "numeric" });
  el("payStatus").textContent = L.loadingMonth;
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
    .catch((err) => showApiError(L.errLoadMonth, err));
}

function renderPayStatus(lines, totals, rates) {
  const status = el("payStatus");
  status.classList.toggle("needs-times", totals.missingTimes > 0);
  if (!rates.warehouse && !rates.event) status.textContent = L.addRates;
  else if (!lines.length) status.textContent = L.noShiftsMonth;
  else if (totals.missingTimes) status.textContent = L.notFinal(totals.missingTimes);
  else status.textContent = L.allTimed;
}

function renderPayTotals(totals) {
  const box = el("payTotals");
  box.innerHTML = "";
  if (!totals) return;
  const money = (n) => moneyFormat.format(n);
  const { warehouse, event, nights, other } = totals;
  const rows = [
    [L.types.Warehouse, warehouse.count, L.countShifts(warehouse.count) + " · " + formatHours(warehouse.hours) + " · " + money(warehouse.pay)],
    [L.types.Event, event.count, L.countDays(event.count) + (event.extraHours ? " · " + L.extra(formatHours(event.extraHours)) : "") + " · " + money(event.pay)],
    [L.nights, nights.count, L.countNights(nights.count) + " · " + money(nights.pay)],
    [L.types.Other, other.count, L.countJobs(other.count) + " · " + money(other.pay)],
  ];
  // Salary first, the expenses reimbursement apart from it; the per-type breakdown stays quiet underneath
  box.innerHTML =
    '<p class="total-line"><span>' + L.totalToPay + " <small>" + L.grossSalary + "</small></span><strong>" + money(totals.salary) + "</strong></p>" +
    '<p class="total-line reimburse"><span>' + L.reimbursement + "</span><strong>" + money(totals.expenses) + "</strong></p>" +
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
      ["pay-type", L.types[line.type]],
      ["pay-when", lineWhen(line)],
      ["pay-detail" + (line.missingTimes ? " needs-times" : ""), lineDetail(line)],
      ["pay-amount", line.missingTimes && line.type !== "Event" ? "–" : moneyFormat.format(line.salary)],
    ];
    parts.forEach(([className, text]) => {
      const span = document.createElement("span");
      span.className = className;
      span.textContent = text; // descriptions are the user's own text, so never innerHTML
      btn.appendChild(span);
    });
    btn.addEventListener("click", () => {
      const panel = openPanel(longDay(line.ds));
      panel.appendChild(shiftForm(line.ds, line.type, line.event));
      panel.showModal();
    });
    item.appendChild(btn);
    list.appendChild(item);
  });
}

function lineWhen(line) {
  const day = new Date(line.ds + "T00:00").toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "short" });
  return line.missingTimes ? day : day + " · " + timeRange(line.event);
}

function lineDetail(line) {
  if (line.missingTimes) return L.noTimes;
  const parts = [formatHours(line.hours)];
  if (line.extraHours) parts.push(L.extra(formatHours(line.extraHours)));
  if (line.night) parts.push(L.nightPay(moneyFormat.format(line.night)));
  if (line.expenses) parts.push(L.expensesPay(moneyFormat.format(line.expenses)));
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
      btn.textContent = L.pastMissing(missingTimes.length);
    })
    .catch(() => {}); // the board already reports loading problems
}

function openMissingTimes() {
  const panel = openPanel(L.missingTitle);
  missingTimes.forEach(({ ds, type, event }) => {
    const form = shiftForm(ds, type, event);
    form.dataset.keepOpen = "1";
    form.querySelector("h3").textContent =
      L.types[type] + " · " + new Date(ds + "T00:00").toLocaleDateString(LOCALE, { weekday: "short", month: "short", day: "numeric" });
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
  return !isDirty() || confirm(L.discard);
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
  if (saving) status.textContent = L.savingCalendar;
  else if (dirty) status.textContent = [adds && L.toAdd(adds), removes && L.toRemove(removes)].filter(Boolean).join(" · ");
  else if (loading) status.textContent = L.loadingShifts;
  else status.textContent = L.noUnsaved;
  el("saveBtn").disabled = !dirty || saving;
  el("saveBtn").textContent = saving ? L.saving : L.saveToCalendar;
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
      showApiError(L.changesFailed(failures.length), failures[0].reason);
    } else {
      showToast(L.savedCalendar);
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
