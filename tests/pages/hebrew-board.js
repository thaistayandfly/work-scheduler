// Runs inside the Hebrew "loaded" preview (run by tests/run.js): the board and a day's
// panel in Hebrew, right to left, with no English left over. Returns one PASS/FAIL line per check.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const check = (name, ok, detail) => out.push((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   [" + detail + "]"));
  const $ = (id) => document.getElementById(id);
  const norm = (s) => s.replace(/[‎‏]/g, "").replace(/ /g, " ");
  // Visible English words, apart from product names and the person's own calendar and address
  const englishIn = (root) => {
    const words = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (!parent || parent.closest("#calendarSelect, #accountEmail, #langBtn, .brand") || !parent.getClientRects().length) continue;
      (walker.currentNode.textContent.match(/[A-Za-z]+/g) || []).forEach((w) => /^(Google|ShiftBoard|Drive|Sheets)$/.test(w) || words.push(w));
    }
    return words;
  };
  await wait(300);

  const root = document.documentElement;
  check("The page is Hebrew and runs right to left", root.lang === "he" && root.dir === "rtl" && getComputedStyle(document.body).direction === "rtl",
    root.lang + " / " + root.dir);
  check("The language switch offers English", $("langBtn").textContent === "English" && $("langBtn").lang === "en", $("langBtn").textContent);
  check("Tabs and the save bar are in Hebrew",
    $("tabShifts").textContent === "משמרות" && $("tabPay").textContent === "שכר" && $("statusText").textContent === "אין שינויים שלא נשמרו" &&
      $("saveBtn").textContent === "שמירה ביומן",
    [$("tabShifts").textContent, $("statusText").textContent, $("saveBtn").textContent].join(" / "));
  const tapes = [...document.querySelectorAll("#board .tape-label")].map((t) => t.textContent);
  check("The tapes read אירוע and מחסן", tapes[0] === "אירוע" && tapes[1] === "מחסן", tapes.slice(0, 2).join(" / "));
  const tape = document.querySelector("#board .tape");
  check("Event is the first tape, on the right", tape.getBoundingClientRect().left > document.querySelectorAll("#board .tape")[1].getBoundingClientRect().left, "");
  const dows = [...document.querySelectorAll("#board .dow")].slice(0, 7).map((d) => d.textContent).join(" ");
  check("Days are Hebrew letters, the week from Sunday", dows === "א׳ ב׳ ג׳ ד׳ ה׳ ו׳ ש׳", dows);
  const weekTitle = document.querySelector("#board .week-title").textContent;
  check("This week is named", weekTitle.startsWith("השבוע"), weekTitle);
  const metas = [...document.querySelectorAll("#board .day-meta:not([hidden])")].map((m) => norm(m.textContent));
  check("A past shift without times says so", metas[0] === "אירוע: חסרות שעות", metas[0]);
  check("Times and amounts under the tapes", metas[1] === "מחסן 09:00–17:30\nאחר 18:00–20:00, 300.00 ₪", JSON.stringify(metas[1]));
  const english = englishIn(document.body);
  check("No English words on the board", english.length === 0, english.slice(0, 10).join(", "));

  document.querySelectorAll("#board .day-label")[2].click(); // Tuesday (the week starts on Sunday)
  await wait(150);
  const panel = $("dayPanel");
  const forms = [...panel.querySelectorAll("form")];
  check("A day's panel is in Hebrew",
    panel.open && forms.length === 2 && forms[0].querySelector("h3").textContent === "מחסן" && forms[0].querySelector(".when-label").textContent === "התחלה" &&
      forms[0].querySelector("[type=submit]").textContent === "שמירת המשמרת" && forms[1].querySelector("[type=submit]").textContent === "שמירת העבודה",
    forms.map((f) => f.querySelector("h3").textContent + ":" + f.querySelector("[type=submit]").textContent).join(" / "));
  check("Durations are in Hebrew", forms[0].querySelector(".duration").textContent === "8 ש׳ 30 דק׳", forms[0].querySelector(".duration").textContent);
  forms[0].querySelector(".expenses .btn-text").click();
  const options = [...forms[0].querySelectorAll(".expense option")].map((o) => o.textContent).join(" ");
  check("Expense types are in Hebrew", options === "נסיעות אוכל מלון אחר", options);
  const panelEnglish = englishIn(panel);
  check("No English words in the panel", panelEnglish.length === 0, panelEnglish.slice(0, 10).join(", "));
  forms[0].elements.endTime.value = "";
  forms[0].requestSubmit();
  await wait(50);
  check("Form errors are in Hebrew", forms[0].querySelector(".form-error").textContent === "הזינו שעת התחלה ושעת סיום.", forms[0].querySelector(".form-error").textContent);
  panel.close();

  document.querySelectorAll("#board .tape")[4].click(); // Tuesday · Event
  await wait(50);
  check("Pending changes are counted in Hebrew", $("statusText").textContent === "1 להוספה", $("statusText").textContent);
  return out;
})();
