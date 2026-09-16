// Draws a long made-up month's report in the page's language (Hebrew on he-*.html) and returns every PDF page
// as a PNG, to look at: tests/tools/report-pages.js
(async () => {
  const lang = document.documentElement.lang === "he" ? "he" : "en";
  const at = (d, h) => new Date(2026, 8, d, h).toISOString();
  const shift = (id, type, d, from, to, extra) => ({
    id, summary: type,
    start: { dateTime: at(d, from) },
    end: { dateTime: to < from ? at(d + 1, to) : at(d, to) },
    extendedProperties: { private: Object.assign({ appTag: "shiftboard", workType: type }, extra || {}) },
  });
  const events = [
    shift("e2", "Event", 14, 6, 4, { slept: "1", expenses: '[{"type":"Travel","amount":250},{"type":"Food","amount":120},{"type":"Hotel","amount":480}]' }),
    shift("o1", "Other", 21, 10, 12, { amount: "300", note: "Move the sound gear from the warehouse to the Pattaya venue" }),
    shift("e5", "Event", 30, 20, 4),
  ];
  for (let d = 1; d <= 29; d++) if (d !== 14 && d !== 21) events.push(shift("s" + d, d % 3 ? "Warehouse" : "Event", d, 9, d % 4 ? 17 : 22));
  const lines = monthLines(events, 2026, 8, { warehouse: 55, event: 600, extra: 70, night: 200 });
  const name = lang === "he" ? "אלכסנדרה מורגן-לוי" : "Alexandra Morgan-Levi";
  const table = monthTable(new Date(2026, 8, 1), lines, monthTotals(lines), { full_name: name }, lang);
  await loadReportFonts();
  return drawReportPages(table, table.rows[table.at.title][0] + " - " + name).map((canvas) => canvas.toDataURL("image/png"));
})();
