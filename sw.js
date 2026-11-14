// Module service worker: offline app shell + background sunset alerts.
// Browsers that can't run module service workers get sw-classic.js (offline only).
import * as M from "./js/model.js";

const CACHE = "wib-shell-v24";
const CONFIG_CACHE = "wib-config";
const CONFIG_URL = "./__alert-config";
const SHELL = ["./", "index.html", "css/app.css", "js/app.js", "js/model.js", "js/visuals.js", "js/exif.js", "js/community.js", "js/community-backend.js", "js/friends.js", "js/firebase-config.js", "manifest.webmanifest",
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
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.endsWith("__alert-config") || url.pathname.endsWith("__friends-config")) return;
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
  let aq = null;
  if (!cfg.testApi) { try { const r = await fetch(M.airQualityUrl(place.lat, place.lon)); if (r.ok) aq = await r.json(); } catch { /* haze optional */ } }
  const e = M.scoreModels(data, t, aq);
  if (!e) return { status: "no-data" };
  const id = `${kind}-${t}`;
  cfg.lastCheck = { at: Date.now(), score: e.score, t };
  const nudge = !force && M.shouldNudge(cfg, now, off);
  const go = force || nudge || M.shouldAlert(cfg, e, now, off, id);
  if (go) {
    const v = M.viewingTimes(place.lat, place.lon, t, kind);
    const word = kind === "sunset" ? "Sunset" : "Sunrise";
    const sameDay = Math.floor((now + off) / 86400) === Math.floor((t + off) / 86400);
    const when = kind === "sunset" ? (sameDay ? "Tonight's sunset" : "Tomorrow's sunset") : (sameDay ? "This morning's sunrise" : "Tomorrow's sunrise");
    await self.registration.showNotification(`${when}: ${e.score}/100${e.score >= 75 ? " 🔥" : ""}`, {
      body: `${e.verdict} at ${place.name}. ${word} ${clock(t, off)}, best colour ${clock(v.peakStart, off)}–${clock(v.peakEnd, off)}.`,
      icon: "icons/icon-192.png", badge: "icons/favicon-32.png", tag: "wib-alert", data: { url: self.registration.scope },
    });
    if (!force) cfg.notified = [...(cfg.notified || []), id].slice(-20); // the nudge counts as the alert for this event
    if (nudge) cfg.nudged = nudge;
  }
  await writeConfig(cfg);
  return { status: go ? "notified" : "checked", score: e.score };
}

/* ---------- friends (no Firebase SDK here: a refreshed sign-in token and Firestore's REST API) ---------- */
const FRIENDS_URL = "./__friends-config";
async function readFriends() { const r = await (await caches.open(CONFIG_CACHE)).match(FRIENDS_URL); return r ? r.json() : null; }
async function writeFriends(cfg) {
  await (await caches.open(CONFIG_CACHE)).put(FRIENDS_URL, new Response(JSON.stringify(cfg), { headers: { "Content-Type": "application/json" } }));
}
/** Firestore REST value → plain JS. */
function plain(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return Date.parse(v.timestampValue);
  if ("booleanValue" in v) return v.booleanValue;
  return null;
}
const docOf = d => { const o = { id: d.name.split("/").pop() }; for (const [k, v] of Object.entries(d.fields || {})) o[k] = plain(v); return o; };
const monthOf = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

