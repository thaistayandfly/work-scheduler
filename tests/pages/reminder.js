// Runs inside the "reminder" preview (the device knows the pay sheet; August has a shift and wasn't sent)
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const check = (name, ok, detail) => out.push((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   [" + detail + "]"));
  const $ = (id) => document.getElementById(id);
  await wait(600);
  const btn = $("sendReminderBtn");
  check("An unsent last month gets a nudge on the board", !btn.hidden && btn.textContent === "August 2026 hasn't been sent to the company yet", btn.textContent);
  check("Never two red banners at once",
    [$("needsTimesBtn"), $("sendReminderBtn")].filter((b) => !b.hidden).length <= 1,
    "needsTimes=" + !$("needsTimesBtn").hidden + " reminder=" + !$("sendReminderBtn").hidden);
  btn.click();
  await wait(700);
  check("Tapping it opens the Pay tab on that month", !$("payView").hidden && $("monthTitle").textContent === "August 2026", $("monthTitle").textContent);
  return out;
})();
