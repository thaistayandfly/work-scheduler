// Runs inside the "loaded" preview on a 320px phone (run by tests/run.js). Small screens are where things
// quietly land on top of each other: a flex row squeezed past its contents doesn't scroll or wrap, it just
// overlaps, and nothing reports it. One PASS/FAIL line per check.
(async () => {
  const out = [];
  const check = (name, ok, detail) => out.push((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   [" + detail + "]"));
  const seen = (el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  const name = (el) => el.id || el.className || el.tagName.toLowerCase();

  // Every pair of things in a row that a finger could aim at, checked against each other
  const collisions = (root, what) => {
    const boxes = [...root.querySelectorAll(what)].filter(seen);
    const hits = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (boxes[i].contains(boxes[j]) || boxes[j].contains(boxes[i])) continue;
        const a = boxes[i].getBoundingClientRect();
        const b = boxes[j].getBoundingClientRect();
        const over = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        if (over) hits.push(name(boxes[i]) + " over " + name(boxes[j]));
      }
    }
    return hits;
  };

  const top = collisions(document.querySelector(".topbar"), "button, .account-email, .brand");
  check("Nothing in the top bar sits on top of anything else", top.length === 0, top.join(", "));

  const tabs = collisions(document.getElementById("viewTabs"), "button");
  check("The Shifts and Pay tabs keep apart", tabs.length === 0, tabs.join(", "));

  const bar = collisions(document.getElementById("saveBar"), "button, p");
  check("The save bar keeps its status and its button apart", bar.length === 0, bar.join(", "));

  const doc = document.documentElement;
  check("The page doesn't scroll sideways", doc.scrollWidth <= doc.clientWidth, doc.scrollWidth + " > " + doc.clientWidth);

  const small = [...document.querySelectorAll(".topbar button, #viewTabs button, #saveBar button")]
    .filter(seen)
    .filter((el) => el.getBoundingClientRect().height < 44)
    .map((el) => name(el) + " " + Math.round(el.getBoundingClientRect().height) + "px tall");
  check("Every control up here is still big enough to hit", small.length === 0, small.join(", "));

  return out;
})();
