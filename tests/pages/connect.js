// Runs inside the "pay-connect" preview (a saved token without the Drive permission)
(async () => {
  await new Promise((r) => setTimeout(r, 300));
  const $ = (id) => document.getElementById(id);
  const ok = !$("payView").hidden && !$("driveConnect").hidden && $("payContent").hidden && $("connectDriveBtn").textContent === "Connect Google Drive";
  return [(ok ? "PASS  " : "FAIL  ") + "Without the Drive permission, Pay asks to connect Google Drive"];
})();
