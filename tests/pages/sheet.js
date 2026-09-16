// Runs inside the "pay" preview (run by tests/run.js): writes September to the fake
// pay sheet in Hebrew (the default report language), switches the report to English, then checks the hand-edit
// prompt. Returns one PASS/FAIL line per check.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const check = (name, ok, detail) => out.push((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   [" + detail + "]"));
  const $ = (id) => document.getElementById(id);
  const hebrew = /[֐-׿]/;
  const title = "2026-09";
  const tabPuts = () => window.__requests.filter((r) => r.method === "PUT" && decodeURIComponent(r.url).includes(title));
  const lastFormat = () => window.__requests.filter((r) => r.url.includes(":batchUpdate") && r.body.includes("CURRENCY")).pop();
  let asked = 0;
  window.confirm = () => (asked++, false);
  await wait(300);

  $("writeSheetBtn").click();
  await wait(500);
  const put = tabPuts().pop();
  const rows = put ? JSON.parse(put.body).values : [];
  const salaryRow = rows.find((r) => r[0] === "סה״כ לתשלום (שכר ברוטו)") || [];
  const expensesRow = rows.find((r) => r[0] === "החזר הוצאות") || [];
  check("Update my sheet writes the month's report (Hebrew by default) into its own tab",
    rows.length > 6 && String(rows[0][0]).startsWith("דוח משמרות - ") && rows[1][3] === "אלכס מורגן" && rows.some((r) => r[0] === "תאריך") &&
      salaryRow[3] === 4667.5 && expensesRow[3] === 370,
    put ? put.body.slice(0, 300) : "no PUT to the month tab");
  const add = window.__requests.find((r) => r.url.includes(":batchUpdate") && r.body.includes('"addSheet"'));
  check("The tab is created with the month's name", !!add && JSON.parse(add.body).requests[0].addSheet.properties.title === title, add ? add.body : "no addSheet");
  const fmt = lastFormat();
  check("The tab is formatted: right to left, shekels, merged bands, rows sized to fit",
    !!fmt && fmt.body.includes('"rightToLeft":true') && fmt.body.includes("₪#,##0.00") && fmt.body.includes("mergeCells") &&
      fmt.body.includes("autoResizeDimensions") && fmt.body.includes("createDeveloperMetadata"),
    fmt ? fmt.body.slice(0, 200) : "no formatting request");
  const link = $("openSheetLink");
  check("An Open in Google Sheets link points at the tab", !link.hidden && /^https:\/\/docs\.google\.com\/spreadsheets\/d\/sheet1\/edit#gid=\d+$/.test(link.href), link.href);

  $("writeSheetBtn").click();
  await wait(500);
  check("Updating again with no hand edits doesn't ask", asked === 0 && tabPuts().length === 2, "asked=" + asked + " writes=" + tabPuts().length);

  // The report language is each person's choice; English rewrites the Settings tab and the month in English
  const form = $("settingsForm");
  const select = form.elements.report_language;
  check("The report language shows Hebrew, as the sheet says",
    select.value === "he" && [...select.options].map((o) => o.textContent).join("|") === "עברית|English", select.value);
  select.value = "en";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  form.requestSubmit();
  await wait(100);
  check("Switching to English asks for the name in English letters",
    $("fullNameLabel").textContent === "Full name in English, as the company knows you" &&
      form.querySelector(".form-error").textContent === "The report is in English, so write your full name in English letters." &&
      !window.__requests.some((r) => r.method === "PUT" && r.url.includes("/values/Settings")),
    $("fullNameLabel").textContent + " / " + form.querySelector(".form-error").textContent);
  form.elements.full_name.value = "Alex Morgan";
  form.requestSubmit();
  await wait(500);
  const settingsPut = window.__requests.filter((r) => r.method === "PUT" && r.url.includes("/values/Settings")).pop();
  const settingsRows = settingsPut ? JSON.parse(settingsPut.body).values : [];
  check("The Settings tab is rewritten all in English, the language by name",
    (settingsRows[0] || [])[0] === "Settings" && settingsRows.some((r) => r[0] === "Report language" && r[1] === "English" && r[2] === "report_language") &&
      settingsRows.some((r) => r[0] === "Full name" && r[1] === "Alex Morgan") && !settingsRows.some((r) => hebrew.test(r.slice(0, 2).join(" "))),
    settingsPut ? settingsPut.body.slice(0, 300) : "no PUT to Settings");
  const settingsFmt = window.__requests.filter((r) => r.url.includes(":batchUpdate") && r.body.includes("hiddenByUser")).pop();
  check("The Settings tab runs left to right and hides the keys column",
    !!settingsFmt && settingsFmt.body.includes('"rightToLeft":false') && /"startIndex":2,"endIndex":3\},"properties":\{"hiddenByUser":true/.test(settingsFmt.body),
    settingsFmt ? settingsFmt.body.slice(0, 300) : "no Settings formatting");

  $("writeSheetBtn").click();
  await wait(500);
  const enRows = tabPuts().length === 3 ? JSON.parse(tabPuts().pop().body).values : [];
  check("With English chosen, the month's report is all English and left to right, without asking",
    String((enRows[0] || [])[0]).startsWith("Shift report - ") && enRows.some((r) => r[0] === "Total to pay (gross salary)" && r[3] === 4667.5) &&
      enRows.some((r) => r[0] === "Date") && !enRows.some((r) => r.some((v) => hebrew.test(String(v)))) &&
      lastFormat().body.includes('"rightToLeft":false') && asked === 0,
    "writes=" + tabPuts().length + " asked=" + asked + " first=" + JSON.stringify(enRows[0]));

  window.__tabValues[title][7][7] = 999; // someone typed over a cell in the sheet
  $("writeSheetBtn").click();
  await wait(500);
  check("A hand-edited tab asks first, and 'Cancel' keeps it", asked === 1 && tabPuts().length === 3 && window.__tabValues[title][7][7] === 999,
    "asked=" + asked + " writes=" + tabPuts().length);

  $("nextMonth").click();
  await wait(50);
  check("Moving to another month hides the old month's link", link.hidden, "hidden=" + link.hidden);
  return out;
})();
