// Runs inside the "offline-start" preview (run by tests/run.js): the app is opened with no signal at all,
// on a phone that already knows the calendar and last week's shifts. Nothing reaches Google, so this is the
// path a coworker takes in a basement or on a plane. One PASS/FAIL line per check.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const check = (name, ok, detail) => out.push((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   [" + detail + "]"));
  const $ = (id) => document.getElementById(id);
  await wait(900);

  check("Nothing reached Google", window.__requests.filter((r) => r.method === "GET").length === 0, window.__requests.length + " requests were recorded");
  check("The board is built anyway, from the calendar it knew", !$("workspace").hidden && document.querySelectorAll("#board .day").length > 0,
    "board days: " + document.querySelectorAll("#board .day").length);
  check("It knows which calendar it's writing to", $("savingToBtn").textContent.indexOf("alex.morgan.shifts@example.com") > -1, $("savingToBtn").textContent);

  const tapes = [...document.querySelectorAll("#board [data-type].is-on")];
  check("The shifts it last read are on the board", tapes.length > 0, tapes.length + " tapes on");
  const metas = [...document.querySelectorAll("#board .day-meta")].map((m) => m.textContent).join("\n");
  check("With their times", /\d/.test(metas), metas.slice(0, 120) || "(no shift details shown)");

  const banner = $("offlineBanner");
  check("And the notice says there's no signal", !banner.hidden, "hidden=" + banner.hidden);

  return out;
})();
