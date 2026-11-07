// Module service worker: offline app shell + background sunset alerts.
// Browsers that can't run module service workers get sw-classic.js (offline only).
import * as M from "./js/model.js";

const CACHE = "wib-shell-v8";
const CONFIG_CACHE = "wib-config";
const CONFIG_URL = "./__alert-config";
const SHELL = ["./", "index.html", "css/app.css", "js/app.js", "js/model.js", "js/visuals.js", "js/exif.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/apple-touch-icon.png", "icons/favicon-32.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== CONFIG_CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.endsWith("__alert-config")) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html")))
  );
});

/* ---------- alerts ---------- */
async function readConfig() {
  const r = await (await caches.open(CONFIG_CACHE)).match(CONFIG_URL);
  return r ? r.json() : null;
}
async function writeConfig(cfg) {
  await (await caches.open(CONFIG_CACHE)).put(CONFIG_URL, new Response(JSON.stringify(cfg), { headers: { "Content-Type": "application/json" } }));
}

function clock(unix, off) {
  const d = new Date((unix + off) * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

async function checkAlert({ force = false } = {}) {
  const cfg = await readConfig();
  if (!cfg || !cfg.enabled) return { status: "off" };
  const now = Date.now() / 1000, { place, kind } = cfg;
  const az = M.eventAzimuth(place.lat, M.dayOfYear(now), kind);
  const pts = M.ALL_KM.map(km => M.destination(place.lat, place.lon, az, km));
  const params = new URLSearchParams({
    latitude: pts.map(p => p[0].toFixed(4)).join(","), longitude: pts.map(p => p[1].toFixed(4)).join(","),
    hourly: M.VARS.join(","), daily: "sunset,sunrise", models: M.WEATHER_MODELS.join(","), timezone: "auto", timeformat: "unixtime", forecast_days: "3",
  });
  const api = cfg.testApi || "https://api.open-meteo.com/v1/forecast";   // testApi: used only by the automated tests
  const res = await fetch(api + "?" + params);
  if (!res.ok) return { status: "fetch-failed" };
  let data = await res.json(); if (!Array.isArray(data)) data = [data];
  const off = data[0].utc_offset_seconds || 0;
  const t = M.eventTimes(data[0].daily, kind).find(x => x != null && x > now);
  if (t == null) return { status: "no-event" };
  const e = M.scoreModels(data, t);
  if (!e) return { status: "no-data" };
  const id = `${kind}-${t}`;
  cfg.lastCheck = { at: Date.now(), score: e.score, t };
  const go = force || M.shouldAlert(cfg, e, now, off, id);
  if (go) {
    const v = M.viewingTimes(place.lat, place.lon, t, kind);
    const word = kind === "sunset" ? "Sunset" : "Sunrise";
    const sameDay = Math.floor((now + off) / 86400) === Math.floor((t + off) / 86400);
    const when = kind === "sunset" ? (sameDay ? "Tonight's sunset" : "Tomorrow's sunset") : (sameDay ? "This morning's sunrise" : "Tomorrow's sunrise");
    await self.registration.showNotification(`${when}: ${e.score}/100${e.score >= 75 ? " 🔥" : ""}`, {
      body: `${e.verdict} at ${place.name}. ${word} ${clock(t, off)}, best colour ${clock(v.peakStart, off)}–${clock(v.peakEnd, off)}.`,
      icon: "icons/icon-192.png", badge: "icons/favicon-32.png", tag: "wib-alert", data: { url: self.registration.scope },
    });
    if (!force) cfg.notified = [...(cfg.notified || []), id].slice(-20);
  }
  await writeConfig(cfg);
  return { status: go ? "notified" : "checked", score: e.score };
}

self.addEventListener("periodicsync", e => {
  if (e.tag === "wib-alert") e.waitUntil(checkAlert().catch(() => {}));
});
self.addEventListener("message", e => {
  const reply = v => e.ports[0] && e.ports[0].postMessage(v);
  if (e.data && e.data.type === "check-now") e.waitUntil(checkAlert({ force: !!e.data.force }).then(reply, err => reply({ status: "error", error: String(err) })));
  if (e.data && e.data.type === "ping") reply({ ok: true, module: true });
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(self.registration.scope);
  }));
});
