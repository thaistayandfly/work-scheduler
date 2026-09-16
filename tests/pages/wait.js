// Lets a preview settle, for a screenshot of it as it loads: tests/run.js
(async () => {
  await new Promise((r) => setTimeout(r, 700));
  return ["settled"];
})();
