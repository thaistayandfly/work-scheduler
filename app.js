const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
// Only the files this app creates (the pay sheet, the sent reports), nothing else in the user's Drive
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
// Asked for only when someone first sends a month: it can send mail as them, never read their mailbox
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";
// "email" lets us show who's signed in and pass it as login_hint when the token needs renewing
const SCOPES = CALENDAR_SCOPE + " " + DRIVE_SCOPE + " email";
const APP_TAG = "shiftboard";
const WORK_TYPES = ["Event", "Warehouse"];
const OTHER = "Other"; // the rare one-off paid job, kept off the two main tapes
// "Hotel" was here once. It's gone from the picker but still translated, so an expense saved back then
// keeps its name on the report and in the row that opens it.
const EXPENSE_TYPES = ["Travel", "Fuel", "Food", "Other"];
const MIN_RESTORE_MS = 5 * 60 * 1000; // skip restoring a saved token that's about to expire
const WEEKS_PER_PAGE = 4; // weeks on the board at first, and how many "Show 4 more weeks" adds

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;
let grantedScopes = ""; // what the current token may do; older saved tokens predate the Drive permission
let pendingGrant = null; // { then, cancel } while Google is asked for one more permission mid-session

let calendars = [];
let selectedCalendarId = localStorage.getItem("sb_calendarId") || "primary";

// First days of the weeks on the board (Mondays, or Sundays in Hebrew), earliest first
let weeks = [];
// daysState[dateStr][type] = { active, originalActive, eventIds, events }
//   originalActive/eventIds/events: what the calendar had when that week loaded; active: what's selected now
// daysState[dateStr].others = that day's saved "Other" jobs (calendar events)
let daysState = {};
// Board elements, so one day or week can be updated without re-rendering the rest
let dayButtons = {}; // dateStr -> { Event: <button>, Warehouse: <button> }
let dayMeta = {}; // dateStr -> the line under a day's tapes showing its times and extras
let weekEls = {}; // the week's first day as a dateStr -> { section, error, loaded, failed }
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

