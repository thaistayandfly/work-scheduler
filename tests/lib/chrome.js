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

// On Linux /usr/bin/google-chrome is a shell script around the real browser, so killing what we
// spawned would leave Chrome running; we start it in its own process group and take the group down.
function kill(chrome) {
  try {
    if (process.platform !== "win32" && chrome.pid) process.kill(-chrome.pid, "SIGKILL");
    else chrome.kill();
  } catch (e) {
    try {
      chrome.kill("SIGKILL");
    } catch (e2) {}
  }
}

// Starts a headless Chrome and connects to it; resolve.open() gives one page at a time
async function launch() {
  const binary = findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "shiftboard-chrome-"));
  const chrome = spawn(
    binary,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox", // CI runners are root; harmless elsewhere
      "--disable-dev-shm-usage", // CI gives /dev/shm 64MB, which Chrome outgrows
      "--disable-background-networking",
      "--remote-allow-origins=*",
      "--remote-debugging-port=0", // Chrome takes a free port and writes down which
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" }
  );

  // Keep whatever Chrome says: if it never comes up, this is the only explanation we'll get
  let said = "";
  chrome.stdout.on("data", (d) => (said += d));
  chrome.stderr.on("data", (d) => (said += d));
  let stopped = "";
  chrome.on("error", (e) => (stopped = "it wouldn't start: " + e.message));
  chrome.on("exit", (code, signal) => (stopped = "it exited straight away (" + (signal || "code " + code) + ")"));

  // Once Chrome is listening it writes the port, then the browser's address, into this file
  const portFile = path.join(profile, "DevToolsActivePort");
  let target = "";
  for (let i = 0; i < 180 && !target && !stopped; i++) {
    try {
      const [port, route] = fs.readFileSync(portFile, "utf8").split("\n");
      if (port && port.trim() && route && route.trim()) target = "ws://127.0.0.1:" + port.trim() + route.trim();
    } catch (e) {}
    if (!target) await sleep(250);
  }
  if (!target) {
    kill(chrome);
    throw new Error(
      "Chrome's debugging port never came up.\n    binary: " +
        binary +
        (stopped ? "\n    " + stopped : "") +
        (said.trim() ? "\n    Chrome said: " + said.trim().split("\n").slice(-6).join("\n                 ") : "\n    Chrome said nothing at all.")
    );
  }

  const ws = new WebSocket(target);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () =>
      reject(new Error("Couldn't connect to Chrome at " + target + (said.trim() ? "\n    Chrome said: " + said.trim() : "")));
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
      // Polls an expression until it's true: steadier than guessing how long a page needs
      async waitFor(expression, ms = 20000) {
        const until = Date.now() + ms;
        while (Date.now() < until) {
          let ready = false;
          try {
            ready = await this.evaluate(expression, { awaitPromise: false });
          } catch (e) {}
          if (ready) return true;
          await sleep(100);
        }
        return false;
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
      kill(chrome);
    },
  };
}

module.exports = { launch, fileUrl, sleep, findChrome };
