// Runs inside the "loaded" preview (run by tests/run.js): the hour Google allows runs out while someone is
// using the app. What must not happen is the whole thing vanishing back to the welcome page with their work
// on it. One PASS/FAIL line per check.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const check = (name, ok, detail) => out.push((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   [" + detail + "]"));
  const $ = (id) => document.getElementById(id);
  const draftStore = () => {
    const key = Object.keys(localStorage).find((k) => k.indexOf("sb_drafts_") === 0);
    return key ? JSON.parse(localStorage.getItem(key)) : [];
  };

  check("Signed in, there's nothing asking anyone to sign in again", $("signInAgain").hidden, "bar showing already");
  // The shifts themselves, with any "waiting to be saved" note left out
  const shifts = () =>
    [...document.querySelectorAll("#board .day-meta")]
      .map((m) => m.textContent.split("\n").filter((line) => line.indexOf("waiting to be saved") === -1).join("\n"))
      .join(" | ");
  const shiftsBefore = shifts();

  // The hour is up, and the next thing that touches Google finds out
  tokenExpiresAt = 0;
  document.querySelector("#board [data-type]").click();
  $("saveBtn").click();
  await wait(500);

  check("The board is still there", !$("workspace").hidden && $("welcome").hidden,
    "board hidden=" + $("workspace").hidden + " welcome hidden=" + $("welcome").hidden);
  check("And it still shows the shifts it had", shifts() === shiftsBefore, shifts().slice(0, 120));
  check("One tap is offered to carry on", !$("signInAgain").hidden && $("signInAgain").textContent.length > 10, $("signInAgain").textContent);
  check("The tap that couldn't be saved is still marked", !!document.querySelector("#board [data-type].is-changed"), "nothing left marked");
  check("The Shifts and Pay tabs are still usable", !$("viewTabs").hidden, "the tabs went away");
  check("What couldn't be saved is kept rather than lost", draftStore().length > 0, "nothing was kept");
  check("And it says the sign-in is what it's waiting for",
    $("toast").textContent.indexOf("saved when you sign in") > -1, $("toast").textContent);

  // The point of all this: enter your times first, sign in afterwards
  const kept = draftStore().length;
  document.querySelectorAll("#board .day-label")[1].click();
  await wait(200);
  const form = $("dayPanel").querySelector("form");
  check("A day still opens, signed out or not", !!form, "no form in the panel");
  if (form) {
    const box = (n) => form.elements[n].closest(".pickable").querySelector(".shown");
    const put = (n, v) => {
      box(n).value = v;
      box(n).dispatchEvent(new Event("change", { bubbles: true }));
    };
    put("startTime", "0900");
    put("endTime", "1700");
    form.requestSubmit();
    await wait(600);
    check("Times typed while signed out are kept, not refused", draftStore().length === kept + 1, "drafts " + kept + " -> " + draftStore().length);
    check("And the day says a change is waiting",
      [...document.querySelectorAll("#board .day-meta")].some((m) => m.textContent.indexOf("waiting to be saved") > -1),
      "no day mentions it");
  }

  return out;
})();
