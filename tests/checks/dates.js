// Usage: node verify-dates.js <app.js>
// Loads the real app.js with browser stubs, then checks that every day card maps to its own
// calendar date, that the inserted all-day event spans exactly that day, and the "today" highlight.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const store = {};
const ctx = vm.createContext({
  console,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  window: { addEventListener() {} },
  navigator: { language: "en-US" },
  document: { documentElement: {}, querySelectorAll: () => [], getElementById: () => ({}) },
  localStorage: {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => (store[k] = String(v)),
    removeItem: (k) => delete store[k],
  },
});
vm.runInContext(fs.readFileSync(path.join(path.dirname(process.argv[2]), "i18n.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(process.argv[2], "utf8"), ctx);
let body = null;
ctx.apiFetch = (url, opts) => ((body = JSON.parse(opts.body)), Promise.resolve());

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const problems = [];
let checked = 0;
// A normal week, the week EU clocks go back (Sun 25 Oct), and the week US clocks go back (Sun 1 Nov)
for (const now of [new Date(2026, 8, 14, 10), new Date(2026, 9, 21, 10), new Date(2026, 9, 28, 10)]) {
  const mon = ctx.weekStart(now);
  for (let i = 0; i < 7; i++) {
    const d = new Date(mon);
    d.setDate(d.getDate() + i);
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    ctx.insertEvent(ctx.dateStr(d), "Event");
    checked++;
    if (body.start.date !== ymd(d) || body.end.date !== ymd(next)) {
      problems.push(d.toDateString() + " card -> event " + body.start.date + " .. " + body.end.date);
    }
  }
  checked++;
  if (ctx.dateStr(now) !== ymd(now)) problems.push("today=" + ymd(now) + " but highlight key is " + ctx.dateStr(now));
}

const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const off = -new Date(2026, 8, 14).getTimezoneOffset() / 60;
const where = tz + " (UTC" + (off >= 0 ? "+" : "") + off + ")";
if (problems.length) {
  console.log("  FAIL  " + problems.length + " of " + checked + " day cards land on the wrong date in " + where);
  problems.slice(0, 3).forEach((p) => console.log("        " + p));
  process.exitCode = 1;
} else {
  console.log("  PASS  Every day card maps to its own calendar date in " + where + " (" + checked + " checks)");
}
