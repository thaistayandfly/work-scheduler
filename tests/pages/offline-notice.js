// Runs inside the "loaded" preview page (run by tests/run.js): the offline notice sits between the view
// tabs and the board, in a container with no padding of its own, so its own spacing is the only thing
// holding it off them. Returns one PASS/FAIL line per check.
(async () => {
  const out = [];
  const say = (ok, good, bad) => out.push(ok ? "PASS  " + good : "FAIL  " + bad);

  const banner = document.getElementById("offlineBanner");
  const tabs = document.getElementById("viewTabs");
  say(!!banner, "The offline notice is in the page", "There's no offline notice in the page");
  if (!banner) return out;

  say(banner.hidden, "It stays out of the way while there's a signal", "It shows even when there's a signal");

  banner.hidden = false;
  const b = banner.getBoundingClientRect();

  if (tabs && !tabs.hidden) {
    const above = Math.round(b.top - tabs.getBoundingClientRect().bottom);
    say(above >= 8, "It keeps clear of the Shifts and Pay tabs (" + above + "px)", "It touches the tabs above it (" + above + "px)");
  }

  let next = banner.nextElementSibling;
  while (next && next.hidden) next = next.nextElementSibling;
  if (next) {
    const below = Math.round(next.getBoundingClientRect().top - b.bottom);
    say(below >= 8, "It keeps clear of what's below it (" + below + "px)", "It touches what's below it (" + below + "px)");
  }

  const doc = document.documentElement;
  say(doc.scrollWidth <= doc.clientWidth, "It doesn't push the page sideways", "It makes the page scroll sideways");
  say(b.width > 200, "It's wide enough to read", "It's only " + Math.round(b.width) + "px wide");

  banner.hidden = true;
  return out;
})()
