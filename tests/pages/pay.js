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
  check("The status says the total isn't final yet", $("payStatus").textContent === "2 shifts you've worked have no times yet, so this total isn't final.", $("payStatus").textContent);
  check("Total to pay is the gross salary, without expenses", total() === "₪4,667.50", total());
  const reimburse = $("payTotals").querySelector(".total-line.reimburse strong");
  check("Expenses reimbursement is shown on its own", !!reimburse && reimburse.textContent === "₪370.00", reimburse && reimburse.textContent);
  const breakdown = [...$("payTotals").querySelectorAll(".total-breakdown div")].map((d) => d.textContent).join(" | ");
  check("Breakdown by type",
    breakdown === "Warehouse4 shifts · 8 h 30 min · ₪467.50 | Event5 days · 10 h 00 min extra · ₪3,700.00 | Nights1 night · ₪200.00 | Other1 job · ₪300.00",
    breakdown);
  // Part of that total hasn't been worked yet, which the screen has to say rather than leave to be guessed
  const ahead = $("payTotals").querySelector(".to-come");
  check("It says how much of the total is work still to come",
    !!ahead && /^Includes ₪[\d,.]+ for \d+ shifts still to come\./.test(ahead.textContent), ahead ? ahead.textContent : "nothing said");
  // A Warehouse day is worth nothing until its hours are in, so the month is guessed beside the total,
  // never inside it — the total is copied straight into the pay sheet and must stay fact
  const guessed = (ahead.textContent.match(/in all if.*?$/) || [""])[0];
  check("And guesses the whole month with the missing Warehouse days at 8 hours",
    /^in all if the \d+ missing Warehouse days are 8 hours each\.$/.test(guessed.replace(/^.*?in all/, "in all")), guessed || ahead.textContent);
  const guessedTotal = Number((ahead.textContent.match(/About ₪([\d,]+\.\d\d) in all/) || [0, "0"])[1].replace(/,/g, ""));
  check("The guess is more than the total, and the total itself is untouched",
    guessedTotal > 4667.5 && total() === "₪4,667.50", "guessed " + guessedTotal + " vs total " + total());

  const lines = [...$("payLines").querySelectorAll(".pay-line")];
  const text = (i, cls) => (lines[i] ? lines[i].querySelector("." + cls).textContent : "");
  check("One row per shift that starts this month, in start order",
    lines.length === 10 && text(0, "pay-when") === "Wed, Sep 9" && text(1, "pay-when") === "Fri, Sep 11 · 6:00 AM–4:00 AM (+1)",
    lines.length + " rows; first: " + text(0, "pay-when") + " / " + text(1, "pay-when"));
  check("A row shows hours, extra hours, the night and expenses",
    text(1, "pay-detail") === "22 h 00 min · 10 h 00 min extra · night ₪200.00 · expenses ₪370.00" && text(1, "pay-amount") === "₪1,500.00",
    text(1, "pay-detail") + " / " + text(1, "pay-amount"));
  check("A Warehouse shift without times shows no pay yet", text(0, "pay-detail") === "No times yet" && text(0, "pay-amount") === "–", text(0, "pay-detail") + " / " + text(0, "pay-amount"));
  const future = lines.find((l) => l.querySelector(".pay-detail").textContent === "Still to come");
  check("A shift that hasn't happened says so, instead of being chased for its times",
    !!future && !future.querySelector(".pay-detail").classList.contains("needs-times"),
    future ? "found, needs-times=" + future.querySelector(".pay-detail").classList.contains("needs-times") : "no row says it's still to come");

  const other = lines.find((l) => l.classList.contains("type-other"));
  check("An Other job shows its description and amount",
    !!other && other.querySelector(".pay-detail").textContent === "2 h 00 min · Move speakers" && other.querySelector(".pay-amount").textContent === "₪300.00",
    other ? other.textContent : "no Other row");

  // The clock is a preference of this phone, and switching it redraws what's already on screen
  const whenAt = (i) => [...$("payLines").querySelectorAll(".pay-line")][i].querySelector(".pay-when").textContent;
  const setClock = (v) => {
    $("clockSelect").value = v;
    $("clockSelect").dispatchEvent(new Event("change", { bubbles: true }));
  };
  const setDate = (v) => {
    $("dateSelect").value = v;
    $("dateSelect").dispatchEvent(new Event("change", { bubbles: true }));
  };
  check("English starts off on AM/PM and month-first, as that language reads", /AM|PM/.test(whenAt(1)) && whenAt(1).indexOf("Sep 11") > -1, whenAt(1));
  setClock("24");
  await wait(100);
  check("Choosing 24-hour redraws the times already on screen", whenAt(1) === "Fri, Sep 11 · 06:00–04:00 (+1)", whenAt(1));
  setDate("dmy");
  await wait(100);
  check("Choosing day-first redraws the dates too", whenAt(1) === "Fri 11 Sept · 06:00–04:00 (+1)", whenAt(1));
  setClock("12");
  setDate("mdy");
  await wait(100);
  check("And back again", whenAt(1) === "Fri, Sep 11 · 6:00 AM–4:00 AM (+1)", whenAt(1));

  $("settingsBtn").click();
  await wait(100);
  const form = $("settingsForm");
  check("The details are a screen of their own, with the month put away",
    !$("settingsView").hidden && $("payView").hidden && $("workspace").hidden,
    "settings=" + !$("settingsView").hidden + " pay=" + !$("payView").hidden + " board=" + !$("workspace").hidden);
  check("Details and rates come from the pay sheet",
    form.elements.full_name.value === "אלכס מורגן" && form.elements.rate_event.value === "600",
    form.elements.full_name.value + " / " + form.elements.rate_event.value);
  // The name gates the button, so nobody presses Save only to be told no
  const saveBtn = () => form.querySelector('[type="submit"]');
  const typeName = (v) => {
    form.elements.full_name.value = v;
    form.elements.full_name.dispatchEvent(new Event("input", { bubbles: true }));
  };
  check("Save is ready while the saved name fits", !saveBtn().disabled, "disabled=" + saveBtn().disabled);
  typeName("");
  check("Save goes out of reach with no name", saveBtn().disabled, "disabled=" + saveBtn().disabled);
  typeName("Alex Morgan");
  check("Save stays out of reach while the name is in the wrong letters",
    saveBtn().disabled && form.querySelector(".form-error").textContent === "The report is in Hebrew, so write your full name in Hebrew letters.",
    "disabled=" + saveBtn().disabled + " / " + form.querySelector(".form-error").textContent);
  typeName("אלכס מורגן");
  check("Save comes back once the name fits the report", !saveBtn().disabled && form.querySelector(".form-error").hidden, "disabled=" + saveBtn().disabled);

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

  // The form is refilled from the sheet each time it opens, so walking away from an edit would lose it
  $("settingsBtn").click();
  await wait(150);
  form.elements.rate_night.value = "777";
  $("tabPay").click();
  await wait(150);
  const ask = $("dayPanel");
  const inPanel = (text) => [...ask.querySelectorAll("button")].find((b) => b.textContent === text);
  check("Leaving with a detail unsaved asks in the app's own panel, not a browser box",
    ask.open && ask.querySelector(".panel-head h2").textContent === "Unsaved details" && !!inPanel("Keep editing") && !!inPanel("Leave without saving"),
    "open=" + ask.open + " title=" + ((ask.querySelector(".panel-head h2") || {}).textContent || ""));
  inPanel("Keep editing").click();
  await wait(150);
  check("Keeping it open stays on the settings, with what was typed still there",
    !ask.open && !$("settingsView").hidden && form.elements.rate_night.value === "777",
    "settings=" + !$("settingsView").hidden + " value=" + form.elements.rate_night.value);

  $("tabPay").click();
  await wait(150);
  inPanel("Leave without saving").click();
  await wait(400);
  check("Choosing to leave anyway does leave", $("settingsView").hidden && !$("payView").hidden, "settings=" + !$("settingsView").hidden);
  $("settingsBtn").click();
  await wait(200);
  check("Coming back shows the saved rate, not the abandoned one", form.elements.rate_night.value === "200", form.elements.rate_night.value);
  $("tabPay").click();
  await wait(300);
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
