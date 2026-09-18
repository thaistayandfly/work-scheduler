// Usage: node offline.js <app.js>
// Checks the pieces that let someone install ShiftBoard and open it with no signal: the manifest, the
// icons it names, the list of files the service worker keeps, and the page and app that tie them together.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.dirname(process.argv[2] || path.join(__dirname, "..", "..", "app.js"));
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const exists = (f) => fs.existsSync(path.join(ROOT, f));

let failed = 0;
const ok = (msg) => console.log("  PASS  " + msg);
const bad = (msg) => {
  failed++;
  console.log("  FAIL  " + msg);
};
const is = (cond, good, wrong) => (cond ? ok(good) : bad(wrong));

let manifest = null;
try {
  manifest = JSON.parse(read("manifest.webmanifest"));
  ok("The manifest is valid JSON");
} catch (e) {
  bad("The manifest doesn't parse: " + e.message);
}

if (manifest) {
  is(manifest.name && manifest.short_name, "It gives the phone a name to show", "It needs both a name and a short_name");
  is(manifest.display === "standalone", "It opens without the browser bar", "display should be standalone, not " + manifest.display);

  // The site lives under /work-scheduler/, so any absolute path would point at the wrong place
  const paths = [manifest.start_url, manifest.scope].concat((manifest.icons || []).map((i) => i.src));
  const absolute = paths.filter((p) => p && (p.charAt(0) === "/" || /^https?:/.test(p)));
  is(
    absolute.length === 0,
    "Every path in it is relative, which a project page needs",
    "These paths would break on a project page: " + absolute.join(", ")
  );

  const icons = manifest.icons || [];
  is(icons.length > 0, "It names icons", "It names no icons at all");
  icons.forEach((icon) => {
    if (!exists(icon.src)) return bad("It names " + icon.src + ", which isn't in the folder");
    if (!/\.png$/i.test(icon.src)) return ok(icon.src + " is there");
    const b = fs.readFileSync(path.join(ROOT, icon.src));
    const real = b.readUInt32BE(16) + "x" + b.readUInt32BE(20);
    is(real === icon.sizes, icon.src + " really is " + icon.sizes, icon.src + " claims " + icon.sizes + " but is " + real);
  });
  is(
    icons.some((i) => i.purpose === "maskable"),
    "One icon is maskable, so Android won't crop the tapes off",
    "No maskable icon, so Android will crop the artwork"
  );
}

if (!exists("sw.js")) {
  bad("There's no sw.js, so nothing would work offline");
} else {
  const sw = read("sw.js");
  const files = (((sw.match(/const FILES = \[([\s\S]*?)\]/) || [])[1] || "").match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1));
  is(files.length > 0, "The service worker lists the files to keep", "Couldn't find the file list in sw.js");

  const missing = files.filter((f) => f !== "./" && !exists(f));
  is(missing.length === 0, "Every file it keeps is really in the folder", "It tries to keep files that aren't there: " + missing.join(", "));

  const googly = files.filter((f) => /googleapis|google\.com/.test(f));
  is(
    googly.length === 0,
    "It keeps nothing from Google, so shifts can never be shown stale",
    "It would cache Google's data: " + googly.join(", ")
  );

  is(/req\.method !== "GET"/.test(sw), "It leaves anything but a plain GET alone", "It should ignore requests that aren't GET");
  is(/url\.origin !== self\.location\.origin/.test(sw), "Google's APIs go straight to the network", "It doesn't send other origins straight to the network");
}

const html = read("index.html");
is(/rel="manifest"/.test(html), "The page links the manifest", "index.html doesn't link the manifest");
is(/apple-touch-icon/.test(html), "The page has an icon for an iPhone home screen", "No apple-touch-icon, so an iPhone shows a screenshot");
is(/name="mobile-web-app-capable"/.test(html), "The page says it can be installed", "index.html is missing mobile-web-app-capable");

const app = read("app.js");
is(/navigator\.serviceWorker/.test(app) && /register\("sw\.js"\)/.test(app), "The app registers the service worker", "app.js never registers sw.js");
is(
  /location\.protocol === "https:"/.test(app),
  "It only does so over https, so file:// previews still work",
  "It should only register over https, or the preview pages break"
);

// Saying "you're offline" is no use if it only says it in one language
const words = vm.createContext({});
vm.runInContext(read("i18n.js"), words);
const UI = vm.runInContext("typeof UI_TEXT !== 'undefined' ? UI_TEXT : null", words);
if (!UI) {
  bad("Couldn't read the words out of i18n.js");
} else {
  ["offlineBanner", "offlineToast", "backOnline"].forEach((key) => {
    const en = UI.en && UI.en[key];
    const he = UI.he && UI.he[key];
    is(en && he, "Both languages have the words for " + key, key + " is missing in " + (en ? "Hebrew" : "English"));
  });
}

process.exitCode = failed ? 1 : 0;
