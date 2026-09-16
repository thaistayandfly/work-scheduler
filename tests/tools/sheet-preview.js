// node tests/tools/sheet-preview.js
// Rebuilds a month tab the way Google Sheets would draw it: the values from monthTable() plus the formatting
// requests from tableFormatRequests() (merges, colours, fonts, alignment, wrapping, borders, column widths,
// number formats, right to left). Arial 10pt like Sheets. Any cell whose text doesn't fit is outlined in red
// and named in the report, because Sheets hides nothing: a cut-off cell would reach the company that way.
// Writes sheet-he.html / sheet-en.html and a PNG of each into tests/.out.
const fs = require("fs");
const vm = require("vm");
const path = require("path");
const { launch, fileUrl, sleep } = require("../lib/chrome");

const ROOT = path.join(__dirname, "..", "..");
const OUT = path.join(__dirname, "..", ".out");
const APP = process.argv[2] || path.join(ROOT, "app.js");

const ctx = vm.createContext({
  console, URLSearchParams, setTimeout, clearTimeout,
  window: { addEventListener() {} },
  navigator: { language: "en-US" },
  document: { documentElement: {}, querySelectorAll: () => [], getElementById: () => ({}) },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
});
vm.runInContext(fs.readFileSync(path.join(path.dirname(APP), "i18n.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(APP, "utf8"), ctx);

// A realistic month: every type, a night, expenses, an Other job and a shift without times
const rates = { warehouse: 55, event: 600, extra: 70, night: 200 };
const at = (y, m, d, h, min = 0) => new Date(y, m, d, h, min).toISOString();
const timed = (id, summary, start, end, priv) => ({
  id, summary, start: { dateTime: start }, end: { dateTime: end },
  extendedProperties: { private: Object.assign({ appTag: "shiftboard", workType: summary }, priv || {}) },
});
const events = [
  timed("w1", "Warehouse", at(2026, 8, 1, 9), at(2026, 8, 1, 18, 30)),
  timed("w2", "Warehouse", at(2026, 8, 2, 9), at(2026, 8, 2, 17, 20)),
  timed("e1", "Event", at(2026, 8, 3, 10), at(2026, 8, 3, 18)),
  timed("e2", "Event", at(2026, 8, 14, 6), at(2026, 8, 15, 4), {
    slept: "1", expenses: '[{"type":"Travel","amount":250},{"type":"Food","amount":120},{"type":"Hotel","amount":480}]' }),
  timed("e3", "Event", at(2026, 8, 20, 8), at(2026, 8, 20, 20, 30)),
  timed("o1", "Other", at(2026, 8, 21, 10), at(2026, 8, 21, 12), { amount: "300", note: "Move the sound gear from the warehouse to the Pattaya venue" }),
  { id: "e4", summary: "Event", start: { date: "2026-09-25" }, end: { date: "2026-09-26" } },
  timed("e5", "Event", at(2026, 8, 30, 20), at(2026, 9, 1, 4)),
];
const lines = ctx.monthLines(events, 2026, 8, rates);
const totals = ctx.monthTotals(lines);

fs.mkdirSync(OUT, { recursive: true });
const drawn = ["he", "en"].map((lang) => {
  const table = ctx.monthTable(new Date(2026, 8, 1), lines, totals, { full_name: lang === "he" ? "אלכסנדרה מורגן-לוי" : "Alexandra Morgan-Levi" }, lang);
  const file = path.join(OUT, "sheet-" + lang + ".html");
  fs.writeFileSync(file, render(table, ctx.tableFormatRequests(0, table)));
  return { lang, file, rows: table.rows.length };
});

// Then look at each tab the way a person would, and ask the page whether every cell's text fits
(async () => {
  const chrome = await launch();
  try {
    for (const tabPage of drawn) {
      const tab = await chrome.open(fileUrl(tabPage.file), { width: 1500, height: 1000, mobile: false });
      await sleep(300);
      const fit = await tab.evaluate("document.getElementById('fit').textContent");
      await tab.screenshot(path.join(OUT, "sheet-" + tabPage.lang + ".png"), { fullPage: true });
      await tab.close();
      console.log("  sheet-" + tabPage.lang + ": " + tabPage.rows + " rows, " + String(fit).replace(/\n/g, " | "));
    }
  } finally {
    chrome.close();
  }
})();

function render(table, requests) {
  const ROWS = table.rows.length;
  const COLS = Math.max(...table.rows.map((row) => row.length));
  const grid = table.rows.map((row) => Array.from({ length: COLS }, (_, c) => ({ v: row[c] == null ? "" : row[c], f: {}, b: {} })));
  const widths = Array(COLS).fill(100);
  const heights = {};
  const merges = [];
  let rtl = false;
  const each = (rg, fn) => {
    for (let r = rg.startRowIndex; r < Math.min(rg.endRowIndex, ROWS); r++)
      for (let c = rg.startColumnIndex; c < Math.min(rg.endColumnIndex, COLS); c++) fn(grid[r][c], r, c);
  };
  for (const q of requests) {
    if (q.updateSheetProperties && "rightToLeft" in q.updateSheetProperties.properties) rtl = q.updateSheetProperties.properties.rightToLeft;
    if (q.repeatCell) {
      const fmt = q.repeatCell.cell.userEnteredFormat || {};
      const fields = q.repeatCell.fields.replace(/^userEnteredFormat\(?/, "").replace(/\)$/, "").split(",").filter(Boolean);
      each(q.repeatCell.range, (cell) => {
        if (!fields.length) cell.f = {};
        fields.forEach((k) => (cell.f[k] = fmt[k]));
      });
    }
    if (q.mergeCells) merges.push(q.mergeCells.range);
    if (q.updateDimensionProperties) {
      const d = q.updateDimensionProperties;
      if (d.range.dimension === "COLUMNS") {
        if (d.range.startIndex < COLS) widths[d.range.startIndex] = d.properties.pixelSize;
      } else heights[d.range.startIndex] = d.properties.pixelSize;
    }
    if (q.updateBorders) {
      const u = q.updateBorders;
      const rg = u.range;
      each(rg, (cell, r, c) => {
        if (r === rg.startRowIndex && u.top) cell.b.top = u.top;
        if (r === rg.endRowIndex - 1 && u.bottom) cell.b.bottom = u.bottom;
        if (r > rg.startRowIndex && u.innerHorizontal) cell.b.top = cell.b.top || u.innerHorizontal;
        if (c === rg.startColumnIndex && u.left) cell.b.left = u.left;
        if (c === rg.endColumnIndex - 1 && u.right) cell.b.right = u.right;
        if (c > rg.startColumnIndex && u.innerVertical) cell.b.left = cell.b.left || u.innerVertical;
      });
    }
  }

  const rgb = (c) => "rgb(" + [c.red || 0, c.green || 0, c.blue || 0].map((x) => Math.round(x * 255)).join(",") + ")";
  const line = (b) => (b ? (b.style === "SOLID_MEDIUM" ? "2px" : "1px") + " solid " + rgb(b.color || {}) : "1px solid #e2e3e3");
  const esc = (s) => String(s).replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]);
  const show = (v, nf) => {
    if (typeof v !== "number" || !nf) return v;
    if (nf.type === "CURRENCY") return "₪" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v.toFixed(2);
  };

  // Column A is the start edge: the right in a right-to-left sheet, hence logical properties throughout
  let html =
    "<!doctype html><meta charset=utf-8><style>body{margin:16px;background:#fff;font:10pt Arial,sans-serif}" +
    "table{border-collapse:collapse;table-layout:fixed}td{padding:0 4px;overflow:hidden;vertical-align:bottom}" +
    ".clip{outline:3px solid red;outline-offset:-3px}#fit{font:12px monospace;white-space:pre}</style>" +
    '<table dir="' + (rtl ? "rtl" : "ltr") + '"><colgroup>' +
    widths.map((w) => '<col style="width:' + w + 'px">').join("") +
    "</colgroup>";
  for (let r = 0; r < ROWS; r++) {
    html += '<tr style="height:' + (heights[r] || 21) + 'px">';
    for (let c = 0; c < COLS; c++) {
      const m = merges.find((g) => g.startRowIndex === r && g.startColumnIndex <= c && c < g.endColumnIndex);
      if (m && m.startColumnIndex !== c) continue;
      const span = m ? m.endColumnIndex - m.startColumnIndex : 1;
      const cell = grid[r][c];
      const f = cell.f;
      const t = f.textFormat || {};
      const last = grid[r][c + span - 1];
      // As seen in a real sheet: unless a cell says otherwise, Sheets writes it left to right and, in a right-to-left
      // tab, aligns it left; so this preview does the same, and only what the app sets explicitly looks right
      const dir = f.textDirection === "RIGHT_TO_LEFT" ? "rtl" : "ltr";
      const align = f.horizontalAlignment ? f.horizontalAlignment.toLowerCase() : typeof cell.v === "number" && !rtl ? "right" : "left";
      const style = [
        "direction:" + dir,
        f.backgroundColor ? "background:" + rgb(f.backgroundColor) : "",
        t.foregroundColor ? "color:" + rgb(t.foregroundColor) : "",
        t.bold ? "font-weight:bold" : "",
        t.fontSize ? "font-size:" + t.fontSize + "pt" : "",
        "text-align:" + align,
        f.verticalAlignment === "MIDDLE" ? "vertical-align:middle" : "",
        f.wrapStrategy === "WRAP" ? "white-space:normal;overflow-wrap:anywhere" : "white-space:nowrap",
        "border-top:" + line(cell.b.top), "border-bottom:" + line(cell.b.bottom),
        "border-inline-start:" + line(cell.b.left), "border-inline-end:" + line(last.b.right),
      ].filter(Boolean).join(";");
      html += "<td" + (span > 1 ? ' colspan="' + span + '"' : "") + ' data-cell="' + String.fromCharCode(65 + c) + (r + 1) + '" style="' + style + '">' + esc(show(cell.v, f.numberFormat)) + "</td>";
    }
    html += "</tr>";
  }
  return (
    html +
    "</table><pre id=fit></pre><script>document.fonts.ready.then(function(){var bad=[];" +
    "document.querySelectorAll('td').forEach(function(td){if(td.scrollWidth>td.clientWidth+1){td.classList.add('clip');bad.push(td.dataset.cell+': '+td.textContent)}});" +
    "document.getElementById('fit').textContent=bad.length?'DOES NOT FIT:\\n'+bad.join('\\n'):'ALL CELLS FIT';});</script>"
  );
}
