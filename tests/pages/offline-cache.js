// Runs inside the "loaded" preview (run by tests/run.js): the board keeps what it last read from the
// calendar, so with no signal it still shows those shifts and says how old they are.
// One PASS/FAIL line per check.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const check = (name, ok, detail) => out.push((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   [" + detail + "]"));
  const $ = (id) => document.getElementById(id);
  const metas = () => [...document.querySelectorAll("#board .day-meta")].map((m) => m.textContent).join(" | ");

  const key = Object.keys(localStorage).find((k) => k.indexOf("sb_shifts_") === 0);
  const store = key ? JSON.parse(localStorage.getItem(key)) : null;
  const weeks = store ? Object.keys(store.weeks) : [];
  check("What the board reads is kept on the phone", !!store && store.at > 0 && weeks.length > 0, key ? weeks.length + " weeks kept" : "nothing kept");

  const kept = store && weeks.map((w) => store.weeks[w]).find((list) => list.length);
  check("Only the parts of an event this app understands are kept",
    !!kept && Object.keys(kept[0]).sort().join(",") === "end,extendedProperties,id,start,summary",
    kept ? Object.keys(kept[0]).join(",") : "no events kept at all");

  const before = metas();
  check("The board has shifts on it to begin with", before.replace(/\s|\|/g, "").length > 0, before.slice(0, 80));

  // No signal: a request that never leaves the phone is exactly this rejection
  const realFetch = window.fetch;
  window.fetch = () => Promise.reject(new TypeError("Failed to fetch"));

  document.querySelector("#board [data-type]").click();
  $("saveBtn").click();
  await wait(1400);

  check("With no signal the board still shows the shifts it last read", metas() === before, metas().slice(0, 120));
  const banner = $("offlineBanner");
  check("And the notice says when they were read", !banner.hidden && /\d/.test(banner.textContent), banner.textContent.slice(0, 140));
  check("The tap that couldn't be saved is still marked on the board",
    !!document.querySelector("#board [data-type].is-changed"), "nothing left marked as unsaved");

  window.fetch = realFetch;
  return out;
})();
