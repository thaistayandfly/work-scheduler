// node tests/run.js — every check ShiftBoard has.
// First the ones that run on their own (pay rules, the board's flow, dates), then the app itself in real
// Chrome against preview pages with Google faked. Exits non-zero if anything failed, so CI can stop a push.
const { spawnSync } = require("child_process");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { buildPreviews } = require("./lib/preview");
const { launch, fileUrl } = require("./lib/chrome");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, ".out");
const APP = path.join(ROOT, "app.js");

const CHECKS = [
  ["Pay rules, the report, the email and the PDF", "checks/pay.js"],
  ["The board: signing in, saving, languages", "checks/flow.js"],
  ["Dates in this time zone", "checks/dates.js"],
  ["Installing it, and working with no signal", "checks/offline.js"],
];

// [name, page script, preview page]
const IN_PAGE = [
  ["A day's panel: times, nights, expenses, Other jobs", "phase1.js", "en-loaded.html"],
  ["The Pay tab", "pay.js", "en-pay.html"],
  ["Writing a month into the pay sheet", "sheet.js", "en-pay.html"],
  ["Sending a month, then correcting it", "send.js", "en-pay.html"],
  ["The nudge for an unsent month", "reminder.js", "en-reminder.html"],
  ["Connecting Google Drive", "connect.js", "en-pay-connect.html"],
  ["The board in Hebrew", "hebrew-board.js", "he-loaded.html"],
  ["The Pay tab in Hebrew", "hebrew-pay.js", "he-pay.html"],
];

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

// A browser only allows a service worker on a secure page, and file:// isn't one, so the offline
// check gets the real site over localhost, which browsers do trust
function serve(dir) {
  const server = http.createServer((req, res) => {
    const asked = decodeURIComponent(req.url.split("?")[0]);
    const file = path.join(dir, asked === "/" ? "index.html" : asked);
    if (!file.startsWith(dir)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (err, body) => {
      if (err) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

// Loads the real site, waits for the service worker to take over, then cuts the network and asks the
// page for its own files. This is the only way to know "works with no signal" is true and not just wired up.
async function offlineChecks(chrome) {
  const lines = [];
  const { server, port } = await serve(ROOT);
  try {
    const tab = await chrome.open("http://127.0.0.1:" + port + "/");
    const took = await tab.waitFor("navigator.serviceWorker && navigator.serviceWorker.controller !== null");
    lines.push(took ? "PASS  The service worker takes charge of the page" : "FAIL  The service worker never took charge");
    if (took) {
      await tab.send("Network.enable");
      await tab.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
      const seen = await tab.evaluate(`(async () => {
        const out = [];
        try {
          const r = await fetch("./app.js");
          const body = await r.text();
          out.push(r.ok && body.length > 1000 ? "PASS  With no signal it still serves the app" : "FAIL  app.js came back empty with no signal");
        } catch (e) { out.push("FAIL  app.js wouldn't load with no signal: " + e.message); }
        try {
          const r = await fetch("./index.html");
          out.push(r.ok ? "PASS  With no signal it still serves the page" : "FAIL  index.html didn't come back with no signal");
        } catch (e) { out.push("FAIL  index.html wouldn't load with no signal: " + e.message); }
        try {
          await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList");
          out.push("FAIL  Google answered with no signal, so shifts are being cached");
        } catch (e) { out.push("PASS  Google is never cached, so shifts can't be shown stale"); }
        return out;
      })()`);
      lines.push.apply(lines, seen);
      await tab.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
    await tab.close();
  } finally {
    server.close();
  }
  return lines;
}

let passed = 0;
let failed = 0;

function report(name, lines) {
  const good = lines.filter((l) => l.trim().startsWith("PASS")).length;
  const bad = lines.filter((l) => l.trim().startsWith("FAIL"));
  if (!good && !bad.length) bad.push("FAIL  nothing ran");
  passed += good;
  failed += bad.length;
  console.log("  " + (bad.length ? "FAIL" : "ok  ") + "  " + name.padEnd(52) + good + " passed" + (bad.length ? ", " + bad.length + " failed" : ""));
  bad.forEach((l) => console.log("        " + l.trim()));
}

console.log("ShiftBoard checks\n");
for (const [name, file] of CHECKS) {
  const run = spawnSync(process.execPath, [path.join(__dirname, file), APP], { encoding: "utf8" });
  const output = ((run.stdout || "") + (run.stderr || "")).split("\n").filter((l) => l.trim());
  report(name, run.status === 0 ? output : output.concat("FAIL  " + file + " stopped with an error"));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  buildPreviews({ projectDir: ROOT, outDir: OUT, tag: "en", lang: "en" });
  buildPreviews({ projectDir: ROOT, outDir: OUT, tag: "he", lang: "he" });

  const chrome = await launch();
  try {
    for (const [name, script, page] of IN_PAGE) {
      const tab = await chrome.open(fileUrl(path.join(OUT, page)));
      let lines;
      try {
        // The preview taps its own way into the state being checked, then says it's there
        if (!(await tab.waitFor("window.__ready === true"))) throw new Error("the preview never finished setting up");
        lines = await tab.evaluate(fs.readFileSync(path.join(__dirname, "pages", script), "utf8"));
      } catch (e) {
        lines = ["FAIL  the page stopped: " + e.message];
      }
      await tab.close();
      report(name, lines || ["FAIL  the page returned nothing"]);
    }
    report("Really working with no signal", await offlineChecks(chrome));
  } finally {
    chrome.close();
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("Couldn't run the browser checks:", e.message);
  process.exit(1);
});
