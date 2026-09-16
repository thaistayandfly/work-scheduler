// Usage: node verify-pay.js <app.js>
// Checks the pay rules and the monthly report in app.js against worked examples of the confirmed rules.
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ctx = vm.createContext({
  console, URLSearchParams, setTimeout, clearTimeout, Blob, TextEncoder, TextDecoder, btoa, atob,
  window: { addEventListener() {} },
  navigator: { language: "en-US" },
  document: { documentElement: {}, querySelectorAll: () => [], getElementById: () => ({}) },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
});
vm.runInContext(fs.readFileSync(path.join(path.dirname(process.argv[2]), "i18n.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(process.argv[2], "utf8"), ctx);

const rates = { warehouse: 55, event: 600, extra: 70, night: 200 };
const at = (y, m, d, h, min = 0) => new Date(y, m, d, h, min).toISOString();
const timed = (id, summary, start, end, priv) => ({
  id, summary, start: { dateTime: start }, end: { dateTime: end },
  extendedProperties: { private: Object.assign({ appTag: "shiftboard", workType: summary }, priv || {}) },
});
const events = [
  timed("w1", "Warehouse", at(2026, 8, 1, 9), at(2026, 8, 1, 18, 30)),              // 9.5 h
  timed("w2", "Warehouse", at(2026, 8, 2, 9), at(2026, 8, 2, 17, 20)),              // 8 h 20 min
  timed("e1", "Event", at(2026, 8, 3, 10), at(2026, 8, 3, 18)),                     // 8 h: fixed only
  timed("e2", "Event", at(2026, 8, 14, 6), at(2026, 8, 15, 4), {                    // 22 h, slept, expenses
    slept: "1", expenses: '[{"type":"Travel","amount":250},{"type":"Food","amount":120}]' }),
  timed("e3", "Event", at(2026, 8, 20, 8), at(2026, 8, 20, 20, 30)),                // 12.5 h: 30 min extra
  timed("o1", "Other", at(2026, 8, 21, 10), at(2026, 8, 21, 12), { amount: "300", note: "Move gear" }),
  { id: "e4", summary: "Event", start: { date: "2026-09-25" }, end: { date: "2026-09-26" } }, // no times yet
  timed("e5", "Event", at(2026, 8, 30, 20), at(2026, 9, 1, 4)),                     // starts 30 Sep, ends 1 Oct
  timed("e6", "Event", at(2026, 9, 1, 8), at(2026, 9, 1, 16)),                      // October: not in September
  { id: "x", summary: "Dentist", start: { dateTime: at(2026, 8, 5, 9) }, end: { dateTime: at(2026, 8, 5, 10) } },
];

const lines = ctx.monthLines(events, 2026, 8, rates);
const byId = Object.fromEntries(lines.map((l) => [l.event.id, l]));
const results = [];
const check = (name, ok, detail) => results.push((ok ? "  PASS  " : "  FAIL  ") + name + (ok ? "" : "   [" + JSON.stringify(detail) + "]"));

// Pay rules
check("Warehouse pays exact hours × rate (9.5 h → ₪522.50)", byId.w1.pay === 522.5 && byId.w1.salary === 522.5, byId.w1);
check("Minutes count exactly (8 h 20 min → ₪458.33)", byId.w2.pay === 458.33, byId.w2);
check("An Event up to 12 hours pays the fixed amount (8 h → ₪600)", byId.e1.pay === 600 && byId.e1.extraHours === 0, byId.e1);
check("Hours 13+ of an Event are extra (22 h → ₪600 + 10 × ₪70)", byId.e2.pay === 1300 && byId.e2.extraHours === 10, byId.e2);
check("A night slept at work is salary; expenses stay apart", byId.e2.night === 200 && byId.e2.salary === 1500 && byId.e2.expenses === 370, byId.e2);
check("Part-hours of extra count exactly (12.5 h → 30 min extra → ₪635)", byId.e3.pay === 635, byId.e3);
check("An Other job pays its amount", byId.o1.pay === 300 && byId.o1.night === 0, byId.o1);
check("A shift with no times is flagged, Event shows its fixed amount", byId.e4.missingTimes === true && byId.e4.pay === 600, byId.e4);
check("A shift is paid in the month it starts (30 Sep → 1 Oct is September)", !!byId.e5 && !byId.e6, lines.map((l) => l.event.id));
check("Events that aren't shifts are ignored", !byId.x, lines.map((l) => l.event.id));
check("Shifts are listed in start order", lines.map((l) => l.event.id).join() === "w1,w2,e1,e2,e3,o1,e4,e5", lines.map((l) => l.event.id));

const t = ctx.monthTotals(lines);
check("Warehouse totals: 2 shifts, 17 h 50 min, ₪980.83", t.warehouse.count === 2 && Math.abs(t.warehouse.hours - 17.8333) < 0.001 && t.warehouse.pay === 980.83, t.warehouse);
check("Event totals: 5 days, 10.5 extra hours, ₪3,735", t.event.count === 5 && t.event.extraHours === 10.5 && t.event.pay === 3735, t.event);
check("Nights and Other totals", t.nights.count === 1 && t.nights.pay === 200 && t.other.pay === 300, t);
check("Gross salary excludes expenses (₪5,215.83)", t.salary === 5215.83 && t.missingTimes === 1, t);
check("Expenses reimbursement is its own total (₪370)", t.expenses === 370, t);

// The report, English
const en = ctx.monthTable(new Date(2026, 8, 1), lines, t, { full_name: "Alex Morgan" }, "en");
const E = en.rows;
const hebrew = /[֐-׿]/;
const latin = /[A-Za-z]/;
check("English: title, then name, month and year", E[en.at.title][0] === "Shift report - September 2026" &&
  E[en.at.info][3] === "Alex Morgan" && E[en.at.info + 1].join("|") === "Month|||September" && E[en.at.info + 2].join("|") === "Year|||2026", E.slice(0, 4));
check("English: gross salary, then expenses reimbursement apart", E[en.at.salary][0] === "Total to pay (gross salary)" && E[en.at.salary][3] === 5215.83 &&
  E[en.at.expenses][0] === "Expenses reimbursement" && E[en.at.expenses][3] === 370 && en.at.salary < en.at.expenses, [E[en.at.salary], E[en.at.expenses]]);
check("English: says when the month isn't final", E[en.at.note][0] === "Not final: 1 shift has no times yet", E[en.at.note]);
check("English: a quiet hours summary before the shifts",
  E.slice(en.at.hoursTitle, en.at.hoursEnd).map((r) => r[0]).join(" | ") === "Hours summary | Warehouse: 2 shifts, 17.83 hours | Event: 5 days, 10.5 extra hours | Nights at work: 1 | Other jobs: 1" &&
    en.at.hoursEnd < en.at.shiftsTitle, E.slice(en.at.hoursTitle, en.at.hoursEnd));
check("No rates anywhere in the report", !E.some((r) => r.some((v) => /₪\s?(55|600|70)\b|rate/i.test(String(v)))), "found a rate");
check("English: column headings", E[en.at.headings].join("|") === "Date|Day|Type|Start|End|Hours|Extra hours|Pay|Night|Expenses|Details", E[en.at.headings]);
check("English: a shift row", JSON.stringify(E[en.at.lines + 3]) === JSON.stringify(["14/09/2026", "Mon", "Event", "06:00", "04:00 (+1)", 22, 10, 1300, 200, 370, "Travel ₪250, Food ₪120"]), E[en.at.lines + 3]);
check("English: a totals row closes the shift table",
  en.at.sum === E.length - 1 && JSON.stringify(E[en.at.sum]) === JSON.stringify(["Total", "", "", "", "", 70.33, 10.5, 5015.83, 200, 370, ""]), E[en.at.sum]);
check("English: no Hebrew anywhere", !E.some((r) => r.some((v) => hebrew.test(String(v)))) && en.rtl === false, "found Hebrew");

// The report, Hebrew (the default)
const he = ctx.monthTable(new Date(2026, 8, 1), lines, t, { full_name: "אלכס מורגן" }, "he");
const H = he.rows;
check("Hebrew: title, name, month and year", H[he.at.title][0] === "דוח משמרות - ספטמבר 2026" && H[he.at.info][3] === "אלכס מורגן" && H[he.at.info + 1].join("|") === "חודש|||ספטמבר" && H[he.at.info + 2].join("|") === "שנה|||2026", H.slice(0, 4));
check("Hebrew: salary and expenses reimbursement", H[he.at.salary][0] === "סה״כ לתשלום (שכר ברוטו)" && H[he.at.expenses][0] === "החזר הוצאות", [H[he.at.salary], H[he.at.expenses]]);
check("Hebrew: headings", H[he.at.headings].join("|") === "תאריך|יום|סוג|התחלה|סיום|שעות|שעות נוספות|שכר|לינה|הוצאות|פירוט", H[he.at.headings]);
check("Hebrew: a shift row, a night shift ending the next day", JSON.stringify(H[he.at.lines + 3]) === JSON.stringify(["14/09/2026", "שני", "אירוע", "06:00", "04:00 (למחרת)", 22, 10, 1300, 200, 370, "נסיעות ₪250, אוכל ₪120"]), H[he.at.lines + 3]);
check("Hebrew: the sheet runs right to left", he.rtl === true, he.rtl);
const userText = new Set(["Move gear"]); // the person's own notes stay as they typed them
check("Hebrew: no English in the report's own words",
  !H.some((r) => r.some((v) => latin.test(String(v)) && !userText.has(String(v)))), H.filter((r) => r.some((v) => latin.test(String(v)) && !userText.has(String(v)))));
check("An unknown language falls back to Hebrew", ctx.monthTable(new Date(2026, 8, 1), lines, t, {}, "xx").rtl === true, "");
check("No long dashes anywhere in either report", ![...E, ...H].some((r) => r.some((v) => /[—–]/.test(String(v)))),
  [...E, ...H].filter((r) => r.some((v) => /[—–]/.test(String(v)))));

// The name goes on a report in that report's language
const fits = (name, lang) => ctx.nameFitsReport(name, lang);
check("A Hebrew report takes a name in Hebrew letters, an English report one in English letters",
  fits("אלכס מורגן", "he") && fits("ג׳ורג׳ בן-דוד", "he") && !fits("Alex Morgan", "he") && !fits("Alex מורגן", "he") &&
    fits("Alex Morgan", "en") && fits("Mary-Jane O'Neil", "en") && fits("José Ruiz", "en") && !fits("אלכס מורגן", "en") && !fits("Alex 2", "en") && !fits("- '", "en"),
  "");
check("A name in the other language is refused, with the reason",
  ctx.nameProblem({ full_name: "Alex Morgan", report_language: "he" }) === "The report is in Hebrew, so write your full name in Hebrew letters." &&
    ctx.nameProblem({ full_name: "אלכס", report_language: "English" }) === "The report is in English, so write your full name in English letters." &&
    ctx.nameProblem({ full_name: "Alex Morgan", report_language: "en" }) === "" && ctx.nameProblem({ full_name: "", report_language: "he" }) === "",
  ctx.nameProblem({ full_name: "Alex Morgan", report_language: "he" }));

// The two amounts line up with the name, month and year: the start of the cell (right in Hebrew, left in English)
const amountFormat = (table) => {
  const q = ctx.tableFormatRequests(0, table).find((r) => r.repeatCell && r.repeatCell.range.startRowIndex === table.at.salary &&
    r.repeatCell.range.startColumnIndex === 3 && r.repeatCell.cell.userEnteredFormat.numberFormat);
  return q ? q.repeatCell.range.endRowIndex + ":" + q.repeatCell.cell.userEnteredFormat.horizontalAlignment : "none";
};
check("Salary and expenses amounts sit at the start of their cells, like the name",
  amountFormat(he) === he.at.expenses + 1 + ":RIGHT" && amountFormat(en) === en.at.expenses + 1 + ":LEFT", [amountFormat(he), amountFormat(en)]);

// A right-to-left tab only mirrors the columns, so every cell has to say its direction and side itself
const baseFormat = (table) => {
  const q = ctx.tableFormatRequests(0, table).find((r) => r.repeatCell && r.repeatCell.range.startRowIndex === 0 &&
    r.repeatCell.range.endRowIndex === table.rows.length && (r.repeatCell.cell.userEnteredFormat || {}).textDirection);
  const f = q ? q.repeatCell.cell.userEnteredFormat : {};
  return q ? f.textDirection + ":" + f.horizontalAlignment + ":" + (q.repeatCell.range.endColumnIndex - q.repeatCell.range.startColumnIndex) : "none";
};
const numberSide = (table) => {
  const q = ctx.tableFormatRequests(0, table).find((r) => r.repeatCell && r.repeatCell.range.startRowIndex === table.at.lines &&
    r.repeatCell.range.startColumnIndex === 5 && r.repeatCell.range.endColumnIndex === 10 && (r.repeatCell.cell.userEnteredFormat || {}).horizontalAlignment);
  return q ? q.repeatCell.cell.userEnteredFormat.horizontalAlignment : "none";
};
check("Hebrew: every cell runs right to left, text on the right, number columns on the left",
  baseFormat(he) === "RIGHT_TO_LEFT:RIGHT:11" && numberSide(he) === "LEFT", [baseFormat(he), numberSide(he)]);
check("English: every cell left to right, text on the left, number columns on the right",
  baseFormat(en) === "LEFT_TO_RIGHT:LEFT:11" && numberSide(en) === "RIGHT", [baseFormat(en), numberSide(en)]);

// The report language as stored in (or typed into) the Settings tab
const lang = (v) => ctx.reportLanguage({ report_language: v });
check("Report language: English by code or name, Hebrew otherwise and by default",
  lang("en") === "en" && lang("English") === "en" && lang(" english ") === "en" && lang("אנגלית") === "en" &&
    lang("he") === "he" && lang("עברית") === "he" && lang("") === "he" && lang(undefined) === "he" && ctx.reportLanguage(null) === "he",
  [lang("en"), lang("English"), lang("עברית"), lang("")]);

// Resending a month: the report's title says it's a correction, in its own language
const correctedTitle = (lang) => ctx.monthTable(new Date(2026, 8, 1), lines, t, { full_name: "Alex Morgan" }, lang, true).rows[0][0];
check("A resent report is titled as a correction", correctedTitle("he") === "דוח משמרות - ספטמבר 2026 (מתוקן)" && correctedTitle("en") === "Shift report - September 2026 (Corrected)",
  [correctedTitle("he"), correctedTitle("en")]);

// The fingerprint that spots calendar changes after a month was sent
const moved = JSON.parse(JSON.stringify(events));
moved[0].end.dateTime = at(2026, 8, 1, 19);
const fp = ctx.monthFingerprint(lines);
check("A sent month's fingerprint holds until a shift's times change",
  fp === ctx.monthFingerprint(ctx.monthLines(events, 2026, 8, rates)) && fp !== ctx.monthFingerprint(ctx.monthLines(moved, 2026, 8, rates)), fp);

// The email exactly as Gmail would receive it
async function emailChecks() {
  const calls = [];
  ctx.jsonRequest = (url, method, body) => (calls.push({ url, method, body }), Promise.resolve({ id: "m1" }));
  const subject = "מתוקן: דוח משמרות - אוגוסט 2026 - אלכסנדרה מורגן-לוי";
  const fileName = "דוח משמרות - אוגוסט 2026 - אלכסנדרה מורגן-לוי (מתוקן).pdf";
  await ctx.sendEmail({
    to: "pay@company.co.il", subject, rtl: true, fileName, asciiName: "shift-report-2026-08-corrected.pdf",
    paragraphs: ["שלום,", "סה״כ: ₪1.00\nהחזר: ₪2.00", "Alexandra <A&B>"],
    pdf: new Blob(["%PDF-1.4 test"], { type: "application/pdf" }),
  });
  const call = calls[0] || { body: { raw: "" } };
  const mime = Buffer.from(call.body.raw, "base64url").toString("latin1");
  const text = (b64) => Buffer.from(b64.replace(/\s+/g, ""), "base64").toString("utf8");
  const head = mime.slice(0, mime.indexOf("\r\n\r\n")).split("\r\n");
  const at0 = head.findIndex((l) => l.startsWith("Subject: "));
  const subjectLines = [head[at0]].concat(head.slice(at0 + 1).filter((l, i, all) => all.slice(0, i + 1).every((x) => x.startsWith(" "))));
  const decoded = subjectLines.join("").replace(/^Subject: /, "").replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/g, (m, b) => text(b));
  const part = (type) => {
    const m = mime.match(new RegExp("Content-Type: " + type + "[^]*?\\r\\n\\r\\n([^]*?)\\r\\n--"));
    return m ? m[1] : "";
  };
  const html = text(part("text/html"));
  check("Email: sent through Gmail's API, base64url", call.url === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send" && call.method === "POST" && !/[+/=]/.test(call.body.raw), call.url);
  check("Email: a Hebrew subject arrives intact, folded into short encoded words", decoded === subject && subjectLines.every((l) => l.length <= 78), subjectLines);
  check("Email: the HTML runs right to left, with the person's own text escaped",
    html.startsWith('<div dir="rtl"') && html.includes("Alexandra &lt;A&amp;B&gt;") && html.includes("₪1.00<br>"), html);
  check("Email: the plain text keeps its paragraphs and lines", text(part("text/plain")) === "שלום,\r\n\r\nסה״כ: ₪1.00\r\nהחזר: ₪2.00\r\n\r\nAlexandra <A&B>", text(part("text/plain")));
  const pct = encodeURIComponent(fileName).replace(/[()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  check("Email: the PDF is attached whole, under its Hebrew name (with a plain one for old mail clients)",
    Buffer.from(part("application/pdf").replace(/\s+/g, ""), "base64").toString() === "%PDF-1.4 test" &&
      mime.includes("filename=\"shift-report-2026-08-corrected.pdf\"; filename*=UTF-8''" + pct),
    (mime.match(/Content-Disposition[^\r]*/) || [""])[0]);
}

// The PDF writer: a well-formed file whose cross-reference table points at every object
async function pdfChecks() {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
  const blob = ctx.pdfFromJpegs([{ bytes: jpeg, width: 4, height: 2 }, { bytes: jpeg, width: 4, height: 2 }], "דוח - Test");
  const text = Buffer.from(await blob.arrayBuffer()).toString("latin1");
  const xrefAt = Number((text.match(/startxref\n(\d+)/) || [])[1]);
  const offsets = (text.slice(xrefAt).match(/\d{10} 00000 n /g) || []).map((entry) => Number(entry.slice(0, 10)));
  check("PDF: well-formed, every object where the cross-reference table says",
    text.startsWith("%PDF-1.4") && text.startsWith("xref", xrefAt) && offsets.length === 9 && offsets.every((off, i) => text.startsWith(i + 1 + " 0 obj", off)) &&
      /\/Count 2 /.test(text) && text.trimEnd().endsWith("%%EOF") && blob.type === "application/pdf",
    offsets);
  check("PDF: A4 landscape pages holding the JPEGs as they are", (text.match(/\/MediaBox \[0 0 842 595\]/g) || []).length === 2 && (text.match(/\/Filter \/DCTDecode \/Length 8 /g) || []).length === 2,
    text.match(/\/MediaBox[^\]]*\]/g));
  check("PDF: its title is UTF-16, so Hebrew survives", text.includes("/Title <FEFF05D305D505D70020002D00200054006500730074>"), (text.match(/\/Title <[0-9A-F]+>/) || [""])[0]);
}

emailChecks()
  .then(pdfChecks)
  .catch((err) => check("Email and PDF checks ran", false, err.stack))
  .then(() => console.log(results.join("\n")));
