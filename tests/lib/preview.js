// Preview pages: the real index.html with Google's sign-in swapped for a fake Calendar, Drive, Sheets, Gmail
// and PDF export that live in memory, so every state of the app can be driven and checked without an account.
// Every write is recorded in window.__requests, window.__mail and window.__uploads, and the clock is fixed, so
// a check that names a month keeps passing next year. The app's language is set on every page load, so one
// page's choice never leaks into another's.
//
//   node tests/lib/preview.js [en|he]
const fs = require("fs");
const path = require("path");

const toUrl = (p) => "file:///" + p.replace(/\\/g, "/");

const SCENARIOS = ["signed-out", "loading", "loaded", "dirty", "error", "panel", "panel-filled", "panel-empty", "missing", "pay", "pay-connect", "pay-settings", "reminder", "offline-start"];

function stub(scenario, lang) {
  return `<script>
(function () {
  var scenario = ${JSON.stringify(scenario)};
  // A fixed clock: checks that name a month keep passing next year
  (function () {
    var Real = Date;
    var fixed = new Real(2026, 8, 16, 10, 0, 0).getTime();
    function Fixed(a, b, c, d, e, f, g) {
      switch (arguments.length) {
        case 0: return new Real(fixed);
        case 1: return new Real(a);
        case 2: return new Real(a, b);
        case 3: return new Real(a, b, c);
        case 4: return new Real(a, b, c, d);
        case 5: return new Real(a, b, c, d, e);
        case 6: return new Real(a, b, c, d, e, f);
        default: return new Real(a, b, c, d, e, f, g);
      }
    }
    Fixed.now = function () { return fixed; };
    Fixed.parse = Real.parse;
    Fixed.UTC = Real.UTC;
    Fixed.prototype = Real.prototype;
    window.Date = Fixed;
  })();
  window.__ready = false;
  window.__requests = [];
  window.__mail = [];
  window.__uploads = [];
  window.__grants = [];
  window.google = { accounts: { oauth2: {
    initTokenClient: function (cfg) {
      return { requestAccessToken: function (opts) {
        // Like Google: what's asked for now plus what was granted before
        var scope = "email https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive.file";
        if (opts && opts.scope && opts.scope.indexOf("gmail.send") > -1) scope += " https://www.googleapis.com/auth/gmail.send";
        window.__grants.push((opts && opts.scope) || "");
        cfg.callback({ access_token: "demo", expires_in: 3599, scope: scope });
      } };
    },
    hasGrantedAllScopes: function () { return true; }
  } } };
  try {
    localStorage.clear();
    localStorage.setItem("sb_lang", ${JSON.stringify(lang)});
    if (scenario !== "signed-out") {
      var scope = "https://www.googleapis.com/auth/calendar email" + (scenario === "pay-connect" ? "" : " https://www.googleapis.com/auth/drive.file");
      localStorage.setItem("sb_token", JSON.stringify({ accessToken: "demo", expiresAt: Date.now() + 3600e3, scope: scope }));
    }
    if (scenario === "reminder") localStorage.setItem("sb_sheetId", "sheet1"); // this device already knows the pay sheet
  } catch (e) {}
  function pad(n) { return String(n).padStart(2, "0"); }
  var mon = new Date();
  mon.setHours(0, 0, 0, 0);
  mon.setDate(mon.getDate() + (mon.getDay() === 0 ? -6 : 1 - mon.getDay()));
  function day(i) { var d = new Date(mon); d.setDate(d.getDate() + i); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function at(i, h, m) { var d = new Date(mon); d.setDate(d.getDate() + i); d.setHours(h, m || 0, 0, 0); return d.toISOString(); }
  function tag(type, extra) { return { private: Object.assign({ appTag: "shiftboard", workType: type }, extra || {}) }; }
  var events = [
    { id: "a", summary: "Event", start: { date: day(0) }, end: { date: day(1) } },
    { id: "b", summary: "Warehouse", start: { dateTime: at(1, 9) }, end: { dateTime: at(1, 17, 30) } },
    { id: "o", summary: "Other – Move speakers", start: { dateTime: at(1, 18) }, end: { dateTime: at(1, 20) },
      extendedProperties: tag("Other", { amount: "300", note: "Move speakers" }) },
    { id: "c", summary: "Event", start: { date: day(3) } },
    { id: "d", summary: "Warehouse", start: { date: day(3) } },
    { id: "e", summary: "Warehouse", start: { date: day(4) } },
    { id: "f", summary: "Event", start: { date: day(8) } },
    { id: "g", summary: "Event", start: { date: day(9) } },
    { id: "h", summary: "Event", start: { dateTime: at(-3, 6) }, end: { dateTime: at(-2, 4) },
      extendedProperties: tag("Event", { slept: "1", expenses: '[{"type":"Travel","amount":250},{"type":"Food","amount":120}]' }) },
    { id: "i", summary: "Warehouse", start: { date: day(-5) } },
    { id: "j", summary: "Event", start: { date: day(-20) } }
  ];
  // Opening with no signal: the phone already knows the calendar and this week's shifts from last time
  if (scenario === "offline-start") {
    var cal = "me@example.com";
    var first = new Date(mon);
    first.setDate(first.getDate() - ${lang === "he" ? 1 : 0}); // a Hebrew week starts on Sunday
    var firstKey = first.getFullYear() + "-" + pad(first.getMonth() + 1) + "-" + pad(first.getDate());
    var thisWeek = {};
    thisWeek[firstKey] = events.slice(0, 3);
    try {
      localStorage.setItem("sb_calendarId", cal);
      localStorage.setItem("sb_calendars", JSON.stringify([{ id: cal, summary: "alex.morgan.shifts@example.com", primary: true }]));
      localStorage.setItem("sb_shifts_" + cal, JSON.stringify({ at: new Date(2026, 8, 15, 20, 30).getTime(), weeks: thisWeek }));
    } catch (e) {}
  }
  window.__tabs = [{ properties: { sheetId: 0, title: "Settings" }, developerMetadata: [] }];
  window.__tabValues = {};
  window.__nextId = 100;
  window.__settingsRows = [
    ["הגדרות"], [],
    ["שם מלא", "אלכס מורגן", "full_name"],
    ["מייל החברה", "shifts@example.co.il", "company_email"],
    ["לשלוח עותק גם אל", "alex.morgan.shifts@example.com", "bcc_email"],
    ["שפת הדוח", "עברית", "report_language"], [],
    ["מחסן, לשעה (₪)", "55", "rate_warehouse"],
    ["אירוע, ליום (₪)", "600", "rate_event"],
    ["שעה נוספת באירוע (₪)", "70", "rate_extra"],
    ["לינה בעבודה (₪)", "200", "rate_night"]
  ];
  function reply(body, status) {
    return Promise.resolve(new Response(body === null ? null : JSON.stringify(body), {
      status: status || 200, headers: { "Content-Type": "application/json" }
    }));
  }
  var realFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    url = String(url);
    if (/^(blob|data):/.test(url)) return realFetch(url, opts); // the page's own files, e.g. reading a drawn PDF back
    // Opened with no signal at all: every request fails the way one does when it never leaves the phone
    if (scenario === "offline-start") return Promise.reject(new TypeError("Failed to fetch"));
    var method = (opts && opts.method) || "GET";
    if (method !== "GET") window.__requests.push({ url: url, method: method, body: (opts && opts.body) || null });
    // Google's PDF of a tab, Gmail, and uploads to Drive
    if (url.indexOf("docs.google.com/spreadsheets") > -1) {
      window.__requests.push({ url: url, method: "GET", body: null });
      return Promise.resolve(new Response(new Blob(["%PDF-1.4 ShiftBoard preview %%EOF"], { type: "application/pdf" }), { status: 200 })); // no backslashes: this sits in a template string
    }
    if (url.indexOf("gmail.googleapis.com") > -1) {
      window.__mail.push(JSON.parse(opts.body));
      return reply({ id: "msg" + window.__mail.length });
    }
    if (url.indexOf("upload/drive/v3/files") > -1) {
      window.__uploads.push(opts.body);
      return reply({ id: "pdf" + window.__uploads.length });
    }
    // Fake Drive + Sheets: one existing pay sheet whose Settings tab lives in window.__settingsRows, and the reports folder
    if (url.indexOf("drive/v3/files") > -1) {
      if (method === "GET" && decodeURIComponent(url).indexOf("'reports'") > -1) return reply({ files: window.__folder ? [{ id: window.__folder }] : [] });
      if (method === "POST") { window.__folder = "folder1"; return reply({ id: "folder1" }); }
      return reply(method === "GET" ? { files: [{ id: "sheet1" }] } : {});
    }
    if (url.indexOf("sheets.googleapis.com") > -1) {
      var sb = opts && opts.body ? JSON.parse(opts.body) : null;
      var tabName = (decodeURIComponent(url).match(new RegExp("/values/'?([^'!:?]+)")) || [])[1]; // no backslashes: this sits in a template string
      if (url.indexOf("/values/") > -1) {
        if (tabName === "Settings") {
          if (method === "GET") return reply({ values: window.__settingsRows });
          window.__settingsRows = sb.values;
          return reply({});
        }
        if (url.indexOf(":clear") > -1) { window.__tabValues[tabName] = []; return reply({}); }
        if (method === "PUT") { window.__tabValues[tabName] = sb.values; return reply({}); }
        return reply({ values: window.__tabValues[tabName] || [] });
      }
      if (url.indexOf(":batchUpdate") > -1) {
        return reply({ replies: sb.requests.map(function (r) {
          if (r.addSheet) {
            var p = { sheetId: ++window.__nextId, title: r.addSheet.properties.title };
            window.__tabs.push({ properties: p, developerMetadata: [] });
            return { addSheet: { properties: p } };
          }
          if (r.createDeveloperMetadata) {
            var m = r.createDeveloperMetadata.developerMetadata;
            window.__tabs.forEach(function (t) {
              if (t.properties.sheetId === m.location.sheetId) t.developerMetadata.push({ metadataId: ++window.__nextId, metadataKey: m.metadataKey, metadataValue: m.metadataValue });
            });
          }
          if (r.updateDeveloperMetadata) {
            var mid = r.updateDeveloperMetadata.dataFilters[0].developerMetadataLookup.metadataId;
            window.__tabs.forEach(function (t) { t.developerMetadata.forEach(function (d) { if (d.metadataId === mid) d.metadataValue = r.updateDeveloperMetadata.developerMetadata.metadataValue; }); });
          }
          return {};
        }) });
      }
      if (method === "GET") return reply({ sheets: window.__tabs });
      if (method === "POST" && /spreadsheets$/.test(url)) return reply({ spreadsheetId: "sheet1" });
      return reply({});
    }
    if (url.indexOf("/userinfo") > -1) return reply({ email: "alex.morgan.shifts@example.com" });
    if (url.indexOf("/calendarList") > -1) return reply({ items: [
      { id: "me@example.com", summary: "alex.morgan.shifts@example.com", accessRole: "owner", primary: true },
      { id: "work", summary: "Work shifts", accessRole: "owner" }
    ] });
    var id = url.indexOf("/events/") > -1 ? decodeURIComponent(url.split("/events/")[1].split("?")[0]) : null;
    if (method === "POST") {
      if (scenario === "error") return reply({ error: { message: "You need to have writer access to this calendar." } }, 403);
      var created = JSON.parse(opts.body);
      created.id = "new-" + window.__requests.length;
      events.push(created);
      return reply(created);
    }
    if (method === "PATCH") {
      var ev = events.filter(function (e) { return e.id === id; })[0];
      if (!ev) return reply({ error: { message: "Not Found" } }, 404);
      var b = JSON.parse(opts.body);
      if (b.start) ev.start = { dateTime: b.start.dateTime };
      if (b.end) ev.end = { dateTime: b.end.dateTime };
      if (b.summary) ev.summary = b.summary;
      if (b.extendedProperties) {
        ev.extendedProperties = { private: Object.assign({}, (ev.extendedProperties || {}).private, b.extendedProperties.private) };
      }
      return reply(ev);
    }
    if (method === "DELETE") {
      events = events.filter(function (e) { return e.id !== id; });
      return reply(null, 204);
    }
    if (scenario === "loading") return new Promise(function () {});
    return reply({ items: events });
  };
  window.addEventListener("load", function () {
    setTimeout(function () {
      var pills = document.querySelectorAll("#board [data-type]");
      var labels = document.querySelectorAll("#board .day-label");
      var s = ${lang === "he" ? 1 : 0}; // a Hebrew week starts a day earlier, on Sunday
      var after = 0; // how much longer this scenario needs after its first taps
      if (scenario === "dirty" || scenario === "error") {
        if (pills[4 + 2 * s]) pills[4 + 2 * s].click();   // Wednesday · Event
        if (pills[11 + 2 * s]) pills[11 + 2 * s].click(); // Saturday · Warehouse
        if (pills[7 + 2 * s]) pills[7 + 2 * s].click();   // Thursday · Warehouse (saved, so this removes it)
        if (scenario === "error") {
          after = 500;
          setTimeout(function () { document.getElementById("saveBtn").click(); }, 100);
        }
      }
      if (scenario === "panel" && labels[0 + s]) labels[0 + s].click();        // Monday: an Event with no times yet
      if (scenario === "panel-filled" && labels[1 + s]) labels[1 + s].click(); // Tuesday: a timed Warehouse and an Other job
      if (scenario === "panel-empty" && labels[2 + s]) labels[2 + s].click();  // Wednesday: nothing saved
      if (scenario === "missing") document.getElementById("needsTimesBtn").click();
      if (scenario === "pay" || scenario === "pay-connect") document.getElementById("tabPay").click();
      if (scenario === "pay-settings") {
        document.getElementById("tabPay").click();
        after = 800;
        setTimeout(function () { document.getElementById("settingsBtn").click(); }, 500);
      }
      // Checks and screenshots wait for this instead of guessing how long the page needed
      setTimeout(function () { window.__ready = true; }, after);
    }, 400);
  });
})();
</script>`;
}