// How this phone shows dates and times. Each starts out following the language — Hebrew reads 24-hour and
// day-first, English reads AM/PM and month-first — but the moment someone picks one, that choice is theirs
// and stays put however the app's language changes afterwards.
const clockPref = () => localStorage.getItem("sb_clock") || (UI_LANG === "he" ? "24" : "12");
const datePref = () => localStorage.getItem("sb_dateFormat") || (UI_LANG === "he" ? "dmy" : "mdy");
// Hebrew has no month-first habit to honour, so only English swaps between the two orders
const dateLocale = () => (UI_LANG === "he" ? "he-IL" : datePref() === "mdy" ? "en-US" : "en-GB");
const rangeFormats = {};
const rangeFormat = () => {
  const loc = dateLocale();
  rangeFormats[loc] = rangeFormats[loc] || new Intl.DateTimeFormat(loc, { month: "short", day: "numeric" });
  return rangeFormats[loc];
};
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
      // The popup was closed or blocked: whatever waited for a new permission gives up
      error_callback: () => {
        const grant = pendingGrant;
        pendingGrant = null;
        if (grant) grant.cancel();
      },
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
    updateSavingTo();
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
  el("settingsBtn").addEventListener("click", () => {
    if (el("settingsView").hidden) openSettings();
    else showView(viewBeforeSettings);
  });
  el("savingToBtn").addEventListener("click", openSettings);
  el("paySetupBtn").addEventListener("click", openSettings);
  el("settingsConnectBtn").addEventListener("click", () => {
    pendingView = "settings";
    signIn();
  });
  el("prevMonth").addEventListener("click", () => changePayMonth(-1));
  el("nextMonth").addEventListener("click", () => changePayMonth(1));
  el("settingsForm").addEventListener("submit", submitSettings);
  // The name's language follows the report language picked in the form, and says so the moment it's
  // picked: leaving it until Save would let someone switch language, walk away, and find out much later
  el("settingsForm").addEventListener("change", (e) => {
    if (e.target.name !== "report_language") return;
    el("fullNameLabel").textContent = L.fullNameIn(e.target.value);
    checkSettingsName();
  });
  el("settingsForm").addEventListener("input", (e) => {
    if (e.target.name === "full_name") checkSettingsName();
  });
  el("writeSheetBtn").addEventListener("click", updateSheet);
  el("sendBtn").addEventListener("click", openSendPanel);
  el("reopenBtn").addEventListener("click", reopenMonth);
  el("useRatesBtn").addEventListener("click", useCurrentRates);
  el("sendReminderBtn").addEventListener("click", () => {
    const now = new Date();
    payMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    showView("pay");
  });
  el("langBtn").addEventListener("click", switchLanguage);
  el("clockSelect").value = clockPref();
  el("clockSelect").addEventListener("change", (e) => {
    localStorage.setItem("sb_clock", e.target.value);
    refreshFormats();
  });
  el("dateSelect").value = datePref();
  el("dateSelect").addEventListener("change", (e) => {
    localStorage.setItem("sb_dateFormat", e.target.value);
    refreshFormats();
  });
  el("toast").addEventListener("click", () => (el("toast").hidden = true));
  window.addEventListener("beforeunload", (e) => {
    if (isDirty() || settingsDirty()) {
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

// Asks Google for one more permission (sending mail) without leaving the screen: then() runs once it's granted,
// cancel() if it isn't. Permissions given earlier stay; Google adds to them.
function requestScope(scope, then, cancel) {
  if (!tokenClient) return cancel();
  pendingGrant = { then, cancel };
  const opts = { prompt: "", scope: SCOPES + " " + scope };
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
  const grant = pendingGrant;
  pendingGrant = null;
  if (resp.error) {
    if (grant) grant.cancel();
    showToast(L.signInFailed + resp.error, true);
    return;
  }
  if (!google.accounts.oauth2.hasGrantedAllScopes(resp, CALENDAR_SCOPE)) {
    if (grant) grant.cancel();
    showToast(L.noCalendarAccess, true);
    return;
  }
  const expiresAt = Date.now() + (resp.expires_in || 3500) * 1000;
  localStorage.setItem("sb_token", JSON.stringify({ accessToken: resp.access_token, expiresAt, scope: resp.scope || "" }));
  if (grant && accessToken) {
    // One more permission, mid-session: the screen stays as it is and the waiting step carries on
    accessToken = resp.access_token;
    tokenExpiresAt = expiresAt;
    grantedScopes = resp.scope || "";
    grant.then();
    return;
  }
  if (grant) grant.cancel(); // the session had expired meanwhile: this is a fresh sign-in
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
  el("settingsBtn").hidden = !signedIn;
  el("savingToBtn").hidden = !signedIn;
  el("payView").hidden = true; // every sign-in starts on the Shifts view
  el("settingsView").hidden = true;
  el("tabShifts").setAttribute("aria-pressed", "true");
  el("tabPay").setAttribute("aria-pressed", "false");
  el("settingsBtn").setAttribute("aria-pressed", "false");
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

// fetch() rejects with a TypeError when the request never left the phone at all. Every browser words
// that differently ("Failed to fetch", "Load failed"), and none of them mean anything to a coworker.
function isNetworkError(err) {
  return (
    err instanceof TypeError ||
    /failed to fetch|networkerror|network request failed|load failed/i.test((err && err.message) || "")
  );
}

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

// ---------- Drafts: changes made with no signal ----------

const draftKey = () => "sb_drafts_" + (selectedCalendarId || "");
let draftsAre = { key: null, list: null }; // syncDay asks for these on every day, so they're read once
let draftsOffered = false;

function readDrafts() {
  const key = draftKey();
  if (draftsAre.key === key && draftsAre.list) return draftsAre.list;
  let list = [];
  try {
    const kept = JSON.parse(localStorage.getItem(key) || "[]");
    if (Array.isArray(kept)) list = kept;
  } catch (e) {
    list = []; // hand-edited or broken data mustn't stop the board
  }
  draftsAre = { key, list };
  return list;
}

function writeDrafts(list) {
  draftsAre = { key: draftKey(), list };
  try {
    localStorage.setItem(draftKey(), JSON.stringify(list));
  } catch (e) {
    // A full or blocked store can't be helped here; the change lives in this session at least
  }
}

const draftsFor = (ds) => readDrafts().filter((d) => d.ds === ds).length;

// Sends a change to the calendar, or — when the request never left the phone — keeps it as a draft to
// offer again once there's a signal. Anything else still fails exactly as it did before.
function sendOrDraft(url, options, about) {
  return apiFetch(url, options).catch((err) => {
    if (!isNetworkError(err) && !isOffline()) throw err;
    const list = readDrafts();
    list.push(Object.assign({ at: Date.now(), url, method: options.method, body: options.body || "" }, about));
    writeDrafts(list);
    showOffline(true);
    if (about && about.ds && daysState[about.ds]) syncDay(about.ds);
    // Shaped like a reply so the callers that read one carry on unchanged
    return { drafted: true, json: () => Promise.resolve({ drafted: true }) };
  });
}

// Back on a signal with changes still waiting: they're listed, one line each, and nothing reaches the
// calendar until someone says so. Anything that then fails stays waiting rather than disappearing.
function offerDrafts() {
  const list = readDrafts();
  if (!list.length) return;
  const panel = openPanel(L.draftsTitle);
  panel.appendChild(textEl("p", "panel-note", L.draftsIntro(list.length)));
  const what = document.createElement("ul");
  what.className = "draft-list";
  list.forEach((d) => what.appendChild(textEl("li", "", draftLabel(d))));
  panel.appendChild(what);
  const actions = document.createElement("div");
  actions.className = "form-actions";
  actions.append(
    makeButton(L.discardDrafts, "btn-text", () => {
      writeDrafts([]);
      panel.close();
      refreshAfterShiftChange();
    }),
    makeButton(L.saveDrafts, "btn-primary", () => {
      panel.close();
      sendDrafts();
    })
  );
  panel.appendChild(actions);
  panel.showModal();
}

function sendDrafts() {
  const list = readDrafts();
  if (!list.length) return;
  Promise.allSettled(
    list.map((d) =>
      apiFetch(d.url, {
        method: d.method,
        headers: d.body ? { "Content-Type": "application/json" } : {},
        body: d.body || undefined,
      })
    )
  ).then((results) => {
    const stuck = list.filter((d, i) => results[i].status === "rejected");
    writeDrafts(stuck);
    showToast(stuck.length ? L.draftsStuck(stuck.length) : L.draftsSaved(list.length), stuck.length > 0);
    refreshAfterShiftChange();
  });
}

function draftLabel(d) {
  const when = d.ds
    ? new Date(d.ds + "T00:00").toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" })
    : "";
  return when + " · " + (L.types[d.type] || d.type) + " · " + (L.draftKinds[d.kind] || d.kind);
}

function showOffline(on, at) {
  const banner = el("offlineBanner");
  if (!banner) return;
  banner.hidden = !on;
  // When there are kept shifts on screen, say how old they are rather than leaving people to guess
  if (on) banner.textContent = at ? L.offlineSince(shownDate(new Date(at)), clock(new Date(at))) : L.offlineBanner;
}

// Skips the toast when apiFetch just signed the user out — it already said "Session expired"
function showApiError(prefix, err) {
  console.error("ShiftBoard: " + prefix, err);
  if (!accessToken) return;
  // "Couldn't load your shifts: Failed to fetch" tells nobody anything. Name the real reason instead.
  if (isNetworkError(err) || isOffline()) {
    showOffline(true);
    showToast(L.offlineToast, true);
    return;
  }
  showToast(prefix + ": " + err.message, true);
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
      const usable = (data.items || []).filter((cal) => cal.accessRole === "owner" || cal.accessRole === "writer");
      keepCalendars(usable);
      showCalendars(usable);
    })
    .catch((err) => {
      // Opening the app with no signal used to stop right here, and because the board is only built
      // once the calendars are known, nothing was left to show the kept shifts in — an empty app.
      // The calendars seen last time are enough to build it and let those shifts back on screen.
      const kept = isNetworkError(err) || isOffline() ? keptCalendars() : null;
      if (kept && kept.length) {
        showCalendars(kept);
        showOffline(true);
        return;
      }
      showApiError(L.errLoadCalendars, err);
    });
}

const CALENDARS_KEY = "sb_calendars";

function keepCalendars(list) {
  try {
    localStorage.setItem(CALENDARS_KEY, JSON.stringify(list.map((c) => ({ id: c.id, summary: c.summary, primary: !!c.primary }))));
  } catch (e) {
    // A full or blocked store only costs us the offline list, not this load
  }
}

function keptCalendars() {
  try {
    const list = JSON.parse(localStorage.getItem(CALENDARS_KEY) || "null");
    return Array.isArray(list) ? list : null;
  } catch (e) {
    return null;
  }
}

function showCalendars(list) {
  calendars = list;
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
  updateSavingTo();
  if (calendars.length) resetBoard();
  else clearBoard();
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

function weekStart(date) {
  // Weeks start on Monday, or on Sunday in Hebrew, like Israeli calendars
  const d = new Date(date);
  const firstDay = UI_LANG === "he" ? 0 : 1;
  d.setDate(d.getDate() - ((d.getDay() - firstDay + 7) % 7));
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
  return new Date(ds + "T00:00").toLocaleDateString(dateLocale(), { weekday: "long", month: "long", day: "numeric" });
}

function weekDates(first) {
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(first);
    d.setDate(d.getDate() + i);
    dates.push(dateStr(d));
  }
  return dates;
}

// "This week" / "Next week" / "Last week" for nearby weeks; the rest go by their dates alone
function weekName(first) {
  const diff = Math.round((first - weekStart(new Date())) / (7 * 24 * 60 * 60 * 1000));
  return L.weekNames[diff] || "";
}

function formatRange(from, to) {
  const shape = rangeFormat();
  if (shape.formatRange) return shape.formatRange(from, to);
  return shape.format(from) + " – " + shape.format(to);
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
    let first;
    if (!weeks.length) {
      first = weekStart(new Date());
    } else {
      first = new Date(count > 0 ? weeks[weeks.length - 1] : weeks[0]);
      first.setDate(first.getDate() + (count > 0 ? 7 : -7));
    }
    const section = renderWeek(first);
    if (count > 0) {
      weeks.push(first);
      board.appendChild(section);
    } else {
      weeks.unshift(first);
      board.insertBefore(section, board.firstChild);
    }
    added.push(first);
  }
  loadWeeks(added);
}

function renderWeek(first) {
  const key = dateStr(first);
  const last = new Date(first);
  last.setDate(last.getDate() + 6);

  const section = document.createElement("section");
  section.className = "week";
  section.setAttribute("aria-labelledby", "week-" + key);

  // The header sticks while the week's days scroll under it, so "+ Other job" stays in reach
  const head = document.createElement("div");
  head.className = "week-head";
  const title = document.createElement("h2");
  title.className = "week-title";
  title.id = "week-" + key;
  const name = weekName(first);
  const range = formatRange(first, last);
  title.innerHTML = name ? name + ' <span class="week-dates">' + range + "</span>" : range;
  head.appendChild(title);
  const other = makeButton(L.otherJob, "btn-text week-other", () => {
    const days = weekDates(first);
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
  retry.addEventListener("click", () => loadWeeks([first]));
  error.appendChild(retry);
  section.appendChild(error);

  const list = document.createElement("ol");
  list.className = "days";
  for (let i = 0; i < 7; i++) {
    const d = new Date(first);
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
  const lines = shown.map(({ type, event }) => shiftSummary(type, event));
  const waiting = draftsFor(ds);
  if (waiting) lines.push(L.draftWaiting(waiting)); // a change made with no signal, not yet in the calendar
  dayMeta[ds].hidden = lines.length === 0;
  dayMeta[ds].classList.toggle("needs-times", shown.some(({ event }) => !isTimed(event)));
  dayMeta[ds].textContent = lines.join("\n");
}

function savedShifts(ds) {
  const day = daysState[ds];
  const list = [];
  WORK_TYPES.forEach((type) => day[type].events.forEach((event) => list.push({ type, event })));
  day.others.forEach((event) => list.push({ type: OTHER, event }));
  return list;
}

const pad2 = (n) => String(n).padStart(2, "0");

// The sheet and the PDF are payroll records going to the company, so their dates and times keep one
// fixed shape — dd/mm/yyyy and 24-hour — whatever any individual phone is set to show
const dmy = (d) => pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + "/" + d.getFullYear();
const clock24 = (d) => pad2(d.getHours()) + ":" + pad2(d.getMinutes());

// On screen, both follow this phone's preference
const shownDate = (d) =>
  datePref() === "mdy" ? pad2(d.getMonth() + 1) + "/" + pad2(d.getDate()) + "/" + d.getFullYear() : dmy(d);
const clock = (d) =>
  clockPref() === "12" ? d.toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit", hour12: true }) : clock24(d);

// Dates and times are formatted as they're drawn, so changing either only needs what's on screen redrawn
function refreshFormats() {
  Object.keys(daysState).forEach(syncDay);
  Object.keys(weekEls).forEach((key) => {
    const title = weekEls[key].section.querySelector(".week-title");
    if (!title) return;
    const first = new Date(key + "T00:00");
    const last = new Date(first);
    last.setDate(last.getDate() + 6);
    const name = weekName(first);
    const range = formatRange(first, last);
    title.innerHTML = name ? name + ' <span class="week-dates">' + range + "</span>" : range;
  });
  if (payData && payData.lines) {
    renderPayLines(payData.lines);
    renderSendState();
  }
}

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
      showWeeks(items, list);
      keepShifts(list, items); // so there's something to show next time there's no signal
      setWeeksBusy(list, false);
      showOffline(false);
      // Changes made offline in an earlier session: the "online" event never fired, so ask here instead
      if (!draftsOffered && readDrafts().length) {
        draftsOffered = true;
        offerDrafts();
      }
    })
    .catch((err) => {
      if (seq !== boardSeq) return;
      // No signal, but these weeks were read once before: show what was read, and say how old it is
      const kept = isNetworkError(err) || isOffline() ? keptShifts(list) : null;
      if (kept) {
        showWeeks(kept.items, list);
        setWeeksBusy(list, false);
        showOffline(true, kept.at);
        return;
      }
      setWeeksBusy(list, false, true);
      showApiError(L.errLoadShifts, err);
    });
}

// Rebuilds the given weeks from a set of calendar events, whether they came from Google just now or
// from what was kept on the phone. Toggles nobody has saved yet survive it — including ones that just
// failed to save — while events deleted elsewhere stop lingering as though they were still there.
function showWeeks(items, list) {
  const saved = {}; // "2026-09-14|Event" -> [calendar event, ...]; "Other" jobs are grouped the same way
  items.forEach((item) => {
    const ds = eventDate(item);
    const type = workTypeOf(item);
    if (ds && type) (saved[ds + "|" + type] = saved[ds + "|" + type] || []).push(item);
  });
  list.forEach((first) => {
    weekDates(first).forEach((ds) => {
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
}

// ---------- What the phone remembers ----------

// Only the parts of an event this app understands are kept, so nothing else from someone's calendar
// is written to their phone, and the store stays small
const slimEvent = (e) => ({
  id: e.id,
  summary: e.summary,
  start: e.start,
  end: e.end,
  extendedProperties: { private: privateProps(e) },
});

const shiftStoreKey = () => "sb_shifts_" + (selectedCalendarId || "");

function readShiftStore() {
  try {
    return JSON.parse(localStorage.getItem(shiftStoreKey()) || "null") || { at: 0, weeks: {} };
  } catch (e) {
    return { at: 0, weeks: {} }; // hand-edited or broken data mustn't stop the board
  }
}

function keepShifts(list, items) {
  const store = readShiftStore();
  store.at = Date.now();
  list.forEach((first) => {
    const days = weekDates(first);
    store.weeks[dateStr(first)] = items.filter((item) => days.indexOf(eventDate(item)) > -1).map(slimEvent);
  });
  try {
    localStorage.setItem(shiftStoreKey(), JSON.stringify(store));
  } catch (e) {
    // A full or blocked store is no reason to fail a load that otherwise worked
  }
}

// Whatever was kept for these weeks. A week never read stays empty rather than blocking the rest.
function keptShifts(list) {
  const store = readShiftStore();
  if (!store.at) return null;
  let items = [];
  let known = false;
  list.forEach((first) => {
    const week = store.weeks[dateStr(first)];
    if (!week) return;
    known = true;
    items = items.concat(week);
  });
  return known ? { at: store.at, items } : null;
}

function setWeeksBusy(list, busy, failed = false) {
  list.forEach((first) => {
    const week = weekEls[dateStr(first)];
    if (!week) return;
    if (!busy && !failed) week.loaded = true;
    week.failed = failed;
    week.section.setAttribute("aria-busy", String(busy));
    week.error.hidden = !failed || week.loaded;
    // Taps wait for a week's first load; later reloads keep unsaved toggles, so they stay tappable
    weekDates(first).forEach((ds) => WORK_TYPES.forEach((type) => (dayButtons[ds][type].disabled = !week.loaded)));
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

function textEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text; // often the person's own words, so never innerHTML
  return node;
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

// ---------- Date and time fields the app draws itself ----------

// The phone draws its own date and time boxes in its own language and ignores this app's settings, proven
// both by overriding the page's locale and by setting lang on the input. So the box a person reads and
// types into is ours, in the format they chose, and the phone's picker sits behind the button beside it
// for anyone who would rather tap than type. The value the rest of the form reads — an ISO date, a
// 24-hour time — lives in a hidden input under the same name as before.
const datePattern = () => (datePref() === "mdy" ? "mm/dd/yyyy" : "dd/mm/yyyy");
const timePattern = () => (clockPref() === "12" ? "h:mm am" : "HH:MM");

function parseShownDate(text) {
  let bits = String(text).match(/\d+/g);
  if (bits && bits.length === 1 && bits[0].length === 8) bits = [bits[0].slice(0, 2), bits[0].slice(2, 4), bits[0].slice(4)];
  if (!bits || bits.length < 3) return "";
  let [first, second, year] = bits.map(Number);
  if (datePref() === "mdy") [first, second] = [second, first];
  if (year < 100) year += 2000;
  const d = new Date(year, second - 1, first);
  // Rejects the 31st of February and its friends, which roll over into the next month
  if (isNaN(d) || d.getDate() !== first || d.getMonth() !== second - 1) return "";
  return dateStr(d);
}

// "1830", "18:30", "6.30 pm" all read the same way. A bare number is taken as a 24-hour time, so an
// evening shift can always be typed as 18:30 whatever the phone shows, and it's redrawn to prove it.
function parseShownTime(text) {
  const said = String(text).trim().toLowerCase().replace(/\s+/g, " ");
  const m = said.match(/^(\d{1,2})[:. ]?(\d{2})?\s*(a|p|am|pm)?$/);
  if (!m) return "";
  let hours = Number(m[1]);
  const mins = Number(m[2] || 0);
  if (m[3]) {
    if (hours > 12) return "";
    if (hours === 12) hours = 0;
    if (m[3][0] === "p") hours += 12;
  }
  return hours > 23 || mins > 59 ? "" : pad2(hours) + ":" + pad2(mins);
}

const PICK_ICONS = {
  date: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M7 2v2H5.5A2.5 2.5 0 0 0 3 6.5v13A2.5 2.5 0 0 0 5.5 22h13a2.5 2.5 0 0 0 2.5-2.5v-13A2.5 2.5 0 0 0 18.5 4H17V2h-2v2H9V2H7zm12 8v9.5a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5V10h14z"/></svg>',
  time: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm1-13h-2v6l5 3 1-1.7-4-2.3V7z"/></svg>',
};

function pickerField(kind, name, label, pickLabel) {
  const wrap = document.createElement("div");
  wrap.className = "pickable";
  const shown = document.createElement("input");
  shown.type = "text";
  shown.className = "shown";
  shown.inputMode = "numeric";
  shown.autocomplete = "off";
  shown.setAttribute("aria-label", label);
  const pick = document.createElement("span");
  pick.className = "pick";
  pick.innerHTML = PICK_ICONS[kind];
  // The phone's own control, invisible on top of the button: tapping it opens the picker with no
  // showPicker() call to be refused, and keyboard users still reach a real, labelled control
  const native = document.createElement("input");
  native.type = kind;
  native.className = "native";
  native.setAttribute("aria-label", pickLabel);
  pick.appendChild(native);
  const value = document.createElement("input");
  value.type = "hidden";
  value.name = name;
  wrap.append(shown, pick, value);

  wrap.repaint = () => {
    const v = value.value;
    native.value = v;
    shown.placeholder = kind === "date" ? datePattern() : timePattern();
    if (document.activeElement === shown) return; // never rewrite what someone is in the middle of typing
    shown.value = !v ? "" : kind === "date" ? shownDate(new Date(v + "T00:00")) : clock(new Date("2000-01-01T" + v));
  };
  const set = (v) => {
    if (value.value === v) return wrap.repaint();
    value.value = v;
    wrap.repaint();
    value.dispatchEvent(new Event("change", { bubbles: true }));
  };
  native.addEventListener("change", () => set(native.value));
  shown.addEventListener("change", () => {
    const read = kind === "date" ? parseShownDate(shown.value) : parseShownTime(shown.value);
    if (read) set(read);
    else wrap.repaint(); // unreadable: put back whatever was there rather than lose it
  });
  return wrap;
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
    '<div class="when" data-row="start"><span class="when-label">' + L.start + "</span></div>" +
    '<div class="when" data-row="end"><span class="when-label">' + L.end + "</span></div>" +
    '<p class="duration" aria-live="polite"></p>' +
    (type === OTHER
      ? '<label class="field">' + L.amountPaid + '<input name="amount" type="number" min="0" step="0.01" inputmode="decimal"></label>' +
        '<label class="field"><span>' + L.whatWasIt + ' <span class="optional">' + L.optional + '</span></span><input name="note" type="text" maxlength="120"></label>'
      : "") +
    (type === "Event" ? '<label class="check"><input name="slept" type="checkbox"> ' + L.slept + "</label>" : "") +
    '<fieldset class="expenses"><legend>' + L.expenses + '</legend><div class="expense-list"></div></fieldset>' +
    '<p class="form-error" role="alert" hidden></p>' +
    '<div class="form-actions"><button type="submit" class="btn-primary">' + L.saveType(type) + "</button></div>";

  const fields = [];
  const addField = (row, kind, name, label, pickLabel) => {
    const field = pickerField(kind, name, label, pickLabel);
    form.querySelector('[data-row="' + row + '"]').appendChild(field);
    fields.push(field);
  };
  addField("start", "date", "startDate", L.startDate, L.pickDate);
  addField("start", "time", "startTime", L.startTime, L.pickTime);
  addField("end", "date", "endDate", L.endDate, L.pickDate);
  addField("end", "time", "endTime", L.endTime, L.pickTime);

  const f = form.elements;
  f.startDate.value = start ? dateStr(start) : ds;
  // These hold the machine's own shapes — an ISO date, a 24-hour time — whatever the boxes above show
  f.startTime.value = start ? clock24(start) : "";
  f.endDate.value = end ? dateStr(end) : ds;
  f.endTime.value = end ? clock24(end) : "";
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
    const from = new Date(f.startDate.value + "T" + f.startTime.value);
    const to = new Date(f.endDate.value + "T" + f.endTime.value);
    const hours = (to - from) / 3600000;
    form.querySelector(".duration").textContent =
      hours > 0 ? formatHours(hours) + (type === "Event" && hours > 12 ? L.ofWhichExtra(formatHours(hours - 12)) : "") : "";
    // Says the same shift back in this phone's chosen date and time format, since the boxes can't
    fields.forEach((field) => field.repaint()); // the boxes follow whatever the hidden values now say
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
  // A type this version no longer offers (an old "Hotel") keeps its own option, so opening a shift
  // to change its times can't quietly relabel what was spent
  if (x.type && !EXPENSE_TYPES.includes(x.type)) {
    const opt = document.createElement("option");
    opt.value = x.type;
    opt.textContent = L.expenseTypes[x.type] || x.type;
    select.appendChild(opt);
  }
  select.value = x.type || "Other";
  const amount = document.createElement("input");
  amount.type = "number";
  amount.min = "0";
  amount.step = "0.01";
  amount.inputMode = "decimal";
  amount.placeholder = "₪";
  amount.setAttribute("aria-label", L.expenseAmount);
  amount.value = x.amount;

  // "Other" says nothing on its own, so it can carry a description. Never required.
  const note = document.createElement("input");
  note.type = "text";
  note.className = "expense-note";
  note.maxLength = 60;
  // No dir="auto" here: with nothing typed yet there's no strong character to go on, so the browser
  // falls back to left-to-right and renders the Hebrew placeholder backwards. Inheriting the page is right.
  note.placeholder = L.expenseNote;
  note.setAttribute("aria-label", L.expenseNote);
  note.value = x.note || "";
  note.hidden = select.value !== "Other";
  // Kept, not cleared, when the type changes: switching back shouldn't lose what was typed
  select.addEventListener("change", () => (note.hidden = select.value !== "Other"));

  row.append(select, amount, makeButton(L.remove, "btn-text", () => row.remove()), note);
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
    .map((row) => {
      const kind = row.querySelector("select").value;
      const spent = { type: kind, amount: Number(row.querySelector('input[type="number"]').value) };
      const said = row.querySelector(".expense-note").value.trim();
      if (kind === "Other" && said) spent.note = said; // only where it means anything
      return spent;
    })
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
    .then((r) => {
      // In the missing-times list the other shifts stay open; everywhere else the panel is done
      const panel = el("dayPanel");
      form.remove();
      if (!form.dataset.keepOpen || !panel.querySelector("form")) panel.close();
      showToast(r && r.drafted ? L.draftKept : L.typeSaved(type));
      refreshAfterShiftChange();
    })
    .catch((err) => {
      btn.disabled = false;
      btn.textContent = L.saveType(type);
      if (accessToken) fail(L.couldntSave + err.message);
    });
}

function removeOtherJob(event) {
  deleteEvent(event.id, eventDate(event), OTHER)
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
const SETTINGS_ROWS = ["title", "", "full_name", "company_email", "bcc_email", "report_language", "", "rate_warehouse", "rate_event", "rate_extra", "rate_night"];

let sheetId = localStorage.getItem("sb_sheetId");
let settings = null; // { full_name, company_email, rate_* } as last read from or saved to the sheet

const hasDrive = () => grantedScopes.split(" ").includes(DRIVE_SCOPE);
const hasGmail = () => grantedScopes.split(" ").includes(GMAIL_SCOPE);

function forgetSheet() {
  sheetId = null;
  settings = null;
  sheetTabs = null;
  reportsFolderId = null;
  localStorage.removeItem("sb_sheetId");
  localStorage.removeItem("sb_folderId");
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

// The name on a report is in the report's language: Hebrew letters on a Hebrew report, English letters on an
// English one (spaces, hyphens, apostrophes and the Hebrew geresh are fine; digits and the other script aren't)
const NAME_PATTERNS = {
  he: /^(?=.*\p{Script=Hebrew})[\p{Script=Hebrew}\s'’.-]+$/u,
  en: /^(?=.*\p{Script=Latin})[\p{Script=Latin}\s'’.-]+$/u,
};

function nameFitsReport(name, lang) {
  return NAME_PATTERNS[lang === "en" ? "en" : "he"].test(String(name).trim());
}

// Why the saved name can't go on the report, or "" when it can (a missing name is reported on its own)
function nameProblem(s) {
  const name = String((s && s.full_name) || "").trim();
  const lang = reportLanguage(s);
  if (!name || nameFitsReport(name, lang)) return "";
  return lang === "he" ? L.errNameHe : L.errNameEn;
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

// ---------- The month's table (written to the pay sheet, and drawn into the PDF that gets sent) ----------

// The report (its words are REPORT_TEXT in i18n.js), top to bottom: title; name, month and year; the total to pay (gross salary) and, apart from it,
// the expenses reimbursement; a quiet hours summary; then one row per shift and a totals row. Plain values, not
// formulas, so the sheet always matches the app. `at` says where each part starts, for the formatting.
function monthTable(monthDate, lines, totals, s, lang, corrected) {
  const T = REPORT_TEXT[lang] || REPORT_TEXT.he;
  const monthName = monthDate.toLocaleDateString(T.locale, { month: "long" });
  const year = String(monthDate.getFullYear());
  const at = {};
  const rows = [];
  at.title = rows.push([T.title + " - " + monthName + " " + year + (corrected ? " (" + T.corrected + ")" : "")]) - 1; // plain hyphens only
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
    const startText = line.missingTimes ? "" : clock24(new Date(line.event.start.dateTime));
    const endText = line.missingTimes ? "" : clock24(new Date(line.event.end.dateTime)) + (later > 0 ? " " + T.later(later) : "");
    const details = [];
    const note = privateProps(line.event).note;
    if (line.type === OTHER && note) details.push(note);
    expensesOf(line.event).forEach((x) =>
      details.push((T.expenseTypes[x.type] || x.type) + (x.note ? " (" + x.note + ")" : "") + " ₪" + x.amount)
    );
    if (line.missingTimes) details.push(T.noTimes);
    rows.push([
      dmy(day),
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

const SENT_KEY = "shiftboard_sent"; // hidden note on a month's tab: when it was sent, to whom, with which rates
let sheetTabs = null; // the pay sheet's tabs and their hidden notes, as last read

function loadTabs() {
  return ensureSheet()
    .then((id) => jsonGet(SHEETS_API + "/" + id + "?fields=sheets(properties(sheetId,title),developerMetadata(metadataId,metadataKey,metadataValue))"))
    .then((meta) => (sheetTabs = meta.sheets || []));
}

function monthTab(d) {
  const tabs = sheetTabs || [];
  return tabs.find((s) => s.properties.title === monthTabTitle(d)) || tabs.find((s) => s.properties.title === legacyTabTitle(d)) || null;
}

// What was sent for a month, { sentAt, to, rates, fingerprint, pdfId, corrections, open }, or null if it never was
function sentInfo(d) {
  const tab = monthTab(d);
  const note = tab && (tab.developerMetadata || []).find((m) => m.metadataKey === SENT_KEY);
  if (!note) return null;
  try {
    return Object.assign(JSON.parse(note.metadataValue), { metadataId: note.metadataId, tabId: tab.properties.sheetId });
  } catch (e) {
    return null; // a note broken by hand mustn't stop the Pay view
  }
}

// Records on the month's tab what was sent, or that the month was reopened
function saveSentInfo(info) {
  const { metadataId, tabId, ...stored } = info;
  const value = JSON.stringify(stored);
  const request = metadataId
    ? { updateDeveloperMetadata: { dataFilters: [{ developerMetadataLookup: { metadataId } }], developerMetadata: { metadataValue: value }, fields: "metadataValue" } }
    : { createDeveloperMetadata: { developerMetadata: { metadataKey: SENT_KEY, metadataValue: value, location: { sheetId: tabId }, visibility: "DOCUMENT" } } };
  return jsonRequest(SHEETS_API + "/" + sheetId + ":batchUpdate", "POST", { requests: [request] }).then(loadTabs);
}

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

// Writes the Pay view's month into its own tab ("2026-09"), in the report language, titled "Corrected" when it's
// being resent. If the tab was changed by hand since the app last wrote it, asks first. Resolves with the tab's id,
// or null when the user chose to keep their edits.
function writeMonthTab({ corrected = false } = {}) {
  const title = monthTabTitle(payMonth);
  const quoted = encodeURIComponent("'" + title + "'");
  const table = monthTable(payMonth, payData.lines, payData.totals || monthTotals([]), settings, reportLanguage(settings), corrected);
  const rows = table.rows;
  let tabId;
  let note = null;
  return loadTabs()
    .then(() => {
      const tab = monthTab(payMonth);
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
        .then(loadTabs)
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
  const problem = nameProblem(settings); // never a name in the other language on the sheet
  if (problem) {
    showToast(problem, true);
    openSettings();
    return;
  }
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

const SETTING_KEYS = ["full_name", "company_email", "bcc_email", "report_language", "rate_warehouse", "rate_event", "rate_extra", "rate_night"];
let payMonth = null; // the 1st of the month shown on the Pay view
let pendingView = null; // the view to return to after signing in again (e.g. to grant the Drive permission)
let viewBeforeSettings = "shifts"; // where the settings were opened from

// Leaving the settings with something typed but not saved: ask first. The form is refilled from the sheet
// every time it opens, so walking away would lose it silently. The question is asked in the app's own
// panel, and an answer to that arrives later — which is why moving the view is split out below.
function showView(view) {
  if (view !== "settings" && settingsDirty()) {
    askToLeaveSettings(() => openView(view));
    return;
  }
  openView(view);
}

function openView(view) {
  const pay = view === "pay";
  const setup = view === "settings";
  el("tabShifts").setAttribute("aria-pressed", String(!pay && !setup));
  el("tabPay").setAttribute("aria-pressed", String(pay));
  el("settingsBtn").setAttribute("aria-pressed", String(setup));
  el("workspace").hidden = pay || setup;
  el("saveBar").hidden = pay || setup;
  el("payView").hidden = !pay;
  el("settingsView").hidden = !setup;
  document.body.classList.toggle("is-pay", pay);
  if (pay) openPayView();
  if (setup) openSettingsView();
}

// Remembers where you were, so leaving the settings puts you back rather than somewhere arbitrary
function openSettings() {
  if (el("settingsView").hidden) viewBeforeSettings = el("payView").hidden ? "shifts" : "pay";
  showView("settings");
}

// The calendar picker needs nothing but Calendar. The name and rates live in the pay sheet, so they
// wait for Drive the same way the Pay view does.
function openSettingsView() {
  const connected = hasDrive();
  el("settingsConnect").hidden = connected;
  el("settingsForm").hidden = !connected;
  if (!connected) return;
  (settings ? Promise.resolve(settings) : loadSettings())
    .then(fillSettingsForm)
    .catch((err) => showApiError(L.errOpenSheet, err));
}

// The board says which calendar it's writing to without the picker taking up room on every visit
function updateSavingTo() {
  const btn = el("savingToBtn");
  const cal = calendars.find((c) => c.id === selectedCalendarId);
  btn.textContent = cal ? L.savingTo(cal.summary + (cal.primary ? L.mainCalendar : "")) : L.chooseCalendar;
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
      sheetTabs = null; // read afresh: another device may have sent a month
      renderPayMonth();
    })
    .catch((err) => {
      el("payStatus").textContent = "";
      showApiError(L.errOpenSheet, err);
    });
}

function fillSettingsForm(s) {
  const form = el("settingsForm");
  const f = form.elements;
  SETTING_KEYS.forEach((key) => (f[key].value = s[key] || ""));
  f.report_language.value = reportLanguage(s);
  el("fullNameLabel").textContent = L.fullNameIn(reportLanguage(s));
  checkSettingsName();
  settingsAsFilled = snapshotSettingsForm();
}

// What the form held when it was last filled or saved. Comparing against the saved settings directly
// wouldn't do: the form normalises the report language, so it would read as changed the moment it opened.
let settingsAsFilled = null;

function snapshotSettingsForm() {
  const f = el("settingsForm").elements;
  return SETTING_KEYS.map((key) => String(f[key].value).trim()).join(" ");
}

function settingsDirty() {
  return settingsAsFilled !== null && !el("settingsView").hidden && snapshotSettingsForm() !== settingsAsFilled;
}

// The browser's own confirm() box looks nothing like the app, so this asks in the panel the rest of the
// app uses. Closing it any other way — the X, Escape, tapping outside — means "keep editing", which is
// the safe answer. Leaving is the quiet button; staying is the one under your thumb.
function askToLeaveSettings(leave) {
  const panel = openPanel(L.unsavedTitle);
  panel.appendChild(textEl("p", "panel-note", L.discardDetails));
  const actions = document.createElement("div");
  actions.className = "form-actions";
  actions.append(
    makeButton(L.leaveWithoutSaving, "btn-text", () => {
      panel.close();
      leave();
    }),
    makeButton(L.keepEditing, "btn-primary", () => panel.close())
  );
  panel.appendChild(actions);
  panel.showModal();
}

// The name has to be there, and in the report's own letters, before any of this can be saved — so the
// button says so by staying out of reach, rather than being pressed and refusing. A name saved before
// this rule existed, or typed into the sheet by hand, is caught the same way when the form opens.
function checkSettingsName() {
  const form = el("settingsForm");
  const name = form.elements.full_name.value;
  const problem = nameProblem({ full_name: name, report_language: form.elements.report_language.value });
  const error = form.querySelector(".form-error");
  error.textContent = problem;
  error.hidden = !problem;
  form.querySelector('[type="submit"]').disabled = !name.trim() || !!problem;
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
  const nameIssue = nameProblem(values);
  if (nameIssue) return fail(nameIssue);
  const looksLikeEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
  if (values.company_email && !looksLikeEmail(values.company_email)) return fail(L.errEmail);
  if (values.bcc_email && !looksLikeEmail(values.bcc_email)) return fail(L.errEmail);
  error.hidden = true;
  const btn = form.querySelector('[type="submit"]');
  btn.disabled = true;
  saveSettings(values)
    .then(() => {
      showToast(L.savedToSheet);
      settingsAsFilled = snapshotSettingsForm(); // what's on screen is what's saved now, so nothing to ask about
      showView(viewBeforeSettings); // back where they came from, with the new details in hand
    })
    .catch((err) => showApiError(L.errSaveDetails, err))
    .finally(checkSettingsName); // re-derived from what's in the form, not blindly re-enabled
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
  // Until this month's shifts are in, so neither the sheet nor the company can get another month's
  el("writeSheetBtn").disabled = true;
  el("sendBtn").disabled = true;
  el("openSheetLink").hidden = true;
  // Up to a day into next month, so a shift starting late on the last day is included
  Promise.all([fetchEvents(new Date(year, month, 1), new Date(year, month + 1, 2)), sheetTabs || loadTabs()])
    .then(([items]) => {
      if (seq !== payLoadSeq) return;
      // A month that was sent keeps the rates it was sent with; the others use today's
      const sent = sentInfo(payMonth);
      const rates = (sent && sent.rates) || ratesFrom(settings);
      const lines = monthLines(items, year, month, rates);
      const totals = monthTotals(lines);
      payData = { lines, totals, rates, sent };
      el("writeSheetBtn").disabled = false;
      renderPayStatus(lines, rates);
      // Zeros everywhere mean nothing until the rates are in, so ask for those instead
      const set = ratesFrom(settings);
      el("paySetup").hidden = !!(settings.full_name && set.warehouse && set.event);
      renderPayTotals(lines.length ? totals : null, lines, rates);
      renderPayLines(lines);
      renderSendState();
    })
    .catch((err) => showApiError(L.errLoadMonth, err));
}

// Later than today. Today's shift is happening now, so it counts as now — which is also why the board
// still asks for its times: someone can fill them in the moment they finish.
const stillToCome = (line) => line.ds > dateStr(new Date());

function renderPayStatus(lines, rates) {
  const status = el("payStatus");
  // A shift still to come has no times because it hasn't happened; only worked ones are a gap to chase
  const worked = lines.filter((line) => line.missingTimes && !stillToCome(line)).length;
  status.classList.toggle("needs-times", worked > 0);
  if (!rates.warehouse && !rates.event) status.textContent = L.addRates;
  else if (!lines.length) status.textContent = L.noShiftsMonth;
  else if (worked) status.textContent = L.notFinal(worked);
  else if (lines.some((line) => line.missingTimes)) status.textContent = ""; // only shifts still to come
  else status.textContent = L.allTimed;
}

// What an hourly shift is guessed at when its hours aren't known yet. Only ever said out loud beside the
// total, never added to it: the total is what the pay sheet and the company are given, and that stays fact.
const GUESSED_HOURS = 8;

function renderPayTotals(totals, lines, rates) {
  const box = el("payTotals");
  box.innerHTML = "";
  if (!totals) return;
  const money = (n) => moneyFormat.format(n);
  // The total is the whole month, the same figure the company is sent. Part of it may not have been
  // worked yet, which is worth saying out loud rather than leaving people to work out for themselves.
  const ahead = (lines || []).filter(stillToCome);
  const aheadPay = round2(ahead.reduce((sum, line) => sum + line.salary, 0));
  // An Event is worth its day rate the moment it's worked, so it needs no guessing. A Warehouse day is
  // worth nothing until its hours are in — past or future alike — so the month is guessed with those at
  // eight hours, and the answer given as a finished figure rather than a sum to add up in your head.
  const hourly = (lines || []).filter((line) => line.type === "Warehouse" && line.missingTimes);
  const guess = round2(hourly.length * GUESSED_HOURS * ((rates && rates.warehouse) || 0));
  const counted = ahead.filter((line) => line.salary > 0).length;
  const aside = [];
  if (!ahead.length) {
    // nothing ahead to explain
  } else if (!counted) {
    aside.push(L.toComeUncounted(ahead.length));
  } else if (counted === ahead.length) {
    aside.push(L.stillToCome(money(aheadPay), ahead.length));
  } else {
    // The money belongs to some of them, not all, and saying "for 2 shifts" reads as though it covered both
    aside.push(L.someToCome(money(aheadPay), counted, ahead.length));
  }
  if (guess > 0) aside.push(L.monthGuess(money(round2(totals.salary + guess)), hourly.length, GUESSED_HOURS));
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
    // Directly under the figure it explains, before the reimbursement, which it has nothing to do with
    (aside.length ? '<p class="to-come">' + aside.join(" ") + "</p>" : "") +
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
      ["pay-detail" + (line.missingTimes && !stillToCome(line) ? " needs-times" : ""), lineDetail(line)],
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
  const day = new Date(line.ds + "T00:00").toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" });
  return line.missingTimes ? day : day + " · " + timeRange(line.event);
}

function lineDetail(line) {
  if (line.missingTimes) return stillToCome(line) ? L.toCome : L.noTimes;
  const parts = [formatHours(line.hours)];
  if (line.extraHours) parts.push(L.extra(formatHours(line.extraHours)));
  if (line.night) parts.push(L.nightPay(moneyFormat.format(line.night)));
  if (line.expenses) parts.push(L.expensesPay(moneyFormat.format(line.expenses)));
  const note = privateProps(line.event).note;
  if (line.type === OTHER && note) parts.push(note);
  return parts.join(" · ");
}

// ---------- Sending the month: a review, the PDF, Gmail, and a copy in Drive ----------

const GMAIL_SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
let reportsFolderId = localStorage.getItem("sb_folderId");

const sameRates = (a, b) => ["warehouse", "event", "extra", "night"].every((k) => a[k] === b[k]);
const monthLabel = (d, locale) => d.toLocaleDateString(locale || LOCALE, { month: "long", year: "numeric" });

// What a month's pay is made of, in any report language: to notice calendar changes after it was sent
function monthFingerprint(lines) {
  const endMs = (event) => (event.end && event.end.dateTime ? new Date(event.end.dateTime).getTime() : "");
  return tableHash(lines.map((l) => [l.ds, l.type, startMs(l.event), endMs(l.event), l.pay, l.night, l.expenses, privateProps(l.event).note || ""]));
}

// Why the Pay view's month can't be sent yet, or "" when it can
function sendBlocker({ lines, totals, rates }) {
  const now = new Date();
  if (payMonth > new Date(now.getFullYear(), now.getMonth(), 1)) return L.blockFuture;
  if (!lines.length) return L.blockEmpty;
  if (totals.missingTimes) return L.blockTimes;
  const t = totals;
  if ((t.warehouse.count && !rates.warehouse) || (t.event.count && !rates.event) || (t.event.extraHours && !rates.extra) || (t.nights.count && !rates.night)) {
    return L.blockRates;
  }
  if (!settings.full_name || !settings.company_email) return L.blockDetails;
  if (nameProblem(settings)) return L.blockName(reportLanguage(settings));
  return "";
}

// Not sent (and what's still missing), sent (with a way to reopen it), or reopened for a correction
function renderSendState() {
  const { lines, rates, sent } = payData;
  const closed = !!sent && !sent.open;
  const keptRates = !!sent && sent.open && !sameRates(rates, ratesFrom(settings));
  const status = el("sendStatus");
  const send = el("sendBtn");
  let text;
  let tone = "";
  if (closed) {
    const date = shownDate(new Date(sent.sentAt));
    const drifted = monthFingerprint(lines) !== sent.fingerprint;
    text = L.sentOn(date, sent.to, sent.corrections > 0) + (drifted ? " " + L.drift : "");
    tone = drifted ? " is-warning" : " is-sent";
  } else {
    const blocked = sendBlocker(payData);
    text = [sent ? L.reopened : L.notSent, keptRates ? L.ratesAsSent : "", blocked].filter(Boolean).join(" ");
    send.disabled = !!blocked;
  }
  status.textContent = text;
  status.className = "send-status" + tone;
  status.hidden = false;
  send.hidden = closed;
  send.textContent = sent ? L.reviewCorrection : L.reviewSend;
  el("writeSheetBtn").hidden = closed; // a sent month's tab is the record of what was sent
  el("reopenBtn").hidden = !closed;
  el("useRatesBtn").hidden = !keptRates;
  const pdf = el("sentPdfLink");
  pdf.hidden = !(closed && sent.pdfId);
  if (!pdf.hidden) pdf.href = "https://drive.google.com/file/d/" + encodeURIComponent(sent.pdfId) + "/view";
  if (closed) {
    const link = el("openSheetLink");
    link.href = "https://docs.google.com/spreadsheets/d/" + sheetId + "/edit#gid=" + sent.tabId;
    link.hidden = false;
  }
}

function reopenMonth() {
  const sent = payData.sent;
  if (!sent || !confirm(L.confirmReopen(monthLabel(payMonth)))) return;
  const btn = el("reopenBtn");
  btn.disabled = true;
  saveSentInfo(Object.assign({}, sent, { open: true }))
    .then(renderPayMonth)
    .catch((err) => showApiError(L.errUpdateSheet, err))
    .finally(() => (btn.disabled = false));
}

// A reopened month keeps the rates it was sent with, unless the person switches it to today's
function useCurrentRates() {
  const sent = payData.sent;
  if (!sent) return;
  saveSentInfo(Object.assign({}, sent, { rates: ratesFrom(settings) }))
    .then(renderPayMonth)
    .catch((err) => showApiError(L.errUpdateSheet, err));
}

// The review: who it goes to, the name on it, the totals and the month's PDF. Nothing leaves before Send.
function openSendPanel() {
  const { lines, totals, rates, sent } = payData;
  const month = payMonth;
  const T = REPORT_TEXT[reportLanguage(settings)];
  const firstEver = !(sheetTabs || []).some((tab) => (tab.developerMetadata || []).some((m) => m.metadataKey === SENT_KEY));
  const sendLabel = sent ? L.sendCorrection : L.sendNow;
  let pdf = null;
  let tabId = null;
  let url = null;

  const panel = openPanel(L.sendTitle(monthLabel(month)));
  const box = document.createElement("div");
  box.className = "send-review";
  const now = new Date();
  if (month.getFullYear() === now.getFullYear() && month.getMonth() === now.getMonth()) {
    box.appendChild(textEl("p", "send-caution", L.monthNotOver(monthLabel(month))));
  }
  const facts = document.createElement("dl");
  facts.className = "send-facts";
  [
    [L.sendTo, settings.company_email, "ltr"],
    settings.bcc_email ? [L.sendCopyTo, settings.bcc_email, "ltr"] : null,
    [L.sendName, settings.full_name, "auto"],
    [L.reportLanguage, T.langName],
    [L.tabShifts, L.countShifts(lines.length)],
    [L.totalToPay + " (" + L.grossSalary + ")", moneyFormat.format(totals.salary)],
    [L.reimbursement, moneyFormat.format(totals.expenses)],
  ].filter(Boolean).forEach(([label, value, dir]) => {
    const row = document.createElement("div");
    const dd = textEl("dd", "", value);
    if (dir) dd.dir = dir;
    row.append(textEl("dt", "", label), dd);
    facts.appendChild(row);
  });
  box.append(
    facts,
    makeButton(L.changeDetails, "btn-text", () => {
      panel.close();
      openSettings();
    })
  );
  const pdfLine = textEl("p", "send-pdf", L.preparingPdf);
  box.appendChild(pdfLine);
  let agree = null;
  if (firstEver) {
    // The very first report: the person confirms the name and the address it goes out with
    const label = document.createElement("label");
    label.className = "check";
    agree = document.createElement("input");
    agree.type = "checkbox";
    label.append(agree, " " + L.confirmFirst);
    box.appendChild(label);
  }
  if (!hasGmail()) box.appendChild(textEl("p", "fine", L.gmailNote));
  const error = textEl("p", "form-error", "");
  error.setAttribute("role", "alert");
  error.hidden = true;
  const fail = (msg) => {
    error.textContent = msg;
    error.hidden = false;
  };
  const ready = () => {
    sendBtn.textContent = sendLabel;
    sendBtn.disabled = !pdf || (!!agree && !agree.checked);
  };
  const sendNow = () => {
    error.hidden = true;
    sendBtn.disabled = true;
    sendBtn.textContent = L.sending;
    const go = () => {
      if (!hasGmail()) {
        fail(L.gmailDenied);
        return ready();
      }
      deliverMonth({ month, T, pdf, sent, totals, lines, rates, tabId })
        .then((to) => {
          panel.close();
          showToast(L.sentToast(to));
          renderPayMonth();
          loadMissingTimes();
        })
        .catch((err) => {
          fail(err.message);
          ready();
        });
    };
    // Sending mail is a permission of its own, asked for the first time it's needed (within this tap, so Google's window can open)
    if (hasGmail()) go();
    else requestScope(GMAIL_SCOPE, go, ready);
  };
  const actions = document.createElement("div");
  actions.className = "form-actions";
  const sendBtn = makeButton(sendLabel, "btn-primary", sendNow);
  sendBtn.disabled = true;
  actions.appendChild(sendBtn);
  box.append(error, actions);
  panel.appendChild(box);
  if (agree) agree.addEventListener("change", ready);
  panel.addEventListener("close", () => url && URL.revokeObjectURL(url), { once: true });
  panel.showModal();

  // The PDF is drawn from the very table the month's tab is rewritten with, so the sheet and the PDF agree
  const table = monthTable(month, lines, totals, settings, reportLanguage(settings), !!sent);
  writeMonthTab({ corrected: !!sent })
    .then((id) => {
      if (id === null) throw Object.assign(new Error(L.errKeptEdits), { plain: true });
      tabId = id;
      return makeReportPdf(table, table.rows[table.at.title][0] + " - " + settings.full_name);
    })
    .then((blob) => {
      pdf = blob;
      url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.className = "btn-text";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = L.openPdf;
      pdfLine.replaceWith(link);
      ready();
    })
    .catch((err) => {
      pdfLine.hidden = true;
      fail(err.plain ? err.message : L.errPdf + ": " + err.message);
    });
}

// ---------- The PDF: the month's report drawn page by page, in the sheet's layout ----------
// Google only exports a single tab as PDF to apps allowed to read all of someone's Drive, and ShiftBoard only
// asks for its own files. So the app draws the report itself: A4 landscape pages on a canvas (the browser
// takes care of Hebrew running right to left), each saved as a JPEG inside a small PDF.

const PDF_PAGE = { width: 1123, height: 794, margin: 40, scale: 2 }; // A4 landscape at 96 px per inch, drawn at 2x

const cssColor = (c) => "rgb(" + [c.red || 0, c.green || 0, c.blue || 0].map((x) => Math.round(x * 255)).join(",") + ")";

// The report's rows as the PDF draws them: cells spanning columns like the sheet's merges, each row's look,
// which rows form the shifts table (bordered, headings repeated on a new page), and which keep with the next
function reportRows({ rows, at, lines }) {
  const C = SHEET_COLORS;
  const W = COLUMN_WIDTHS.length;
  const money = (v) => (typeof v === "number" ? "₪" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(v));
  const numeric = (c) => c >= 5 && c <= 9;
  const shown = (v, c) => (c >= 7 && c <= 9 ? money(v) : numeric(c) && typeof v === "number" ? v.toFixed(2) : String(v));
  return rows.map((r, i) => {
    if (i === at.title) return { cells: [{ text: r[0], span: W }], bg: C.ink, color: C.white, bold: true, size: 20, height: 46 };
    if (i >= at.info && i < at.info + 3) return { cells: [{ text: r[0], span: 3, color: C.label, bold: true }, { text: String(r[3]), span: W - 3 }], height: 26 };
    if (i === at.salary) return { cells: [{ text: r[0], span: 3 }, { text: money(r[3]), span: W - 3 }], bg: C.ink, color: C.white, bold: true, size: 16, height: 38 };
    if (i === at.expenses) return { cells: [{ text: r[0], span: 3 }, { text: money(r[3]), span: W - 3 }], bg: C.heading, bold: true, size: 14, height: 32 };
    if (i === at.note) return { cells: [{ text: r[0], span: W }], color: C.missing, bold: true, height: 24 };
    if (i >= at.hoursTitle && i < at.hoursEnd) {
      const title = i === at.hoursTitle;
      return { cells: [{ text: r[0], span: W }], color: C.label, bold: title, size: 11, height: 19, keep: title ? at.hoursEnd - at.hoursTitle - 1 : 0 };
    }
    if (i === at.shiftsTitle) return { cells: [{ text: r[0], span: W }], bg: C.ink, color: C.white, bold: true, size: 15, height: 34, keep: 2 };
    if (i === at.headings) return { cells: r.map((t) => ({ text: t, align: "center", wrap: true })), bg: C.heading, bold: true, table: true, headings: true, keep: 1 };
    if (i >= at.lines && i < at.sum) {
      const line = lines[i - at.lines];
      const flag = line.missingTimes;
      return {
        cells: r.map((v, c) => ({
          text: shown(v, c),
          align: numeric(c) ? "end" : "start",
          wrap: c === W - 1,
          bg: c === 2 ? C[line.type] : null,
          bold: c === 2 || (c === W - 1 && flag),
          color: c === W - 1 && flag ? C.missing : null,
        })),
        bg: (i - at.lines) % 2 ? C.band : null,
        table: true,
      };
    }
    if (i === at.sum) return { cells: r.map((v, c) => ({ text: shown(v, c), align: numeric(c) ? "end" : "start" })), bg: C.heading, bold: true, table: true };
    return { cells: [], height: 12 }; // a blank row: space between the parts
  });
}

// The sheet's columns rebalanced for a printed page: more room for the times, less for Details, which wraps
const PDF_COLUMN_WIDTHS = [100, 90, 130, 90, 130, 80, 110, 110, 100, 110, 280];

// Draws the report onto as many A4 landscape canvases as it needs; pages after the first carry a running head
function drawReportPages(table, runningHead) {
  const { width, height, margin, scale } = PDF_PAGE;
  const inner = width - 2 * margin;
  const sum = (list) => list.reduce((a, b) => a + b, 0);
  const widths = PDF_COLUMN_WIDTHS.map((w) => (w * inner) / sum(PDF_COLUMN_WIDTHS));
  const rtl = table.rtl;
  const pad = 6;
  const pages = [];
  let ctx = null;
  let y = 0;
  let tableTop = null;
  const font = (bold, size) => (bold ? "700 " : "400 ") + (size || 12) + "px Heebo, Arial, sans-serif";
  const boldOf = (cell, row) => (cell.bold !== undefined ? cell.bold : row.bold);
  const lineHeight = (row) => Math.round((row.size || 12) * 1.4);
  // A run of columns, counted from the reading side (the right in Hebrew)
  const place = (first, count) => {
    const before = sum(widths.slice(0, first));
    const w = sum(widths.slice(first, first + count));
    return { x: rtl ? margin + inner - before - w : margin + before, w };
  };
  const wrap = (text, max) => {
    const lines = [];
    let current = "";
    text.split(" ").forEach((word) => {
      const next = current ? current + " " + word : word;
      if (current && ctx.measureText(next).width > max) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    });
    lines.push(current);
    return lines;
  };
  const layout = (row) => {
    let column = 0;
    const cells = row.cells.map((cell) => {
      const spot = place(column, cell.span || 1);
      column += cell.span || 1;
      const room = spot.w - 2 * pad;
      let size = row.size || 12;
      ctx.font = font(boldOf(cell, row), size);
      if (cell.wrap) return Object.assign({}, cell, spot, { size, lines: wrap(cell.text, room) });
      // One line that's too long is set a little smaller rather than cut off
      const measured = ctx.measureText(cell.text).width;
      if (measured > room) size = Math.max(8, Math.floor(((size * room) / measured) * 10) / 10);
      return Object.assign({}, cell, spot, { size, lines: [cell.text] });
    });
    const tallest = Math.max(1, ...cells.map((cell) => cell.lines.length));
    return { cells, h: Math.max(row.height || 24, tallest * lineHeight(row) + 10) };
  };
  const newPage = () => {
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.direction = rtl ? "rtl" : "ltr";
    ctx.textBaseline = "middle";
    pages.push({ canvas, ctx });
    if (pages.length > 1 && runningHead) {
      // Whose report and which month, in case the pages get separated
      ctx.font = font(false, 10);
      ctx.fillStyle = cssColor(SHEET_COLORS.label);
      ctx.textAlign = "start";
      ctx.fillText(runningHead, rtl ? width - margin : margin, margin / 2);
    }
    y = margin;
  };
  const closeTable = () => {
    if (tableTop === null) return;
    ctx.strokeStyle = cssColor(SHEET_COLORS.ink);
    ctx.lineWidth = 2;
    ctx.strokeRect(margin, tableTop, inner, y - tableTop);
    tableTop = null;
  };
  const draw = (row, { cells, h }) => {
    if (row.table && tableTop === null) tableTop = y;
    if (row.bg) {
      ctx.fillStyle = cssColor(row.bg);
      ctx.fillRect(margin, y, inner, h);
    }
    const lh = lineHeight(row);
    cells.forEach((cell) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(cell.x, y, cell.w, h);
      ctx.clip(); // text never runs into the next cell
      if (cell.bg) {
        ctx.fillStyle = cssColor(cell.bg);
        ctx.fillRect(cell.x, y, cell.w, h);
      }
      ctx.font = font(boldOf(cell, row), cell.size);
      ctx.fillStyle = cssColor(cell.color || row.color || SHEET_COLORS.ink);
      ctx.textAlign = cell.align === "center" ? "center" : cell.align === "end" ? "end" : "start";
      const x = cell.align === "center" ? cell.x + cell.w / 2 : (cell.align === "end") !== rtl ? cell.x + cell.w - pad : cell.x + pad;
      const top = y + h / 2 - ((cell.lines.length - 1) * lh) / 2;
      cell.lines.forEach((text, k) => ctx.fillText(text, x, top + k * lh));
      ctx.restore();
      if (row.table) {
        ctx.strokeStyle = cssColor(SHEET_COLORS.line);
        ctx.lineWidth = 1;
        ctx.strokeRect(cell.x, y, cell.w, h);
      }
    });
    y += h;
  };

  const rows = reportRows(table);
  const headings = rows.find((row) => row.headings);
  newPage();
  rows.forEach((row, i) => {
    let laid = layout(row);
    // A heading stays with what follows it; a row that doesn't fit starts a new page
    const needed = laid.h + sum(rows.slice(i + 1, i + 1 + (row.keep || 0)).map((next) => layout(next).h));
    if (y + needed > height - margin && y > margin) {
      closeTable();
      newPage();
      if (row.table && !row.headings && headings) draw(headings, layout(headings)); // the shifts carry on under their headings
      laid = layout(row);
    }
    if (!row.table) closeTable();
    draw(row, laid);
  });
  closeTable();
  if (pages.length > 1) {
    pages.forEach((page, i) => {
      page.ctx.font = font(false, 10);
      page.ctx.fillStyle = cssColor(SHEET_COLORS.label);
      page.ctx.direction = "ltr"; // "1 / 2" reads left to right in Hebrew too
      page.ctx.textAlign = "center";
      page.ctx.fillText(i + 1 + " / " + pages.length, width / 2, height - margin / 2);
    });
  }
  return pages.map((page) => page.canvas);
}

// The report is set in Heebo (Latin and Hebrew); a canvas doesn't wait for web fonts, so they load first
function loadReportFonts() {
  if (!document.fonts || !document.fonts.load) return Promise.resolve();
  return Promise.all(["400 12px Heebo", "700 12px Heebo"].map((f) => document.fonts.load(f, "Aa1₪אב"))).catch(() => {});
}

function canvasJpeg(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("canvas"))), "image/jpeg", 0.92))
    .then((blob) => blob.arrayBuffer())
    .then((buffer) => ({ bytes: new Uint8Array(buffer), width: canvas.width, height: canvas.height }));
}

// A minimal PDF: one A4 landscape page per JPEG, and the title (UTF-16, so Hebrew survives) for PDF viewers
function pdfFromJpegs(images, title) {
  const enc = new TextEncoder();
  const chunks = [];
  const offsets = [];
  let size = 0;
  const add = (piece) => {
    const bytes = typeof piece === "string" ? enc.encode(piece) : piece;
    chunks.push(bytes);
    size += bytes.length;
  };
  const object = (id, dict, stream) => {
    offsets[id] = size;
    add(id + " 0 obj\n" + dict + "\n");
    if (stream) {
      add("stream\n");
      add(stream);
      add("\nendstream\n");
    }
    add("endobj\n");
  };
  const utf16 = (s) => "<FEFF" + s.split("").map((unit) => unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")).join("") + ">"; // UTF-16BE
  const W = 842; // A4 landscape, in points
  const H = 595;
  const info = 3 + images.length * 3;
  add("%PDF-1.4\n%âãÏÓ\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [" + images.map((_, i) => 3 + i * 3 + " 0 R").join(" ") + "] /Count " + images.length + " >>");
  images.forEach((img, i) => {
    const page = 3 + i * 3;
    const draw = enc.encode("q " + W + " 0 0 " + H + " 0 0 cm /Im0 Do Q");
    object(page, "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 " + W + " " + H + "] /Resources << /XObject << /Im0 " + (page + 2) + " 0 R >> >> /Contents " + (page + 1) + " 0 R >>");
    object(page + 1, "<< /Length " + draw.length + " >>", draw);
    object(page + 2, "<< /Type /XObject /Subtype /Image /Width " + img.width + " /Height " + img.height +
      " /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length " + img.bytes.length + " >>", img.bytes);
  });
  object(info, "<< /Title " + utf16(title || "") + " /Creator (ShiftBoard) /Producer (ShiftBoard) >>");
  const xref = size;
  let table = "xref\n0 " + (info + 1) + "\n0000000000 65535 f \n";
  for (let id = 1; id <= info; id++) table += String(offsets[id]).padStart(10, "0") + " 00000 n \n";
  add(table + "trailer\n<< /Size " + (info + 1) + " /Root 1 0 R /Info " + info + " 0 R >>\nstartxref\n" + xref + "\n%%EOF\n");
  return new Blob(chunks, { type: "application/pdf" });
}

function makeReportPdf(table, title) {
  return loadReportFonts()
    .then(() => Promise.all(drawReportPages(table, title).map(canvasJpeg)))
    .then((images) => pdfFromJpegs(images, title));
}

// Emails the PDF to the company from the person's own Gmail, keeps a copy in their Drive, and marks the month sent
function deliverMonth({ month, T, pdf, sent, totals, lines, rates, tabId }) {
  const name = settings.full_name;
  const to = settings.company_email;
  const bcc = settings.bcc_email || ""; // the person's own copy, hidden from the company
  const monthName = monthLabel(month, T.locale);
  const corrected = !!sent;
  const sheetMoney = (n) => "₪" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); // as in the PDF
  const replaces = sent ? new Date(sent.sentAt).toLocaleDateString(T.locale, { day: "numeric", month: "long", year: "numeric" }) : "";
  const fileName = T.fileName(monthName, name, corrected).replace(/[\\/:*?"<>|]/g, "-");
  const email = {
    to,
    bcc,
    subject: T.emailSubject(monthName, name, corrected),
    paragraphs: T.emailBody({ month: monthName, salary: sheetMoney(totals.salary), expenses: sheetMoney(totals.expenses), name, replaces }).filter(Boolean),
    rtl: T === REPORT_TEXT.he,
    pdf,
    fileName,
    asciiName: "shift-report-" + monthTabTitle(month) + (corrected ? "-corrected" : "") + ".pdf",
  };
  return sendEmail(email)
    .catch((err) => {
      throw new Error(L.errSend + ": " + err.message);
    })
    // The email is what counts: a copy that fails to save doesn't undo it
    .then(() => saveReportCopy(pdf, fileName, monthTabTitle(month)).catch(forgetFolder))
    .then((copy) =>
      saveSentInfo({
        sentAt: new Date().toISOString(),
        to,
        rates,
        fingerprint: monthFingerprint(lines),
        pdfId: (copy && copy.id) || null,
        corrections: sent ? (sent.corrections || 0) + 1 : 0,
        open: false,
        metadataId: sent ? sent.metadataId : undefined,
        tabId,
      }).catch((err) => {
        throw new Error(L.errMark + ": " + err.message);
      })
    )
    .then(() => to);
}

// Bytes to base64, in slices so a large PDF can't overflow the call stack
function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// The email as MIME: the text as plain and as HTML (right to left for a Hebrew report), and the PDF attached.
// Everything that isn't ASCII travels base64-encoded, headers included, so Hebrew arrives intact.
function sendEmail({ to, bcc, subject, paragraphs, rtl, pdf, fileName, asciiName }) {
  const utf8 = (s) => toBase64(new TextEncoder().encode(s));
  const wrap = (b64) => b64.replace(/.{76}(?=.)/g, "$&\r\n");
  const word = (s) => "=?UTF-8?B?" + utf8(s) + "?=";
  // RFC 2047: a header in any language, as encoded words short enough for every mail client
  const header = (s) => {
    const chars = Array.from(s);
    const words = [];
    for (let i = 0; i < chars.length; i += 15) words.push(word(chars.slice(i, i + 15).join("")));
    return words.join("\r\n ");
  };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html =
    '<div dir="' + (rtl ? "rtl" : "ltr") + '" style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5">' +
    paragraphs.map((p) => "<p>" + esc(p).replace(/\n/g, "<br>") + "</p>").join("") +
    "</div>";
  // RFC 2231: the attachment's name in any language, plus a plain-ASCII name for older mail clients
  const encodedName = encodeURIComponent(fileName).replace(/['()*!]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return pdf.arrayBuffer().then((buffer) => {
    const mixed = "=_sb_mixed_" + Date.now().toString(36);
    const alt = "=_sb_alt_" + Date.now().toString(36);
    const mime = [
      "To: " + to,
      ...(bcc ? ["Bcc: " + bcc] : []), // Gmail strips this from what the company receives
      "Subject: " + header(subject),
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="' + mixed + '"',
      "",
      "--" + mixed,
      'Content-Type: multipart/alternative; boundary="' + alt + '"',
      "",
      "--" + alt,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrap(utf8(paragraphs.join("\n\n").replace(/\n/g, "\r\n"))),
      "--" + alt,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrap(utf8(html)),
      "--" + alt + "--",
      "--" + mixed,
      'Content-Type: application/pdf; name="' + word(fileName) + '"',
      'Content-Disposition: attachment; filename="' + asciiName + "\"; filename*=UTF-8''" + encodedName,
      "Content-Transfer-Encoding: base64",
      "",
      wrap(toBase64(new Uint8Array(buffer))),
      "--" + mixed + "--",
      "",
    ].join("\r\n");
    const raw = btoa(mime).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return jsonRequest(GMAIL_SEND, "POST", { raw });
  });
}

// A copy of what was sent, in a "ShiftBoard" folder in the person's Drive
function saveReportCopy(pdf, fileName, month) {
  return reportsFolder().then((folderId) => {
    const boundary = "=_sb_upload_" + Date.now().toString(36);
    const meta = { name: fileName, mimeType: "application/pdf", parents: [folderId], appProperties: { shiftboard: "report", month } };
    const body = new Blob([
      "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + JSON.stringify(meta) + "\r\n",
      "--" + boundary + "\r\nContent-Type: application/pdf\r\n\r\n",
      pdf,
      "\r\n--" + boundary + "--\r\n",
    ]);
    return apiFetch(DRIVE_UPLOAD + "?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { "Content-Type": 'multipart/related; boundary="' + boundary + '"' },
      body,
    }).then((r) => r.json());
  });
}

function reportsFolder() {
  if (reportsFolderId) return Promise.resolve(reportsFolderId);
  const q = encodeURIComponent("appProperties has { key='shiftboard' and value='reports' } and mimeType='application/vnd.google-apps.folder' and trashed=false");
  return jsonGet(DRIVE_FILES + "?q=" + q + "&fields=files(id)")
    .then((data) =>
      data.files && data.files.length
        ? data.files[0].id
        : jsonRequest(DRIVE_FILES + "?fields=id", "POST", { name: "ShiftBoard", mimeType: "application/vnd.google-apps.folder", appProperties: { shiftboard: "reports" } }).then(
            (folder) => folder.id
          )
    )
    .then((id) => {
      reportsFolderId = id;
      localStorage.setItem("sb_folderId", id);
      return id;
    });
}

// A folder deleted by hand is found or made again next time
function forgetFolder() {
  reportsFolderId = null;
  localStorage.removeItem("sb_folderId");
  return null;
}

// Last month has shifts but wasn't sent: a nudge on the board (only once the pay sheet is set up on this device)
function checkUnsentLastMonth(items) {
  const btn = el("sendReminderBtn");
  btn.hidden = true;
  if (!hasDrive() || !sheetId) return;
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prefix = monthTabTitle(last) + "-";
  if (!items.some((event) => workTypeOf(event) && (eventDate(event) || "").startsWith(prefix))) return;
  loadTabs()
    .then(() => {
      const sent = sentInfo(last);
      if (sent && !sent.open) return;
      btn.textContent = L.unsentReminder(monthLabel(last));
      btn.hidden = false;
      // One red banner at a time, and this is the one that costs money. The missing times may not even
      // be in the month that's owed, and following this nudge lands on the Pay view, which says so itself.
      el("needsTimesBtn").hidden = true;
    })
    .catch(() => {}); // only a reminder: the Pay tab reports problems properly
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
      checkUnsentLastMonth(items);
    })
    .catch(() => {}); // the board already reports loading problems
}

function openMissingTimes() {
  const panel = openPanel(L.missingTitle);
  missingTimes.forEach(({ ds, type, event }) => {
    const form = shiftForm(ds, type, event);
    form.dataset.keepOpen = "1";
    form.querySelector("h3").textContent =
      L.types[type] + " · " + new Date(ds + "T00:00").toLocaleDateString(dateLocale(), { weekday: "short", month: "short", day: "numeric" });
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
        entry.eventIds.forEach((id) => tasks.push(deleteEvent(id, ds, type)));
      }
    });
  });

  if (tasks.length === 0) return;

  saving = true;
  updateSaveState();

  Promise.allSettled(tasks).then((results) => {
    saving = false;
    const failures = results.filter((r) => r.status === "rejected");
    const waiting = results.filter((r) => r.value && r.value.drafted).length;
    if (failures.length) {
      showApiError(L.changesFailed(failures.length), failures[0].reason);
    } else {
      showToast(waiting ? L.draftKept : L.savedCalendar); // nothing reached the calendar if it was drafted
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
  return sendOrDraft(
    eventId ? eventsUrl(eventId) : eventsUrl(),
    {
      method: eventId ? "PATCH" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    { ds: dateStr(start), type, kind: "times" }
  ).then((r) => r.json());
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

  return sendOrDraft(
    "https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(selectedCalendarId) + "/events",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    { ds, type, kind: "add" }
  );
}

function deleteEvent(eventId, ds, type) {
  return sendOrDraft(
    "https://www.googleapis.com/calendar/v3/calendars/" +
      encodeURIComponent(selectedCalendarId) +
      "/events/" +
      eventId,
    { method: "DELETE" },
    { ds, type, kind: "remove" }
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

// ---------- Working offline ----------

// The service worker is what lets someone open ShiftBoard on a site with no signal, and what makes the
// phone offer to install it. Browsers only allow one on a secure page, so a file:// preview or an older
// browser simply carries on without one — nothing else in the app depends on it.
const secureEnough =
  typeof location !== "undefined" &&
  (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1");

if (typeof navigator !== "undefined" && navigator.serviceWorker && secureEnough) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

// The browser says the moment the signal goes and comes back. Nothing is reloaded behind someone's back
// while they're offline, but the board and the open month catch up by themselves once there's a connection.
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("offline", () => showOffline(true));
  window.addEventListener("online", () => {
    showOffline(false);
    if (!accessToken) return;
    showToast(L.backOnline);
    loadWeeks(weeks);
    if (!el("payView").hidden) renderPayMonth();
    offerDrafts();
  });
  showOffline(isOffline());
}
