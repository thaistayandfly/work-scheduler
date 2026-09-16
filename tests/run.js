// node tests/run.js — every check ShiftBoard has.
// First the ones that run on their own (pay rules, the board's flow, dates), then the app itself in real
// Chrome against preview pages with Google faked. Exits non-zero if anything failed, so CI can stop a push.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { buildPreviews } = require("./lib/preview");
const { launch, fileUrl, sleep } = require("./lib/chrome");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(__dirname, ".out");
const APP = path.join(ROOT, "app.js");

const CHECKS = [
  ["Pay rules, the report, the email and the PDF", "checks/pay.js"],
  ["The board: signing in, saving, languages", "checks/flow.js"],
  ["Dates in this time zone", "checks/dates.js"],
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
      await sleep(1200); // the preview taps its own way into the state being checked
      let lines;
      try {
        lines = await tab.evaluate(fs.readFileSync(path.join(__dirname, "pages", script), "utf8"));
      } catch (e) {
        lines = ["FAIL  the page stopped: " + e.message];
      }
      await tab.close();
      report(name, lines || ["FAIL  the page returned nothing"]);
    }
  } finally {
    chrome.close();
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("Couldn't run the browser checks:", e.message);
  process.exit(1);
});
