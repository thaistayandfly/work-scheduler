// Runs inside the "pay" preview page (run by tests/run.js). Rates in the fake
// sheet: Warehouse ₪55/h, Event ₪600, extra ₪70/h, night ₪200. Returns one PASS/FAIL line per check.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const check = (name, ok, detail) => out.push((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   [" + detail + "]"));
  const $ = (id) => document.getElementById(id);
  const total = () => $("payTotals").querySelector(".total-line strong").textContent;
  await wait(300);

  check("The Pay tab shows; the board and save bar are hidden",
    !$("payView").hidden && $("workspace").hidden && $("saveBar").hidden && $("tabPay").getAttribute("aria-pressed") === "true", "payView.hidden=" + $("payView").hidden);
  check("The month is named", $("monthTitle").textContent === "September 2026", $("monthTitle").textContent);
  check("The status says the total isn't final yet", $("payStatus").textContent === "7 shifts have no times yet, so this total isn't final.", $("payStatus").textContent);
  check("Total to pay is the gross salary, without expenses", total() === "₪4,667.50", total());
  const reimburse = $("payTotals").querySelector(".total-line.reimburse strong");
  check("Expenses reimbursement is shown on its own", !!reimburse && reimburse.textContent === "₪370.00", reimburse && reimburse.textContent);
  const breakdown = [...$("payTotals").querySelectorAll(".total-breakdown div")].map((d) => d.textContent).join(" | ");
  check("Breakdown by type",
    breakdown === "Warehouse4 shifts · 8 h 30 min · ₪467.50 | Event5 days · 10 h 00 min extra · ₪3,700.00 | Nights1 night · ₪200.00 | Other1 job · ₪300.00",
    breakdown);

  const lines = [...$("payLines").querySelectorAll(".pay-line")];
  const text = (i, cls) => (lines[i] ? lines[i].querySelector("." + cls).textContent : "");
  check("One row per shift that starts this month, in start order",
    lines.length === 10 && text(0, "pay-when") === "Wed, Sep 9" && text(1, "pay-when") === "Fri, Sep 11 · 06:00–04:00 (+1)",
    lines.length + " rows; first: " + text(0, "pay-when") + " / " + text(1, "pay-when"));
  check("A row shows hours, extra hours, the night and expenses",
    text(1, "pay-detail") === "22 h 00 min · 10 h 00 min extra · night ₪200.00 · expenses ₪370.00" && text(1, "pay-amount") === "₪1,500.00",
    text(1, "pay-detail") + " / " + text(1, "pay-amount"));
  check("A Warehouse shift without times shows no pay yet", text(0, "pay-detail") === "No times yet" && text(0, "pay-amount") === "–", text(0, "pay-detail") + " / " + text(0, "pay-amount"));
  const other = lines.find((l) => l.classList.contains("type-other"));
  check("An Other job shows its description and amount",
    !!other && other.querySelector(".pay-detail").textContent === "2 h 00 min · Move speakers" && other.querySelector(".pay-amount").textContent === "₪300.00",
    other ? other.textContent : "no Other row");

  $("settingsBtn").click();
  await wait(100);
  const form = $("settingsForm");
  check("The details are a screen of their own, with the month put away",
    !$("settingsView").hidden && $("payView").hidden && $("workspace").hidden,
    "settings=" + !$("settingsView").hidden + " pay=" + !$("payView").hidden + " board=" + !$("workspace").hidden);
  check("Details and rates come from the pay sheet",
    form.elements.full_name.value === "אלכס מורגן" && form.elements.rate_event.value === "600",
    form.elements.full_name.value + " / " + form.elements.rate_event.value);
  form.elements.full_name.value = "";
  form.requestSubmit();
  await wait(50);
  check("A full name is required", form.querySelector(".form-error").textContent === "Enter your full name as the company knows it.", form.querySelector(".form-error").textContent);
  form.elements.full_name.value = "Alex Morgan";
  form.requestSubmit();
  await wait(50);
  check("A Hebrew report takes the name only in Hebrew letters",
    form.querySelector(".form-error").textContent === "The report is in Hebrew, so write your full name in Hebrew letters." &&
      $("fullNameLabel").textContent === "Full name in Hebrew, as the company knows you",
    form.querySelector(".form-error").textContent + " / " + $("fullNameLabel").textContent);
  // Switching the report language has to say so at once, not save it up for the Save button
  const flag = () => form.querySelector(".form-error");
  const pickLanguage = (v) => {
    form.elements.report_language.value = v;
    form.elements.report_language.dispatchEvent(new Event("change", { bubbles: true }));
  };
  pickLanguage("en");
  check("An English report with a Latin name clears the warning as soon as it's picked",
    flag().hidden && $("fullNameLabel").textContent === "Full name in English, as the company knows you",
    flag().textContent + " / " + $("fullNameLabel").textContent);
  form.elements.full_name.value = "אלכס מורגן";
  pickLanguage("en");
  check("A Hebrew name on an English report is flagged the moment the language is picked",
    !flag().hidden && flag().textContent === "The report is in English, so write your full name in English letters.",
    flag().textContent);
  pickLanguage("he");
  check("Putting the report back to Hebrew clears it again", flag().hidden, flag().textContent);

  form.elements.full_name.value = "אלכס מורגן";
  form.elements.rate_warehouse.value = "60";
  form.requestSubmit();
  await wait(400);
  check("Saving puts you back on the month you came from", !$("payView").hidden && $("settingsView").hidden, "pay=" + !$("payView").hidden);
  const put = window.__requests.filter((r) => r.method === "PUT" && r.url.includes("/values/Settings")).pop();
  const rows = put ? JSON.parse(put.body).values : [];
  const row = (key) => rows.find((r) => r[2] === key) || [];
  check("Saving writes the details to the Settings tab", row("rate_warehouse")[1] === "60" && row("full_name")[1] === "אלכס מורגן" && row("rate_night")[1] === "200", put ? put.body : "no PUT sent");
  check("A new rate recalculates the month (8.5 h × ₪60)", total() === "₪4,710.00", total());

  $("payLines").querySelector(".pay-line").click();
  await wait(100);
  const panel = $("dayPanel");
  check("Tapping a row opens that shift", panel.open && panel.querySelectorAll("form").length === 1 && panel.querySelector("form").classList.contains("type-warehouse"), "open=" + panel.open);
  panel.close();

  $("prevMonth").click();
  await wait(400);
  check("The previous month shows its own shifts",
    $("monthTitle").textContent === "August 2026" && $("payLines").querySelectorAll(".pay-line").length === 1 && total() === "₪600.00",
    $("monthTitle").textContent + " / " + $("payLines").querySelectorAll(".pay-line").length + " rows / " + total());

  $("tabShifts").click();
  await wait(50);
  check("Back on Shifts, the board and save bar return", !$("workspace").hidden && !$("saveBar").hidden && $("payView").hidden, "workspace.hidden=" + $("workspace").hidden);
  return out;
})();
