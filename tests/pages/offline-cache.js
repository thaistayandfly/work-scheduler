// Runs inside the "loaded" preview (run by tests/run.js): the board keeps what it last read from the
// calendar, so with no signal it still shows those shifts and says how old they are; a change made with
// no signal is kept as a draft and offered again once there's one. One PASS/FAIL line per check.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const check = (name, ok, detail) => out.push((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   [" + detail + "]"));
  const $ = (id) => document.getElementById(id);
  const waitingLine = (line) => line.indexOf("waiting to be saved") > -1;
  // The shifts themselves, with any "waiting to be saved" note left out
  const shifts = () =>
    [...document.querySelectorAll("#board .day-meta")]
      .map((m) => m.textContent.split("\n").filter((line) => !waitingLine(line)).join("\n"))
      .join(" | ");
  const boardText = () => [...document.querySelectorAll("#board .day-meta")].map((m) => m.textContent).join("\n");
  const draftStore = () => {
    const key = Object.keys(localStorage).find((k) => k.indexOf("sb_drafts_") === 0);
    return key ? JSON.parse(localStorage.getItem(key)) : [];
  };

  const key = Object.keys(localStorage).find((k) => k.indexOf("sb_shifts_") === 0);
  const store = key ? JSON.parse(localStorage.getItem(key)) : null;
  const weeks = store ? Object.keys(store.weeks) : [];
  check("What the board reads is kept on the phone", !!store && store.at > 0 && weeks.length > 0, key ? weeks.length + " weeks kept" : "nothing kept");

  const kept = store && weeks.map((w) => store.weeks[w]).find((list) => list.length);
  check("Only the parts of an event this app understands are kept",
    !!kept && Object.keys(kept[0]).sort().join(",") === "end,extendedProperties,id,start,summary",
    kept ? Object.keys(kept[0]).join(",") : "no events kept at all");

  const before = shifts();
  check("The board has shifts on it to begin with", before.replace(/\s|\|/g, "").length > 0, before.slice(0, 80));

  // No signal: a request that never leaves the phone is exactly this rejection
  const realFetch = window.fetch;
  window.fetch = () => Promise.reject(new TypeError("Failed to fetch"));

  document.querySelector("#board [data-type]").click();
  $("saveBtn").click();
  await wait(1400);

  check("With no signal the board still shows the shifts it last read", shifts() === before, shifts().slice(0, 120));
  const banner = $("offlineBanner");
  check("And the notice says when they were read", !banner.hidden && /\d/.test(banner.textContent), banner.textContent.slice(0, 140));
  check("The change made with no signal is kept as a draft", draftStore().length === 1, JSON.stringify(draftStore()).slice(0, 160));
  check("Its own day says a change is waiting", waitingLine(boardText()), boardText().slice(0, 120));
  check("And nothing pretends it reached the calendar", $("toast").textContent.indexOf("saved when you're back online") > -1, $("toast").textContent);

  // Back on a signal: the change is offered, never applied behind anyone's back
  window.fetch = realFetch;
  window.dispatchEvent(new Event("online"));
  await wait(800);
  const ask = $("dayPanel");
  const listed = [...ask.querySelectorAll(".draft-list li")].map((li) => li.textContent);
  check("Coming back online offers the waiting change and says what it is",
    ask.open && listed.length === 1 && listed[0].indexOf("Event") > -1, listed.join(" | ") || "nothing was offered");

  // Whichever way the tape was tapped, adding or removing, it reaches the calendar as a write
  const writes = () => window.__requests.filter((r) => r.method !== "GET").length;
  const before2 = writes();
  const button = (text) => [...ask.querySelectorAll("button")].find((b) => b.textContent === text);
  button("Save them now").click();
  await wait(1200);
  check("Saving them puts the change in the calendar and clears the drafts",
    writes() > before2 && draftStore().length === 0,
    "writes " + before2 + " -> " + writes() + ", drafts left " + draftStore().length);

  return out;
})();
