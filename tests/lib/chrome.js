// Chrome, driven over the DevTools Protocol: the browser checks and the screenshot tools share it.
// Pages open on an emulated phone (390x844, touch, DPR 2) unless asked otherwise.
// Set CHROME to a browser binary if this machine keeps Chrome somewhere unusual.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CANDIDATES = [
  process.env.CHROME,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter(Boolean);

const fileUrl = (p) => "file:///" + p.replace(/\\/g, "/");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const found = CANDIDATES.find((p) => {
    try {
      return fs.existsSync(p);
    } catch (e) {
      return false;
    }
  });
  if (!found) throw new Error("No Chrome found. Install Google Chrome, or set CHROME to its path.");
  return found;
}

// Starts a headless Chrome and connects to it; resolve.open() gives one page at a time
async function launch() {
  const port = 9222 + Math.floor(Math.random() * 600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "shiftboard-chrome-"));
  const chrome = spawn(
    findChrome(),
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox", // the CI runner is root; harmless elsewhere
      "--disable-dev-shm-usage",
      "--remote-debugging-port=" + port,
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let info = null;
  for (let i = 0; i < 80 && !info; i++) {
    try {
      info = await (await fetch("http://127.0.0.1:" + port + "/json/version")).json();
    } catch (e) {
      await sleep(250);
    }
  }
  if (!info) {
    chrome.kill();
    throw new Error("Chrome's debugging port never came up");
  }

  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method) {
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].method === msg.method && waiters[i].sessionId === msg.sessionId) {
          waiters[i].resolve(msg.params);
          waiters.splice(i, 1);
        }
      }
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  const once = (method, sessionId) => new Promise((resolve) => waiters.push({ method, sessionId, resolve }));

  async function open(url, { width = 390, height = 844, scheme = "light", mobile = true } = {}) {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const s = (m, p) => send(m, p, sessionId);
    await s("Page.enable");
    await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await s("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
    await s("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scheme }] });
    const loaded = once("Page.loadEventFired", sessionId);
    await s("Page.navigate", { url });
    await loaded;
    await s("Runtime.evaluate", { expression: "document.fonts.ready.then(() => true)", awaitPromise: true });
    return {
      send: s,
      // Runs an expression in the page and returns its value; a page script that throws fails the check
      async evaluate(expression, { awaitPromise = true } = {}) {
        const res = await s("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
        if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 600));
        return res.result.value;
      },
      async screenshot(file, { fullPage = false } = {}) {
        const params = { format: "png" };
        if (fullPage) {
          const metrics = await s("Page.getLayoutMetrics");
          params.captureBeyondViewport = true;
          params.clip = { x: 0, y: 0, width, height: Math.ceil(metrics.cssContentSize.height), scale: 1 };
        }
        const shot = await s("Page.captureScreenshot", params);
        fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
        return file;
      },
      close: () => send("Target.closeTarget", { targetId }),
    };
  }

  return {
    open,
    close() {
      try {
        ws.close();
      } catch (e) {}
      chrome.kill();
    },
  };
}

module.exports = { launch, fileUrl, sleep, findChrome };
