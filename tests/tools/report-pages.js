// node tests/tools/report-pages.js [he|en]
// Draws the monthly report's PDF pages for a long made-up month and saves each one as a PNG in tests/.out,
// so the pages can be looked at without opening a PDF.
const fs = require("fs");
const path = require("path");
const { buildPreviews } = require("../lib/preview");
const { launch, fileUrl, sleep } = require("../lib/chrome");

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(__dirname, "..", ".out");

(async () => {
  const lang = process.argv[2] === "en" ? "en" : "he";
  buildPreviews({ projectDir: ROOT, outDir: OUT, tag: lang, lang });

  const chrome = await launch();
  try {
    const tab = await chrome.open(fileUrl(path.join(OUT, lang + "-loaded.html")));
    await sleep(1200);
    const pages = await tab.evaluate(fs.readFileSync(path.join(__dirname, "..", "pages", "pdf-pages.js"), "utf8"));
    await tab.close();
    pages.forEach((dataUrl, i) => {
      const file = path.join(OUT, "report-" + lang + "-" + (i + 1) + ".png");
      fs.writeFileSync(file, Buffer.from(dataUrl.split(",")[1], "base64"));
      console.log("  wrote " + path.basename(file));
    });
  } finally {
    chrome.close();
  }
})();
