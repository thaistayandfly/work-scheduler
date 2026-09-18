// Runs inside the Hebrew "pay" preview (run by tests/run.js): the Pay tab in Hebrew,
// right to left, with Israeli shekel formatting. Returns one PASS/FAIL line per check.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const check = (name, ok, detail) => out.push((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   [" + detail + "]"));
  const $ = (id) => document.getElementById(id);
  const norm = (s) => s.replace(/[‎‏]/g, "").replace(/ /g, " ");
  await wait(300);

  check("The month is named in Hebrew", $("monthTitle").textContent === "ספטמבר 2026", $("monthTitle").textContent);
  check("The status is in Hebrew", $("payStatus").textContent === "ל־7 משמרות עדיין אין שעות, אז הסכום עוד לא סופי.", $("payStatus").textContent);
  const [salary, reimburse] = [...$("payTotals").querySelectorAll(".total-line")];
  check("Gross salary and the expenses reimbursement, apart, in shekels",
    norm(salary.textContent) === "סה״כ לתשלום שכר ברוטו4,667.50 ₪" && norm(reimburse.textContent) === "החזר הוצאות370.00 ₪",
    norm(salary.textContent) + " / " + norm(reimburse.textContent));
  const breakdown = [...$("payTotals").querySelectorAll(".total-breakdown div")].map((d) => norm(d.textContent)).join(" | ");
  check("The breakdown is in Hebrew",
    breakdown === "מחסן4 משמרות · 8 ש׳ 30 דק׳ · 467.50 ₪ | אירוע5 ימים · 10 ש׳ 00 דק׳ נוספות · 3,700.00 ₪ | לינותלינה אחת · 200.00 ₪ | אחרעבודה אחת · 300.00 ₪",
    breakdown);
  const line = [...$("payLines").querySelectorAll(".pay-line")][1];
  check("A shift row is in Hebrew, a night shift ending the next day",
    line.querySelector(".pay-type").textContent === "אירוע" && norm(line.querySelector(".pay-when").textContent).endsWith("06:00–04:00 (למחרת)") &&
      norm(line.querySelector(".pay-detail").textContent) === "22 ש׳ 00 דק׳ · 10 ש׳ 00 דק׳ נוספות · לינה 200.00 ₪ · הוצאות 370.00 ₪",
    norm(line.textContent));
  check("The previous-month arrow sits on the right", $("prevMonth").getBoundingClientRect().left > $("nextMonth").getBoundingClientRect().left, "");
  check("Actions and settings are in Hebrew",
    $("writeSheetBtn").textContent === "עדכון הגיליון שלי" && document.querySelector("#settingsView .view-title").textContent === "הפרטים והתעריפים שלכם" &&
      $("settingsForm").querySelector('[data-l="reportLanguage"]').textContent === "שפת הדוח",
    $("writeSheetBtn").textContent);
  const email = $("settingsForm").elements.company_email;
  check("The company email field runs left to right", getComputedStyle(email).direction === "ltr", getComputedStyle(email).direction);

  $("writeSheetBtn").click();
  await wait(500);
  check("The toast says the month is up to date, in Hebrew", $("toast").textContent === "ספטמבר 2026 מעודכן בגיליון השכר", $("toast").textContent);
  return out;
})();
