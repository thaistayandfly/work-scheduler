const SCOPES = "https://www.googleapis.com/auth/calendar";
const APP_TAG = "shiftboard";
const WORK_TYPES = ["Event", "Warehouse"];

let tokenClient = null;
let accessToken = null;
let tokenExpiresAt = 0;

let calendars = [];
let selectedCalendarId = localStorage.getItem("sb_calendarId") || "primary";

let currentWeekStart = getMonday(new Date());
// daysState[dateStr][type] = { active, eventId, originalActive }
let daysState = {};

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
    tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
  });
  el("prevWeek").addEventListener("click", () => changeWeek(-7));
  el("nextWeek").addEventListener("click", () => changeWeek(7));
  el("newCalendarBtn").addEventListener("click", createNewCalendar);
  el("calendarSelect").addEventListener("change", (e) => {
    selectedCalendarId = e.target.value;
    localStorage.setItem("sb_calendarId", selectedCalendarId);
    loadEventsForWeek();
  });
  el("saveBtn").addEventListener("click", saveChanges);
});

function waitForGoogle(cb) {
  if (window.google && google.accounts && google.accounts.oauth2) cb();
  else setTimeout(() => waitForGoogle(cb), 100);
}

function onTokenReceived(resp) {
  if (resp.error) {
    showToast("Sign-in failed: " + resp.error, true);
    return;
  }
  accessToken = resp.access_token;
  tokenExpiresAt = Date.now() + (resp.expires_in || 3500) * 1000;

  el("signInBtn").textContent = "Signed in";
  el("signInBtn").disabled = true;
  el("controls").hidden = false;
  el("weekGrid").hidden = false;
  el("saveBar").hidden = false;
  el("emptyState").hidden = true;

  fetchUserEmail();
  loadCalendars();
}

function fetchUserEmail() {
  apiFetch("https://www.googleapis.com/oauth2/v3/userinfo")
    .then((r) => r.json())
    .then((info) => {
      if (info.email) {
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
    return r;
  });
}

function resetToSignedOut() {
  accessToken = null;
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
      calendars = data.items || [];
      const select = el("calendarSelect");
      select.innerHTML = "";
      calendars.forEach((cal) => {
        const opt = document.createElement("option");
        opt.value = cal.id;
        opt.textContent = cal.summary + (cal.primary ? " (main)" : "");
        select.appendChild(opt);
      });
      const stillExists = calendars.some((c) => c.id === selectedCalendarId);
      if (!stillExists) selectedCalendarId = calendars[0] ? calendars[0].id : "primary";
      select.value = selectedCalendarId;
      renderWeek();
    });
}

function createNewCalendar() {
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
    .catch(() => showToast("Couldn't create calendar", true));
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
  currentWeekStart.setDate(currentWeekStart.getDate() + deltaDays);
  renderWeek();
}

function dateStr(d) {
  return d.toISOString().slice(0, 10);
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
      Event: { active: false, eventId: null, originalActive: false },
      Warehouse: { active: false, eventId: null, originalActive: false },
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
  const start = new Date(currentWeekStart);
  start.setDate(start.getDate() - 1); // pad a day either side to dodge timezone edge effects on all-day events
  const end = new Date(currentWeekStart);
  end.setDate(end.getDate() + 8);

  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: "true",
    privateExtendedProperty: "appTag=" + APP_TAG,
  });

  const url =
    "https://www.googleapis.com/calendar/v3/calendars/" +
    encodeURIComponent(selectedCalendarId) +
    "/events?" +
    params.toString();

  apiFetch(url)
    .then((r) => r.json())
    .then((data) => {
      if (data.error) {
        console.error("ShiftBoard: events.list error", data.error);
        showToast("Couldn't load events: " + data.error.message, true);
        return;
      }
      console.log("ShiftBoard: loaded", (data.items || []).length, "tagged event(s) for this week", data.items);
      (data.items || []).forEach((item) => {
        const ds = item.start && item.start.date;
        const type = item.extendedProperties && item.extendedProperties.private && item.extendedProperties.private.workType;
        if (ds && type && daysState[ds] && daysState[ds][type]) {
          daysState[ds][type].active = true;
          daysState[ds][type].eventId = item.id;
          daysState[ds][type].originalActive = true;
        }
      });
      syncPillsToState();
      updateSaveState();
    })
    .catch((err) => {
      console.error("ShiftBoard: loadEventsForWeek failed", err);
    });
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

function updateSaveState() {
  let dirty = false;
  Object.values(daysState).forEach((day) => {
    WORK_TYPES.forEach((type) => {
      if (day[type].active !== day[type].originalActive) dirty = true;
    });
  });
  el("saveBtn").disabled = !dirty;
  el("statusText").textContent = dirty ? "Unsaved changes" : "No changes yet";
}

function saveChanges() {
  const tasks = [];

  Object.entries(daysState).forEach(([ds, types]) => {
    WORK_TYPES.forEach((type) => {
      const entry = types[type];
      if (entry.active && !entry.originalActive) {
        tasks.push(insertEvent(ds, type));
      } else if (!entry.active && entry.originalActive && entry.eventId) {
        tasks.push(deleteEvent(entry.eventId));
      }
    });
  });

  if (tasks.length === 0) return;

  el("saveBtn").disabled = true;
  el("statusText").textContent = "Saving…";

  Promise.allSettled(tasks).then((results) => {
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed) {
      showToast(failed + " change(s) failed to save", true);
    } else {
      showToast("Saved");
    }
    loadEventsForWeek();
  });
}

function insertEvent(ds, type) {
  const end = new Date(ds);
  end.setDate(end.getDate() + 1);

  const body = {
    summary: "Work: " + type,
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