// node tests/tools/screenshots.js [board|phase1|pay|hebrew]
// The app's states as PNGs in tests/.out, on an emulated phone (and a couple of wide screens). Each shot also
// reports what it measured in the page: sideways overflow, controls under 44px, and clipped tape labels.
const path = require("path");
const { buildPreviews } = require("../lib/preview");
const { launch, fileUrl, sleep } = require("../lib/chrome");

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(__dirname, "..", ".out");

// scenario, width, height, colour scheme, whole page
const SETS = {
  board: [
    ["signed-out", 390, 844, "light"],
    ["loaded", 390, 844, "light"],
    ["dirty", 390, 844, "light", true],
    ["error", 390, 844, "light"],
    ["loading", 390, 844, "light"],
    ["loaded", 390, 844, "dark"],
    ["loaded", 320, 640, "light"],
    ["signed-out", 1280, 900, "light"],
    ["loaded", 1280, 900, "light"],
  ],
  phase1: [
    ["panel", 390, 844, "light"],
    ["panel-filled", 390, 844, "dark"],
    ["panel-empty", 390, 844, "light"],
    ["missing", 390, 844, "light"],
    ["panel", 1280, 900, "light"],
  ],
  pay: [
    ["pay", 390, 844, "light", true],
    ["pay", 390, 844, "dark"],
    ["pay-connect", 390, 844, "light"],
    ["pay-settings", 390, 844, "light"],
    ["pay-settings", 320, 640, "dark"],
    ["reminder", 390, 844, "light"],
    ["pay", 1280, 900, "light"],
  ],
  hebrew: [
    ["signed-out", 390, 844, "light"],
    ["loaded", 390, 844, "light"],
    ["dirty", 390, 844, "dark"],
    ["panel-filled", 390, 844, "light"],
    ["panel-empty", 390, 844, "light"],
    ["pay", 390, 844, "light", true],
    ["pay-settings", 390, 844, "light"],
    ["loaded", 320, 640, "light"],
    ["pay", 1280, 900, "dark"],
  ],
};

const PROBE = `(() => {
  const vw = document.documentElement.clientWidth;
  const name = (el) => el.id || (el.dataset.type ? "tape:" + el.dataset.type : el.className || el.tagName);
  const small = [...document.querySelectorAll("button, select, a")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.closest("[aria-hidden=true]") && (r.width < 44 || r.height < 44);
  }).map((el) => name(el) + " " + Math.round(el.getBoundingClientRect().width) + "x" + Math.round(el.getBoundingClientRect().height));
  const clipped = [...document.querySelectorAll(".tape-label")].filter((el) => el.offsetWidth && el.scrollWidth > el.clientWidth + 1);
  return {
    overflow: document.documentElement.scrollWidth - vw,
    small: [...new Set(small)].slice(0, 6),
    clipped: clipped.length ? clipped.length + " (" + clipped[0].textContent + ")" : "",
  };
})()`;

(async () => {
  const set = process.argv[2] || "board";
  const shots = SETS[set];
  if (!shots) {
    console.error("Unknown set. Pick one of: " + Object.keys(SETS).join(", "));
    process.exit(1);
  }
  const lang = set === "hebrew" ? "he" : "en";
  buildPreviews({ projectDir: ROOT, outDir: OUT, tag: lang, lang });

  const chrome = await launch();
  try {
    for (const [scenario, width, height, scheme, fullPage] of shots) {
      const file = lang + "-" + scenario + "-" + width + "-" + scheme + (fullPage ? "-full" : "") + ".png";
      const tab = await chrome.open(fileUrl(path.join(OUT, lang + "-" + scenario + ".html")), { width, height, scheme, mobile: width < 700 });
      await tab.waitFor("window.__ready === true"); // the preview taps its own way in first
      await sleep(300); // and a tape pull takes 240ms to finish drawing
      const seen = await tab.evaluate(PROBE);
      await tab.screenshot(path.join(OUT, file), { fullPage: !!fullPage });
      await tab.close();
      console.log(
        "  " + file.padEnd(40),
        "overflow " + seen.overflow + "px",
        seen.clipped ? "| clipped labels " + seen.clipped : "",
        seen.small.length ? "| under 44px: " + seen.small.join(", ") : ""
      );
    }
  } finally {
    chrome.close();
  }
})();