// Writes one page per scenario as <tag>-<scenario>.html, with every asset pointing back at the real app
function buildPreviews({ projectDir, outDir, tag = "en", lang = "en" }) {
  const src = fs.readFileSync(path.join(projectDir, "index.html"), "utf8");
  fs.mkdirSync(outDir, { recursive: true });
  return SCENARIOS.map((scenario) => {
    const html = src
      .replace(/<script[^>]*src="https:\/\/accounts\.google\.com\/gsi\/client"[^>]*><\/script>/, () => stub(scenario, lang))
      .replace(/(href|src)="(?!https?:|\/\/|#|data:|mailto:)([^"]+)"/g, (m, attr, rel) => attr + '="' + toUrl(path.join(projectDir, rel)) + '"');
    if (!html.includes("window.google = ")) throw new Error("Couldn't find the Google sign-in script tag to replace");
    const file = path.join(outDir, tag + "-" + scenario + ".html");
    fs.writeFileSync(file, html);
    return file;
  });
}

module.exports = { buildPreviews, SCENARIOS };

if (require.main === module) {
  const lang = process.argv[2] === "he" ? "he" : "en";
  const files = buildPreviews({
    projectDir: path.join(__dirname, "..", ".."),
    outDir: path.join(__dirname, "..", ".out"),
    tag: lang,
    lang,
  });
  console.log("wrote " + files.length + " " + lang + " pages into tests/.out");
}
