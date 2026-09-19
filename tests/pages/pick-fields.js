// Runs inside the "panel" preview (run by tests/run.js): the date and time boxes in a day's panel are the
// app's own, in the format this phone chose, with the phone's picker behind the button beside each one.
// This page is English, so it starts on month-first dates and AM/PM times. One PASS/FAIL line per check.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const check = (name, ok, detail) => out.push((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   [" + detail + "]"));
  const form = document.querySelector("#dayPanel form");
  const held = (name) => form.elements[name];
  const box = (name) => held(name).closest(".pickable").querySelector(".shown");
  const native = (name) => held(name).closest(".pickable").querySelector(".native");
  const type = (name, text) => {
    box(name).value = text;
    box(name).dispatchEvent(new Event("change", { bubbles: true }));
  };

  check("The date box is the app's own, not the phone's", box("startDate").type === "text", box("startDate").type);
  check("It shows the tapped day in this phone's format", box("startDate").value === "09/14/2026", box("startDate").value);
  check("The empty time box says what shape it wants", box("startTime").placeholder === "h:mm am", box("startTime").placeholder);
  check("The phone's own picker is still there, on the same day", native("startDate").type === "date" && native("startDate").value === held("startDate").value,
    native("startDate").type + " / " + native("startDate").value);

  // A bare number is read as a 24-hour time, so an evening shift can be typed the short way
  type("startTime", "1830");
  await wait(50);
  check("Typing 1830 is understood and said back as this phone reads it",
    held("startTime").value === "18:30" && box("startTime").value === "6:30 PM",
    held("startTime").value + " / " + box("startTime").value);

  type("endTime", "2:00 am");
  await wait(50);
  check("An am/pm time is understood too", held("endTime").value === "02:00", held("endTime").value);
  check("And ending before it started still rolls to the next day", held("endDate").value > held("startDate").value,
    held("startDate").value + " -> " + held("endDate").value);
  check("The rolled end date is redrawn in the box as well", box("endDate").value === "09/15/2026", box("endDate").value);

  // Month-first here, so this is the 9th of December, not the 12th of September
  type("startDate", "12/09/2026");
  await wait(50);
  check("A typed date is read month-first on this phone", held("startDate").value === "2026-12-09", held("startDate").value);

  type("startDate", "31/31/2026");
  await wait(50);
  check("A date that doesn't exist is refused and the box put back", held("startDate").value === "2026-12-09" && box("startDate").value === "12/09/2026",
    held("startDate").value + " / " + box("startDate").value);

  type("startTime", "banana");
  await wait(50);
  check("So is a time nobody could read", held("startTime").value === "18:30" && box("startTime").value === "6:30 PM",
    held("startTime").value + " / " + box("startTime").value);

  return out;
})();
