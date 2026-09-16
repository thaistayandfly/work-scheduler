// Usage: node verify-flow.js <app.js>
// Drives the real app.js through sign-in, the multi-week board, saving, deleting, sign-out and reloads
// against a fake DOM and a fake Google Calendar API, and prints PASS/FAIL per behaviour.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const src = fs.readFileSync(process.argv[2], "utf8");
const i18n = fs.readFileSync(path.join(path.dirname(process.argv[2]), "i18n.js"), "utf8");
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

// ---------- tiny fake DOM ----------
class FakeEl {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.attrs = {};
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.html = "";
    const self = this;
    this.classList = {
      contains: (c) => self.className.split(" ").includes(c),
      toggle(c, on) {
        const set = new Set(self.className.split(" ").filter(Boolean));
        if (on === undefined ? !set.has(c) : on) set.add(c);
        else set.delete(c);
        self.className = [...set].join(" ");
      },
    };
  }
  set innerHTML(v) {
    this.html = v;
    if (v === "") this.children = [];
  }
  get innerHTML() {
    return this.html;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  appendChild(c) {
    this.children.push(c);
    return c;
  }
  insertBefore(c, ref) {
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(c);
    else this.children.splice(i, 0, c);
    return c;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  fire(type) {
    (this.listeners[type] || []).forEach((fn) => fn({ target: this }));
  }
  querySelectorAll(sel) {
    const match = sel === "[data-type]" ? (c) => c.dataset.type !== undefined : (c) => c.classList.contains(sel.slice(1));
    const out = [];
    const walk = (el) =>
      el.children.forEach((c) => {
        if (match(c)) out.push(c);
        walk(c);
      });
    walk(this);
    return out;
  }
}

// ---------- fake Google ----------
const store = {}; // survives "reloads", like real localStorage
const TOKEN = "tok-1";
const ME = "me@example.com";
const TEAM = "team@example.com";
const calendarList = [
  // Listed first on purpose: the API doesn't promise the main calendar comes first
  { id: "en.th#holiday@group.v.calendar.google.com", summary: "Holidays in Thailand", accessRole: "reader" },
  { id: ME, summary: ME, accessRole: "owner", primary: true },
  { id: TEAM, summary: "Team shifts", accessRole: "writer" },
];

// This week's calendar before the app touches it, like a real one: events from the first
// (Apps Script) version or typed by hand have no hidden tag
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const monday = (() => {
  const d = new Date();
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  d.setHours(0, 0, 0, 0);
  return d;
})();
const weekDay = (i, hour = 0) => new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i, hour);
const allDay = (id, i, summary) => ({ id, calId: ME, summary, start: { date: ymd(weekDay(i)) }, end: { date: ymd(weekDay(i + 1)) } });
let events = [
  allDay("seed-thu-warehouse", 3, "Warehouse"),
  allDay("seed-thu-dentist", 3, "Dentist"),
  allDay("seed-fri-event-1", 4, "Event"),
  allDay("seed-fri-event-2", 4, "event "),
  { id: "seed-sat-timed", calId: ME, summary: "Work: Event",
    start: { dateTime: weekDay(5, 9).toISOString() }, end: { dateTime: weekDay(5, 17).toISOString() } },
];
const appEvents = () => events.filter((e) => e.id.startsWith("ev"));
let nextId = 1;
let failInsertOn = null;

function reply(status, body) {
  return Promise.resolve({
    status,
    ok: status >= 200 && status < 300,
    statusText: "",
    json: () => (body === undefined ? Promise.reject(new SyntaxError("no body")) : Promise.resolve(body)),
  });
}

