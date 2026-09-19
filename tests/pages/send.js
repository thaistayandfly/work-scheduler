// Runs inside the English "pay" preview (run by tests/run.js): sends August to the company
// through the fake Google APIs, checks what would reach Gmail and Drive, then reopens the month and sends a
// correction. The report language there is Hebrew (the default), so the email is Hebrew. One PASS/FAIL per check.
(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (test, ms = 10000) => {
    const end = Date.now() + ms;
    while (!test() && Date.now() < end) await wait(100);
    return test();
  };
  const out = [];
  const check = (name, ok, detail) => out.push((ok ? "PASS  " : "FAIL  ") + name + (ok ? "" : "   [" + detail + "]"));
  const $ = (id) => document.getElementById(id);
  const panel = $("dayPanel");
  const status = () => $("sendStatus").textContent;
  const total = () => $("payTotals").querySelector(".total-line strong").textContent;
  const utf8 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0)));
  // A raw Gmail message read back: headers with their encoded words decoded, and the base64 parts
  const readMail = (mail) => {
    const mime = atob(mail.raw.replace(/-/g, "+").replace(/_/g, "/"));
    const head = mime.slice(0, mime.indexOf("\r\n\r\n")).replace(/\r\n /g, " ");
    const header = (name) => {
      const m = head.match(new RegExp("^" + name + ": (.*)$", "mi"));
      return m ? m[1].replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/g, (x, b) => utf8(b)).trim() : "";
    };
    const part = (type) => {
      const m = mime.match(new RegExp("Content-Type: " + type + "[^]*?\\r\\n\\r\\n([^]*?)\\r\\n--"));
      return m ? m[1] : "";
    };
    return {
      to: header("To"),
      bcc: header("Bcc"),
      subject: header("Subject"),
      text: utf8(part("text/plain")),
      html: utf8(part("text/html")),
      pdf: atob(part("application/pdf").replace(/\s+/g, "")),
      disposition: (mime.match(/Content-Disposition: [^\r\n]*/) || [""])[0],
    };
  };
  // Passing no start leans on the form pre-filling the time already saved, which is the point
  const timeShift = async (start, end) => {
    $("payLines").querySelector(".pay-line").click();
    await wait(200);
    const form = panel.querySelector("form");
    if (start) form.elements.startTime.value = start;
    form.elements.endTime.value = end;
    form.requestSubmit();
    await wait(800);
  };
  await wait(300);

  check("This month can't be sent while shifts have no times",
    $("sendBtn").disabled && status() === "Not sent to the company yet. Add times to every shift before sending.", status());
  $("prevMonth").click();
  await wait(600);
  check("August has a shift without times, so Send waits",
    $("monthTitle").textContent === "August 2026" && $("sendBtn").disabled && / Add times to every shift before sending\.$/.test(status()), status());

  await timeShift("08:00", "21:00"); // 13 hours: the Event day and one extra hour
  check("With every shift timed, August can be sent",
    !$("sendBtn").disabled && status() === "Not sent to the company yet." && $("sendBtn").textContent === "Review and send" && total() === "₪670.00",
    status() + " / " + total());

  // The review
  $("sendBtn").click();
  await until(() => panel.querySelector("a[href^='blob:']") || !panel.querySelector(".form-error").hidden);
  const facts = [...panel.querySelectorAll(".send-facts div")].map((d) => d.textContent).join(" | ");
  check("The review shows the recipient, the name, the report language and the totals",
    panel.open && $("dayPanelTitle").textContent === "Send August 2026" &&
      facts === "Toshifts@example.co.il | Copy toalex.morgan.shifts@example.com | Name on the reportאלכס מורגן | Report languageעברית | Shifts1 shift | Total to pay (gross salary)₪670.00 | Expenses reimbursement₪0.00",
    facts);
  const augTab = window.__tabs.find((t) => t.properties.title === "2026-08");
  const pdfLink = panel.querySelector("a[href^='blob:']");
  const pdfText = pdfLink ? new TextDecoder("latin1").decode(await (await fetch(pdfLink.href)).arrayBuffer()) : "";
  check("The PDF to check is the app's own: one A4 landscape page, with August's tab written alongside",
    pdfText.startsWith("%PDF-1.4") && /\/Count 1 /.test(pdfText) && pdfText.indexOf("/MediaBox [0 0 842 595]") > -1 && pdfText.indexOf("/Filter /DCTDecode") > -1 &&
      !!augTab && !window.__requests.some((r) => r.url.indexOf("docs.google.com") > -1),
    pdfLink ? pdfText.slice(0, 60) : panel.querySelector(".form-error").textContent);
  let send = panel.querySelector(".form-actions .btn-primary");
  const agree = panel.querySelector(".check input");
  check("The very first send waits for the name and email to be confirmed",
    !!agree && send.disabled && send.textContent === "Send to the company" && !!panel.querySelector(".send-review .fine"), "agree=" + !!agree + " disabled=" + send.disabled);
  agree.click();
  check("Confirming them enables Send", !send.disabled, "disabled=" + send.disabled);
  send.click();
  await wait(1400);

  check("Google is asked for the send-mail permission, only now", window.__grants.length === 1 && window.__grants[0].indexOf("gmail.send") > -1, JSON.stringify(window.__grants));
  const mail = window.__mail[0] ? readMail(window.__mail[0]) : {};
  check("One email, to the company address", window.__mail.length === 1 && mail.to === "shifts@example.co.il", mail.to);
  check("A blind copy goes to the sender's own address", mail.bcc === "alex.morgan.shifts@example.com", mail.bcc || "no Bcc header");
  check("The subject is in the report language", mail.subject === "דוח משמרות - אוגוסט 2026 - אלכס מורגן", mail.subject);
  check("The email gives both totals and runs right to left",
    mail.text.indexOf("סה״כ לתשלום (שכר ברוטו): ₪670.00") > -1 && mail.text.indexOf("החזר הוצאות: ₪0.00") > -1 && mail.html.indexOf('dir="rtl"') > -1, mail.text);
  check("The PDF is attached, under its Hebrew name",
    mail.pdf.indexOf("%PDF-1.4") === 0 && mail.disposition.indexOf("filename*=UTF-8''" + encodeURIComponent("דוח משמרות - אוגוסט 2026 - אלכס מורגן.pdf")) > -1,
    mail.disposition);
  const upload = window.__uploads[0] ? await window.__uploads[0].text() : "";
  check("A copy goes into the ShiftBoard folder in Drive",
    upload.indexOf('"name":"דוח משמרות - אוגוסט 2026 - אלכס מורגן.pdf"') > -1 && upload.indexOf('"parents":["folder1"]') > -1 && upload.indexOf("%PDF-1.4") > -1,
    upload.slice(0, 160));
  const note = () => (augTab.developerMetadata || []).find((m) => m.metadataKey === "shiftboard_sent");
  const info = note() ? JSON.parse(note().metadataValue) : {};
  check("August is marked sent on its tab, with the rates it was sent with",
    info.to === "shifts@example.co.il" && info.rates && info.rates.event === 600 && info.corrections === 0 && info.open === false && info.pdfId === "pdf1",
    note() ? note().metadataValue : "no note");
  // This page runs in English, where dates read month-first unless someone says otherwise
  const p2 = (n) => String(n).padStart(2, "0");
  const rightNow = new Date();
  const today = p2(rightNow.getMonth() + 1) + "/" + p2(rightNow.getDate()) + "/" + rightNow.getFullYear();
  check("The Pay tab shows August as sent, with its PDF and a way to reopen it",
    !panel.open && status() === "Sent to shifts@example.co.il on " + today + "." && $("sendBtn").hidden && $("writeSheetBtn").hidden &&
      !$("reopenBtn").hidden && !$("sentPdfLink").hidden && $("sentPdfLink").href.indexOf("/file/d/pdf1/") > -1 && $("toast").textContent === "Sent to shifts@example.co.il",
    status());

  // A sent month keeps its rates, and notices calendar changes
  $("settingsBtn").click();
  await wait(100);
  const f = $("settingsForm");
  f.elements.rate_event.value = "650";
  f.requestSubmit();
  // Saving returns to the month and reloads it; wait for that to land, or its stale render
  // arrives after the next edit and quietly undoes it on screen
  await until(() => !$("payView").hidden && $("payLines").querySelectorAll(".pay-line").length > 0);
  await wait(700);
  check("A new rate doesn't change a month that was sent", total() === "₪670.00", total());
  await timeShift(null, "22:00"); // now 14 hours
  // Compared as a local time: the same moment is written as a different UTC string in every time zone
  const lastEdit = window.__requests.filter((r) => r.method === "PATCH").pop();
  const endsAt = lastEdit ? new Date(JSON.parse(lastEdit.body).end.dateTime) : null;
  check("Reopening a timed shift keeps the times it already had, so only the end had to change",
    !!endsAt && endsAt.getHours() === 22 && endsAt.getMinutes() === 0,
    lastEdit ? lastEdit.body.slice(0, 120) : "no PATCH at all");
  check("A calendar change after sending is flagged",
    / Your calendar changed after you sent this month\. Reopen it to send a correction\.$/.test(status()) && $("sendStatus").classList.contains("is-warning"), status());

  // Reopen and send a correction
  window.confirm = () => true;
  $("reopenBtn").click();
  await wait(700);
  check("Reopened, the month keeps the rates it was sent with and offers today's",
    status() === "Reopened: fix what's needed, then send the correction. This month keeps the rates it was sent with." && !$("useRatesBtn").hidden &&
      $("sendBtn").textContent === "Review and send the correction" && !$("sendBtn").disabled && total() === "₪740.00",
    status() + " / " + total());
  $("sendBtn").click();
  await until(() => panel.querySelector("a[href^='blob:']") || !panel.querySelector(".form-error").hidden);
  send = panel.querySelector(".form-actions .btn-primary");
  check("A correction doesn't ask for the confirmation again",
    !panel.querySelector(".check input") && !send.disabled && send.textContent === "Send the correction" && !panel.querySelector(".send-review .fine"), "disabled=" + send.disabled);
  const tabRows = window.__tabValues["2026-08"] || [];
  check("August's tab is now titled Corrected", String((tabRows[0] || [])[0]).endsWith("(מתוקן)"), JSON.stringify(tabRows[0]));
  send.click();
  await wait(1400);
  const mail2 = window.__mail[1] ? readMail(window.__mail[1]) : {};
  const sentDay = new Date().toLocaleDateString("he-IL", { day: "numeric", month: "long", year: "numeric" });
  check("The correction says so in its subject and names the report it replaces",
    mail2.subject === "מתוקן: דוח משמרות - אוגוסט 2026 - אלכס מורגן" && (mail2.text || "").indexOf("הדוח הזה מחליף את הדוח ששלחתי ב־" + sentDay + ".") > -1 &&
      (mail2.text || "").indexOf("₪740.00") > -1 && window.__grants.length === 1,
    mail2.subject + " / " + mail2.text);
  const info2 = note() ? JSON.parse(note().metadataValue) : {};
  check("Sent again: one correction on record",
    info2.corrections === 1 && info2.open === false && info2.pdfId === "pdf2" && status() === "Correction sent to shifts@example.co.il on " + today + ".",
    JSON.stringify(info2) + " / " + status());
  window.scrollTo(0, 0);
  return out;
})();