async function checkFriends() {
  const cfg = await readFriends();
  if (!cfg || !cfg.on || !cfg.refreshToken) return { status: "off" };
  const tokenBase = cfg.testBase ? cfg.testBase + "token" : "https://securetoken.googleapis.com/v1/token";
  const t = await fetch(`${tokenBase}?key=${cfg.apiKey}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(cfg.refreshToken)}` });
  if (!t.ok) return { status: "auth-failed" };
  const tok = await t.json();
  if (tok.refresh_token) cfg.refreshToken = tok.refresh_token;
  const fs = (cfg.testBase ? cfg.testBase + "fs/" : "https://firestore.googleapis.com/v1/") + `projects/${cfg.projectId}/databases/(default)/documents`;
  const auth = { Authorization: `Bearer ${tok.id_token}`, "Content-Type": "application/json" };
  const photosOf = async uid => {
    const r = await fetch(`${fs}:runQuery`, { method: "POST", headers: auth, body: JSON.stringify({ structuredQuery: {
      select: { fields: ["uid", "status", "kind", "band", "place", "predicted", "createdAt"].map(f => ({ fieldPath: f })) }, // no thumbnails
      from: [{ collectionId: "photos" }], where: { fieldFilter: { field: { fieldPath: "uid" }, op: "EQUAL", value: { stringValue: uid } } }, limit: 60 } }) });
    if (!r.ok) return [];
    return (await r.json()).filter(x => x.document).map(x => docOf(x.document)).filter(p => p.status !== "rejected");
  };
  const name = uid => (cfg.names && cfg.names[uid]) || "A friend";
  const notes = [];
  const all = {};
  for (const u of cfg.following || []) all[u] = await photosOf(u);

  if (cfg.photos) {
    const fresh = Object.entries(all).flatMap(([u, list]) => list.filter(p => p.createdAt > (cfg.seen || 0)).map(p => ({ ...p, u })));
    if (fresh.length) {
      fresh.sort((a, b) => b.createdAt - a.createdAt);
      const p = fresh[0], who = [...new Set(fresh.map(x => name(x.u)))];
      notes.push(fresh.length === 1
        ? [`${name(p.u)} shared a ${p.kind}`, `${p.place || "Somewhere"} · ${p.band}.${p.predicted != null ? ` Sunscore said ${p.predicted}.` : ""}`]
        : [`${fresh.length} new skies from friends`, `${who.slice(0, 3).join(", ")}${who.length > 3 ? " and more" : ""}. Tap to see them.`]);
      cfg.seen = fresh[0].createdAt;
    }
  }
  let mine = null;
  if (cfg.fires || cfg.monthly) mine = await photosOf(cfg.uid);
  if (cfg.fires && mine) {
    const recent = mine.filter(p => p.createdAt > Date.now() - 30 * 86400000).slice(0, 10);
    for (const p of recent) {
      const r = await fetch(`${fs}/photos/${p.id}/fires`, { headers: auth });
      if (!r.ok) continue;
      const who = ((await r.json()).documents || []).map(d => d.name.split("/").pop());
      const before = cfg.fireCounts[p.id] || 0;
      if (who.length > before) notes.push([`${name(who[who.length - 1])} sent fire on your ${p.kind}`, `${p.place || "Your photo"} has ${who.length} now.`]);
      cfg.fireCounts[p.id] = who.length;
    }
  }
  if (cfg.monthly && mine) {
    const now = new Date(), last = monthOf(new Date(now.getFullYear(), now.getMonth() - 1, 15).getTime());
    if (now.getDate() <= 3 && cfg.monthlyFor !== last) {
      const pts = list => list.filter(p => p.status === "approved" && p.predicted != null && monthOf(p.createdAt) === last).reduce((s, p) => s + Math.round(p.predicted), 0);
      const rows = [{ n: "You", p: pts(mine), me: true }, ...Object.entries(all).map(([u, l]) => ({ n: name(u), p: pts(l) }))].sort((a, b) => b.p - a.p);
      const monthName = new Date(now.getFullYear(), now.getMonth() - 1, 15).toLocaleString("en-GB", { month: "long" });
      if (rows.length > 1 && rows[0].p > 0) {
        const you = rows.find(r => r.me);
        notes.push(rows[0].me ? [`You won ${monthName}!`, `${you.p} points. Well caught.`]
          : [`${rows[0].n} won ${monthName}`, `${rows[0].p} points. You scored ${you.p}.`]);
      }
      cfg.monthlyFor = last;
    }
  }
  for (const [title, body] of notes) {
    await self.registration.showNotification(title, { body, icon: "icons/icon-192.png", badge: "icons/favicon-32.png",
      tag: "wib-friends-" + title, data: { url: self.registration.scope + "?tab=friends" } });
  }
  await writeFriends(cfg);
  return { status: "checked", sent: notes.length };
}

self.addEventListener("periodicsync", e => {
  if (e.tag === "wib-alert") e.waitUntil(Promise.allSettled([checkAlert(), checkFriends()]));
});
self.addEventListener("message", e => {
  const reply = v => e.ports[0] && e.ports[0].postMessage(v);
  if (e.data && e.data.type === "check-now") e.waitUntil(checkAlert({ force: !!e.data.force }).then(reply, err => reply({ status: "error", error: String(err) })));
  if (e.data && e.data.type === "ping") reply({ ok: true, module: true });
  if (e.data && e.data.type === "friends-now") e.waitUntil(checkFriends().then(reply, err => reply({ status: "error", error: String(err) })));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then(list => {
    const want = (e.notification.data && e.notification.data.url) || self.registration.scope;
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    return open ? open.navigate(want).then(c => (c || open).focus()).catch(() => open.focus()) : self.clients.openWindow(want);
  }));
});
