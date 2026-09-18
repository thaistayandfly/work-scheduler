// ShiftBoard's service worker: it keeps the app openable with no signal.
//
// Anything Google (Calendar, Sheets, Drive, Gmail) always goes to the network and is never kept here.
// The calendar is the source of truth, and showing yesterday's shifts as though they were today's
// would be worse than showing none. Only the app's own files and its fonts are cached.
const SHELL = "shiftboard-shell-v1";
const FONTS = "shiftboard-fonts-v1";
const KEEP = [SHELL, FONTS];

const FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./i18n.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  // One file that won't download shouldn't leave the app with no cache at all, so each is added on its own
  e.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => Promise.all(FILES.map((f) => cache.add(f).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => KEEP.indexOf(n) === -1).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

const isFont = (url) => url.origin === "https://fonts.googleapis.com" || url.origin === "https://fonts.gstatic.com";

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // A published font file never changes, so the cache answers and the network is used once
  if (isFont(url)) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req)
            .then((res) => {
              const copy = res.clone();
              caches.open(FONTS).then((c) => c.put(req, copy));
              return res;
            })
            .catch(() => hit)
      )
    );
    return;
  }

  if (url.origin !== self.location.origin) return; // Google's APIs: straight to the network, always

  // The app's own files: whatever is newest wins, and the cache answers when there's no signal
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("./index.html") : undefined))
      )
  );
});
