// Runs inside the "loaded" preview page (run by tests/run.js): drives the day panel like a person would and
// checks what the app would write to Google Calendar. Returns one PASS/FAIL line per check.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const check = (name, ok, detail) => out.push((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   [" + detail + "]"));
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const buttonNamed = (root, text) => [...root.querySelectorAll("button")].find((b) => b.textContent === text);
  const setInput = (form, name, value) => {
    form.elements[name].value = value;
    form.elements[name].dispatchEvent(new Event("change", { bubbles: true }));
  };

  const rows = [...document.querySelectorAll("#board .day")];
  const meta = (i) => rows[i].querySelector(".day-meta");
  check("A past shift with no times says so", !meta(0).hidden && meta(0).textContent === "Event: add times" && meta(0).classList.contains("needs-times"), meta(0).textContent);
  check("Timed shifts and Other jobs show their times and amount", meta(1).textContent === "Warehouse 9:00 AM–5:30 PM\nOther 6:00 PM–8:00 PM, ₪300.00", meta(1).textContent);
  check("Future shifts don't ask for times", meta(3).hidden, meta(3).textContent);
  const banner = document.getElementById("needsTimesBtn");
  check("The banner counts past shifts missing times (this month and last)", !banner.hidden && banner.textContent === "3 shifts still need their times", banner.textContent);

  // Monday: an Event with no times yet
  rows[0].querySelector(".day-label").click();
  await wait(100);
  const panel = document.getElementById("dayPanel");
  let form = panel.querySelector("form");
  check("Tapping a date opens that day's panel", panel.open && panel.querySelectorAll("form").length === 1 && form.classList.contains("type-event"), "open=" + panel.open);
  const rootOverflow = () => getComputedStyle(document.documentElement).overflowY;
  check("While the panel is open the board underneath can't scroll", rootOverflow() === "hidden", rootOverflow());
  form.requestSubmit();
  await wait(50);
  const error = () => form.querySelector(".form-error").textContent;
  check("Saving without times is refused with a message", error() === "Enter the start and end time." && !window.__requests.some((r) => r.method === "PATCH"), error());
  setInput(form, "startTime", "06:00");
  setInput(form, "endTime", "04:00");
  const next = new Date(rows[0].dataset.date + "T00:00");
  next.setDate(next.getDate() + 1);
  const duration = form.querySelector(".duration").textContent;
  check("An end time before the start rolls to the next day", form.elements.endDate.value === ymd(next) && duration === "22 h 00 min, of which 10 h 00 min extra", form.elements.endDate.value + " / " + duration);
  form.elements.slept.checked = true;
  buttonNamed(form, "Add an expense").click();
  const expense = form.querySelector(".expense");
  const kinds = [...expense.querySelectorAll("option")].map((o) => o.textContent).join(" ");
  check("Fuel is offered instead of Hotel", kinds === "Travel Fuel Food Other", kinds);
  expense.querySelector("select").value = "Travel";
  expense.querySelector("input").value = "250";
  check("A named expense needs no description", expense.querySelector(".expense-note").hidden, "hidden=" + expense.querySelector(".expense-note").hidden);

  buttonNamed(form, "Add an expense").click();
  const loose = [...form.querySelectorAll(".expense")][1];
  loose.querySelector("select").value = "Other";
  loose.querySelector("select").dispatchEvent(new Event("change"));
  check("Choosing Other offers a description", !loose.querySelector(".expense-note").hidden, "hidden=" + loose.querySelector(".expense-note").hidden);
  loose.querySelector('input[type="number"]').value = "80";
  loose.querySelector(".expense-note").value = "Parking at the venue";
  form.requestSubmit();
  await wait(400);
  const patch = window.__requests.find((r) => r.method === "PATCH");
  const body = patch ? JSON.parse(patch.body) : null;
  const start = body && new Date(body.start.dateTime);
  const end = body && new Date(body.end.dateTime);
  check("Saving turns the all-day event into a timed one",
    !!body && body.start.date === null && body.end.date === null && ymd(start) === rows[0].dataset.date && start.getHours() === 6 && ymd(end) === ymd(next) && end.getHours() === 4,
    patch ? patch.body : "no PATCH sent");
  const props = body ? body.extendedProperties.private : {};
  check("The night and both expenses are stored on the event, the description with the loose one",
    props.workType === "Event" && props.appTag === "shiftboard" && props.slept === "1" &&
      props.expenses === '[{"type":"Travel","amount":250},{"type":"Other","amount":80,"note":"Parking at the venue"}]',
    JSON.stringify(props));
  // English shows AM/PM unless this phone was told otherwise
  check("The panel closes and the board shows the new times", !panel.open && meta(0).textContent === "Event 6:00 AM–4:00 AM (+1), night, ₪330.00 expenses" && !meta(0).classList.contains("needs-times"),
    "open=" + panel.open + " meta=" + meta(0).textContent);
  check("The banner count drops after saving", banner.textContent === "2 shifts still need their times", banner.textContent);

  // Wednesday: nothing saved, so the day opens straight into an Other job
  rows[2].querySelector(".day-label").click();
  await wait(100);
  form = panel.querySelector("form.type-other");
  const note = panel.querySelector(".panel-note");
  check("An empty day opens straight into an Other job form",
    panel.open && !!form && panel.querySelectorAll("form").length === 1 && !buttonNamed(panel, "Add an Other job") &&
      !!note && note.textContent === "Event and Warehouse are the tapes on the board. Any other paid job goes here.",
    "open=" + panel.open + " forms=" + panel.querySelectorAll("form").length + " note=" + (note && note.textContent));
  setInput(form, "startTime", "10:00");
  setInput(form, "endTime", "12:30");
  form.requestSubmit();
  await wait(50);
  check("An Other job needs an amount", error() === "Enter how much this job paid.", error());
  form.elements.amount.value = "300";
  form.elements.note.value = "Move gear to Pattaya";
  form.requestSubmit();
  await wait(400);
  const post = window.__requests.filter((r) => r.method === "POST").pop();
  const created = post ? JSON.parse(post.body) : {};
  const cp = created.extendedProperties ? created.extendedProperties.private : {};
  check("The Other job is created with its times, amount and description",
    created.summary === "Other – Move gear to Pattaya" && cp.workType === "Other" && cp.amount === "300" && cp.note === "Move gear to Pattaya" && new Date(created.start.dateTime).getHours() === 10,
    post ? post.body : "no POST sent");
  check("The board shows the Other job", meta(2).textContent === "Other 10:00 AM–12:30 PM, ₪300.00", meta(2).textContent);

  // The missing-times list keeps the panel open until every shift is done
  banner.click();
  await wait(100);
  check("The missing-times list shows one form per shift", panel.open && panel.querySelectorAll("form").length === 2, panel.querySelectorAll("form").length + " forms");
  form = panel.querySelector("form");
  setInput(form, "startTime", "09:00");
  setInput(form, "endTime", "17:00");
  form.requestSubmit();
  await wait(400);
  check("Saving one shift in the list keeps the rest open", panel.open && panel.querySelectorAll("form").length === 1, "open=" + panel.open + " forms=" + panel.querySelectorAll("form").length);
  panel.close();

  // "+ Other job" in a week's header: no tape needed; dated today, and moving the start day moves the end with it
  const weekOther = document.querySelector("#board .week-head .week-other");
  check("Each week's header offers + Other job",
    !!weekOther && weekOther.textContent === "Other job" && weekOther.getAttribute("aria-label").startsWith("Add an Other job, week of ") &&
      document.querySelectorAll("#board .week-other").length === document.querySelectorAll("#board .week").length,
    weekOther ? weekOther.textContent + " / " + weekOther.getAttribute("aria-label") : "no button");
  weekOther.click();
  await wait(100);
  form = panel.querySelector("form.type-other");
  check("It opens an Other job dated today", panel.open && !!form && panel.querySelectorAll("form").length === 1 &&
    form.elements.startDate.value === ymd(new Date()) && document.getElementById("dayPanelTitle").textContent === "Add an Other job",
    "open=" + panel.open + " date=" + (form && form.elements.startDate.value));
  setInput(form, "startTime", "22:00");
  setInput(form, "endTime", "02:00");
  const twoDaysAgo = new Date();
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  setInput(form, "startDate", ymd(twoDaysAgo));
  const endDay = new Date(twoDaysAgo);
  endDay.setDate(endDay.getDate() + 1);
  check("Moving the start day moves the end with it", form.elements.endDate.value === ymd(endDay) && form.querySelector(".duration").textContent === "4 h 00 min",
    form.elements.startDate.value + " → " + form.elements.endDate.value + " / " + form.querySelector(".duration").textContent);
  panel.close();
  await wait(50);
  check("Closing the panel lets the board scroll again", rootOverflow() !== "hidden", rootOverflow());
  return out;
})();
