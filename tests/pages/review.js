// Leaves a "pay" preview on August's send review, for a screenshot: tests/run.js
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  await wait(300);
  $("prevMonth").click();
  await wait(600);
  $("payLines").querySelector(".pay-line").click();
  await wait(100);
  const form = $("dayPanel").querySelector("form");
  form.elements.startTime.value = "08:00";
  form.elements.endTime.value = "21:00";
  form.requestSubmit();
  await wait(800);
  $("sendBtn").click();
  const panel = $("dayPanel");
  for (let i = 0; i < 100 && !panel.querySelector("a[href^='blob:']") && panel.querySelector(".form-error").hidden; i++) await wait(100);
  return ["review open: " + $("dayPanel").open + ", send status before: " + $("sendStatus").textContent];
})();