function fakeFetch(url, opts = {}) {
  const u = new URL(url);
  const method = opts.method || "GET";
  if ((opts.headers || {}).Authorization !== "Bearer " + TOKEN) return reply(401, { error: { message: "Invalid Credentials" } });
  if (u.pathname === "/oauth2/v3/userinfo") return reply(200, { email: ME });
  if (u.pathname.endsWith("/users/me/calendarList")) return reply(200, { items: calendarList });
  const m = u.pathname.match(/\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
  const calId = decodeURIComponent(m[1]);
  if (method === "POST") {
    if (!calendarList.some((c) => c.id === calId && c.accessRole !== "reader")) {
      return reply(403, { error: { message: "You need to have writer access to this calendar." } });
    }
    const body = JSON.parse(opts.body);
    if (body.start.date === failInsertOn) return reply(503, { error: { message: "Backend Error" } });
    const ev = Object.assign({ id: "ev" + nextId++, calId }, body);
    events.push(ev);
    return reply(200, ev);
  }
  if (method === "DELETE") {
    const before = events.length;
    events = events.filter((e) => !(e.id === m[2] && e.calId === calId));
    return events.length < before ? reply(204) : reply(404, { error: { message: "Not Found" } });
  }
  let items = events.filter((e) => e.calId === calId);
  const filter = u.searchParams.get("privateExtendedProperty"); // same filter the real API applies
  if (filter) {
    const [k, v] = filter.split("=");
    items = items.filter((e) => e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private[k] === v);
  }
  return reply(200, { items });
}

// ---------- boot the app (a fresh page load each time) ----------
let tokenCfg = null;
let lastRequest = null;
let confirmCalls = 0;
let reloads = 0;
const session = {}; // sessionStorage, which also survives a reload
const errors = [];

function boot() {
  const dom = {};
  ["signInBtn", "signOutBtn", "account", "accountEmail", "welcome", "workspace", "calendarSelect", "newCalendarBtn",
    "calendarEmpty", "earlierBtn", "board", "moreWeeksBtn", "saveBar", "statusText", "saveBtn", "toast", "needsTimesBtn", "dayPanel", "boardHint", "viewTabs", "tabShifts", "tabPay", "payView", "driveConnect",
    "connectDriveBtn", "payContent", "prevMonth", "nextMonth", "settingsForm", "writeSheetBtn", "openSheetLink", "langBtn", "sendBtn", "reopenBtn", "useRatesBtn", "sendReminderBtn",
    "sendStatus", "sentPdfLink"].forEach((id) => (dom[id] = new FakeEl("div")));
  dom.root = new FakeEl("html");
  ["account", "workspace", "saveBar", "calendarEmpty", "toast", "needsTimesBtn", "viewTabs", "payView", "driveConnect", "payContent"]
    .forEach((id) => (dom[id].hidden = true)); // as in index.html
  const winListeners = {};
  const ctx = vm.createContext({
    console: { log() {}, error: (...a) => errors.push(a.map((x) => (x && x.message) || String(x)).join(" ")) },
    URLSearchParams,
    fetch: fakeFetch,
    setTimeout: () => 0,
    clearTimeout() {},
    confirm: () => (confirmCalls++, false),
    prompt: () => null,
    GOOGLE_CLIENT_ID: "test",
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => (store[k] = String(v)),
      removeItem: (k) => delete store[k],
    },
    sessionStorage: {
      getItem: (k) => (k in session ? session[k] : null),
      setItem: (k, v) => (session[k] = String(v)),
      removeItem: (k) => delete session[k],
    },
    navigator: { language: "en-US" },
    location: { reload: () => reloads++ },
    document: {
      body: new FakeEl("body"),
      documentElement: dom.root,
      getElementById: (id) => dom[id],
      createElement: (tag) => new FakeEl(tag),
      querySelectorAll: () => [], // index.html's own words aren't part of this fake page
    },
    addEventListener: (type, fn) => (winListeners[type] = fn),
    google: {
      accounts: {
        oauth2: {
          initTokenClient: (cfg) => ((tokenCfg = cfg), { requestAccessToken: (o) => (lastRequest = o) }),
          hasGrantedAllScopes: (resp, ...scopes) => scopes.every((s) => resp.scope.split(" ").includes(s)),
        },
      },
    },
  });
  ctx.window = ctx;
  vm.runInContext(i18n, ctx);
  vm.runInContext(src, ctx);
  winListeners.load();
  return dom;
}

const signInCallback = () =>
  tokenCfg.callback({ access_token: TOKEN, expires_in: 3599, scope: "email https://www.googleapis.com/auth/calendar" });
const rows = (dom) => dom.board.querySelectorAll(".day");
const dayNum = (row) => Number(/dnum">(\d+)</.exec(row.children[0].html)[1]);
const btn = (row, type) => row.querySelectorAll("[data-type]").find((b) => b.dataset.type === type);
const isOn = (row, type) => !!row && btn(row, type).classList.contains("is-on");
const save = async (dom) => {
  dom.saveBtn.fire("click");
  await flush();
};

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });

(async () => {
  // First visit
  let dom = boot();
  await flush();
  check("Signed out: welcome shown, board hidden", !dom.welcome.hidden && dom.workspace.hidden && dom.saveBar.hidden,
    "welcome.hidden=" + dom.welcome.hidden + " workspace.hidden=" + dom.workspace.hidden);
  dom.signInBtn.fire("click");
  check("Sign-in only shows the consent screen when needed", lastRequest && lastRequest.prompt === "",
    "prompt=" + JSON.stringify(lastRequest && lastRequest.prompt));
  signInCallback();
  await flush();
  const options = dom.calendarSelect.children.map((o) => o.textContent);
  check("Defaults to the main calendar, read-only ones hidden",
    dom.calendarSelect.value === ME && options.length === 2 && !options.some((o) => /Holidays/.test(o)),
    "selected=" + dom.calendarSelect.value + " options=" + JSON.stringify(options));
  let r = rows(dom);
  check("Board shows this week and the next three", dom.board.children.length === 4 && r.length === 28 && r[0].dataset.date === ymd(monday),
    "weeks=" + dom.board.children.length + " rows=" + r.length + " first=" + (r[0] && r[0].dataset.date));
  check("Signed-in email is shown", dom.accountEmail.textContent === ME && !dom.account.hidden,
    "email=" + JSON.stringify(dom.accountEmail.textContent));

  let [mon, tue, wed, thu, fri, sat] = r;
  check("Existing events show as selected (untagged, lowercase, timed)",
    isOn(thu, "Warehouse") && isOn(fri, "Event") && isOn(sat, "Event") && dom.statusText.textContent === "No unsaved changes",
    "thu Warehouse=" + isOn(thu, "Warehouse") + " fri Event=" + isOn(fri, "Event") + " sat Event=" + isOn(sat, "Event") + " status=" + JSON.stringify(dom.statusText.textContent));
  check("Tapes are announced as pressed / not pressed",
    btn(thu, "Warehouse").getAttribute("aria-pressed") === "true" && btn(thu, "Event").getAttribute("aria-pressed") === "false" && !btn(thu, "Event").disabled,
    "aria-pressed=" + btn(thu, "Warehouse").getAttribute("aria-pressed") + "/" + btn(thu, "Event").getAttribute("aria-pressed"));
  check("Unrelated events (\"Dentist\") don't select anything", !isOn(thu, "Event"), "thu Event=" + isOn(thu, "Event"));

  // Tap shifts in week 1 and week 3 (no prompts), then save; Wednesday's insert fails on Google's side
  const wk3 = r[14];
  failInsertOn = wed.dataset.date;
  btn(mon, "Event").fire("click");
  btn(tue, "Warehouse").fire("click");
  btn(wed, "Event").fire("click");
  btn(wk3, "Warehouse").fire("click");
  check("Unsaved shifts are counted across weeks, with no prompts", dom.statusText.textContent === "4 to add" && confirmCalls === 0,
    "status=" + JSON.stringify(dom.statusText.textContent) + " confirmCalls=" + confirmCalls);
  await save(dom);
  check("A failed save is reported with Google's reason", /couldn't be saved: Backend Error/.test(dom.toast.textContent),
    "toast=" + JSON.stringify(dom.toast.textContent));
  const created = appEvents();
  check("Events land on the days that were tapped, in any week",
    created.length === 3 && created[0].start.date === mon.dataset.date && +created[0].start.date.slice(8) === dayNum(mon) &&
      created[1].start.date === tue.dataset.date && created[2].start.date === wk3.dataset.date,
    "calendar " + JSON.stringify(created.map((e) => e.start.date)));
  check("Saved events are titled just Event / Warehouse",
    JSON.stringify(created.map((e) => e.summary)) === JSON.stringify(["Event", "Warehouse", "Warehouse"]),
    "titles=" + JSON.stringify(created.map((e) => e.summary)));
  check("The failed day stays pending so it can be retried",
    isOn(wed, "Event") && dom.statusText.textContent === "1 to add" && !dom.saveBtn.disabled,
    "status=" + JSON.stringify(dom.statusText.textContent));

  failInsertOn = null;
  await save(dom);
  check("Retrying saves it", dom.toast.textContent === "Saved to Google Calendar" && appEvents().length === 4 && dom.saveBtn.textContent === "Save to Calendar",
    "toast=" + JSON.stringify(dom.toast.textContent) + " app events=" + appEvents().length);

  btn(mon, "Event").fire("click");
  check("Removing a saved shift is counted", dom.statusText.textContent === "1 to remove",
    "status=" + JSON.stringify(dom.statusText.textContent));
  await save(dom);
  check("After deleting, nothing is left marked unsaved",
    appEvents().length === 3 && dom.statusText.textContent === "No unsaved changes" && dom.saveBtn.disabled,
    "status=" + JSON.stringify(dom.statusText.textContent) + " app events=" + appEvents().length);

  // Friday has "Event" twice; turning it off must remove both, or it would pop back on
  btn(fri, "Event").fire("click");
  await save(dom);
  const friLeft = events.filter((e) => e.id.startsWith("seed-fri")).map((e) => e.id);
  check("Turning a type off removes duplicate events too",
    friLeft.length === 0 && !isOn(fri, "Event") && dom.statusText.textContent === "No unsaved changes",
    "left=" + JSON.stringify(friLeft) + " fri Event=" + isOn(fri, "Event"));
  check("Unrelated events are never deleted", events.some((e) => e.id === "seed-thu-dentist"), "Dentist event is gone");

  // More weeks, and the week before
  dom.moreWeeksBtn.fire("click");
  await flush();
  dom.earlierBtn.fire("click");
  await flush();
  r = rows(dom);
  check("\"Show 4 more weeks\" and \"Show the week before\" work",
    dom.board.children.length === 9 && r.length === 63 && r[0].dataset.date === ymd(weekDay(-7)) && !btn(r[0], "Event").disabled && !btn(r[62], "Event").disabled,
    "weeks=" + dom.board.children.length + " rows=" + r.length + " first=" + (r[0] && r[0].dataset.date));

  // Switch calendar with an unsaved shift; the user answers "Cancel"
  btn(r[10], "Event").fire("click");
  dom.calendarSelect.value = TEAM;
  dom.calendarSelect.fire("change");
  check("Switching calendars with unsaved shifts asks first",
    confirmCalls === 1 && dom.calendarSelect.value === ME && isOn(rows(dom)[10], "Event") && dom.statusText.textContent === "1 to add",
    "confirmCalls=" + confirmCalls + " selected=" + dom.calendarSelect.value);

  // Reload the page
  dom = boot();
  await flush();
  check("Reload: still signed in, no sign-in click", !dom.workspace.hidden && dom.welcome.hidden,
    "workspace.hidden=" + dom.workspace.hidden + " welcome.hidden=" + dom.welcome.hidden);
  r = rows(dom);
  check("Reload: the calendar's days are shown",
    isOn(r[1], "Warehouse") && isOn(r[2], "Event") && isOn(r[3], "Warehouse") && isOn(r[5], "Event") && isOn(r[14], "Warehouse") &&
      !isOn(r[0], "Event") && !isOn(r[4], "Event"),
    "rows=" + r.length);

  // Reload after the token has expired
  store.sb_token = JSON.stringify({ accessToken: TOKEN, expiresAt: Date.now() - 1000 });
  lastRequest = null;
  dom = boot();
  await flush();
  dom.signInBtn.fire("click");
  check("Expired token: one-click sign-in for the same account",
    !dom.welcome.hidden && lastRequest && lastRequest.prompt === "" && lastRequest.login_hint === ME,
    "request=" + JSON.stringify(lastRequest));

  // Sign out
  signInCallback();
  await flush();
  dom.signOutBtn.fire("click");
  check("Sign out shows the welcome screen and forgets the account",
    !dom.welcome.hidden && dom.workspace.hidden && !("sb_token" in store) && !("sb_email" in store) && dom.board.children.length === 0,
    "welcome.hidden=" + dom.welcome.hidden + " stored=" + JSON.stringify(Object.keys(store)));

  // Language: the switch names the other language, remembers the choice and reloads the page in it
  check("The language switch offers Hebrew, in Hebrew", dom.root.dir === "ltr" && dom.langBtn.textContent === "עברית" && dom.langBtn.lang === "he",
    "dir=" + dom.root.dir + " button=" + dom.langBtn.textContent);
  dom.langBtn.fire("click");
  check("Switching language remembers it and reloads", store.sb_lang === "he" && reloads === 1, "sb_lang=" + store.sb_lang + " reloads=" + reloads);
  dom = boot();
  await flush();
  signInCallback();
  await flush();
  r = rows(dom);
  check("After the reload the app is Hebrew and right to left, still signed in",
    dom.root.lang === "he" && dom.root.dir === "rtl" && !dom.workspace.hidden && dom.statusText.textContent === "אין שינויים שלא נשמרו" &&
      btn(r[0], "Event").html.includes("אירוע") && dom.langBtn.textContent === "English",
    "dir=" + dom.root.dir + " status=" + JSON.stringify(dom.statusText.textContent));
  btn(r[0], "Event").fire("click");
  check("Unsaved shifts are counted in Hebrew", dom.statusText.textContent === "1 להוספה", "status=" + JSON.stringify(dom.statusText.textContent));
  const asked = confirmCalls;
  dom.langBtn.fire("click");
  check("Switching language with unsaved shifts asks first; Cancel stays put",
    confirmCalls === asked + 1 && store.sb_lang === "he" && reloads === 1 && isOn(r[0], "Event"),
    "confirmCalls=" + confirmCalls + " sb_lang=" + store.sb_lang + " reloads=" + reloads);
  delete store.sb_lang;

  for (const res of results) console.log((res.ok ? "  PASS  " : "  FAIL  ") + res.name + (res.ok ? "" : "   [" + res.detail + "]"));
  if (errors.length) console.log("  console.error:", errors.slice(0, 3));
})();
