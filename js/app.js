import * as M from "./model.js";
import * as V from "./visuals.js";
import { readExif } from "./exif.js";

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const store = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

async function getJSON(url, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

const mix = (a, b, t) => {
  const pa = a.match(/\w\w/g).map(h => parseInt(h, 16)), pb = b.match(/\w\w/g).map(h => parseInt(h, 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("");
};
const scoreColour = s => mix("6e707b", "ff7a2f", Math.min(1, s / 85));

/* ---------- time formatting (in the place's own time zone) ---------- */
const localDate = (unix, off) => new Date((unix + off) * 1000);
// Follow the phone's own 12/24-hour setting; times are shown in the place's time zone.
const CLOCK_FMT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
const USES_12H = CLOCK_FMT.resolvedOptions().hour12 !== false && CLOCK_FMT.resolvedOptions().hourCycle !== "h23";
function clock(unix, off) {
  const d = localDate(unix, off);
  const h = d.getUTCHours(), m = String(d.getUTCMinutes()).padStart(2, "0");
  if (!USES_12H) return `${String(h).padStart(2, "0")}:${m}`;
  return `${h % 12 || 12}:${m}${h >= 12 ? "pm" : "am"}`;
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayKey(unix, off) { const d = localDate(unix, off); return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`; }
function dayName(unix, off, kind) {
  const now = Date.now() / 1000;
  if (dayKey(unix, off) === dayKey(now, off)) return kind === "sunset" ? "Tonight" : "Today";
  if (dayKey(unix, off) === dayKey(now + 86400, off)) return "Tomorrow";
  const d = localDate(unix, off);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
const shortDay = (unix, off) => {
  const now = Date.now() / 1000;
  if (dayKey(unix, off) === dayKey(now, off)) return "Today";
  return DAYS[localDate(unix, off).getUTCDay()];
};

/* ---------- state ---------- */
const state = {
  place: null,
  kind: store.get("wib-kind", "sunset"),
  data: null,        // { locations, az, offset, kind }
  events: [],        // scored upcoming events
  sel: 0,
  past: false,       // looking back at a past date
  updatedAt: null,
  terrain: null,      // horizon angle towards the sun
};

/* ---------- data ---------- */
async function loadForecast(place, kind) {
  const now = Date.now() / 1000;
  const az = M.eventAzimuth(place.lat, M.dayOfYear(now), kind);
  const pts = M.ALL_KM.map(km => M.destination(place.lat, place.lon, az, km));
  const params = new URLSearchParams({
    latitude: pts.map(p => p[0].toFixed(4)).join(","),
    longitude: pts.map(p => p[1].toFixed(4)).join(","),
    hourly: M.VARS.join(","), daily: "sunset,sunrise", models: M.WEATHER_MODELS.join(","),
    timezone: "auto", timeformat: "unixtime", forecast_days: "8",
  });
  let data = await getJSON("https://api.open-meteo.com/v1/forecast?" + params);
  if (!Array.isArray(data)) data = [data];
  return { locations: data, az, pts, offset: data[0].utc_offset_seconds || 0, kind };
}

const MODEL_NAMES = { ecmwf_ifs025: "European (ECMWF)", gfs_seamless: "American (GFS)", icon_seamless: "German (ICON)" };
/** Value of a forecast variable for the model whose breakdown is shown (the median model). */
const mv = (loc, key, e, t) => M.valueAt(loc, `${key}_${e.model}`, t ?? e.t);

function scoreEvents(d) {
  const now = Date.now() / 1000;
  const times = M.eventTimes(d.locations[0].daily, d.kind).filter(t => t != null && t + 20 * 60 > now);
  const out = [];
  for (const t of times) {
    const r = M.scoreModels(d.locations, t);
    if (!r) continue;
    out.push(r);
    if (out.length >= 7) break;
  }
  return out;
}

/* ---------- rendering ---------- */
function show(which) {
  for (const id of ["loading", "picker", "result"]) $(id).hidden = id !== which;
  $("tabbar").hidden = which !== "result";
}
function loading(text) { $("loadingText").textContent = text; show("loading"); }

function paintSky(t, e) {
  const top = mix("2b2d38", "2a1846", t), mid = mix("4b4e5c", "b8336a", t), low = mix("6e707b", "ff7a2f", t);
  $("sky").style.background = `linear-gradient(180deg, ${top} 0%, ${mid} 55%, ${low} 100%)`;
  document.querySelector('meta[name="theme-color"]').content = top;
  lastSky = e || null;
  drawSky();
}

/* ---------- sky preview: the forecast drawn as a sky ---------- */
let lastSky = null;
function rng(seed) { let x = Math.floor(seed) % 2147483647 || 1; return () => (x = x * 16807 % 2147483647) / 2147483647; }
function drawSky() {
  const cv = $("skyCanvas"), e = lastSky;
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = innerWidth, H = innerHeight;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  if (!e) return;
  const t = e.score / 100, f = e.factors, inp = e.inputs, rand = rng(e.t);
  const horizon = H * 0.9;
  const lit = Math.max(0, Math.min(1, f.path * (0.35 + 0.65 * t)));   // how strongly clouds catch colour
  const top = mix("2b2d38", "2a1846", t), mid = mix("4b4e5c", "b8336a", t), low = mix("6e707b", "ff7a2f", t);
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, top); grad.addColorStop(0.6, mid); grad.addColorStop(1, low);
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  // glow of the sun on the horizon
  const glow = g.createRadialGradient(W / 2, horizon, 0, W / 2, horizon, H * 0.55);
  glow.addColorStop(0, `rgba(255,190,110,${0.15 + 0.45 * lit})`); glow.addColorStop(1, "rgba(255,190,110,0)");
  g.fillStyle = glow; g.fillRect(0, 0, W, H);
  g.globalAlpha = 1;
  // ground
  g.fillStyle = "#14111b"; g.fillRect(0, horizon, W, H - horizon);
  // gentle scrim so text stays readable
  g.fillStyle = "rgba(10,8,16,0.18)"; g.fillRect(0, 0, W, H);
}
addEventListener("resize", () => { clearTimeout(drawSky.t); drawSky.t = setTimeout(drawSky, 150); });

$("locToggle").addEventListener("click", () => {
  const open = $("locMore").hidden;
  $("locMore").hidden = !open; $("locToggle").setAttribute("aria-expanded", String(open));
});
function renderPlace(place) {
  $("placeBtn").hidden = false;
  $("locName").textContent = place.label || place.name;
  const coords = `${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}`;
  const acc = place.accuracy ? ` · ±${place.accuracy < 1000 ? Math.round(place.accuracy) + " m" : (place.accuracy / 1000).toFixed(1) + " km"}` : "";
  const parts = [place.detail, (place.gps ? "GPS " : "") + coords + acc].filter(Boolean);
  const map = `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lon}`;
  $("locSub").innerHTML = parts.map(esc).join("<br>") + ` · <a href="${map}" target="_blank" rel="noopener">View on map</a>`;
  const warn = place.accuracy && place.accuracy > 1000;
  $("locWarn").hidden = !warn;
  if (warn) $("locWarn").textContent = "Your location is only approximate. Turn on precise location, or search for the place.";
}

function reasons(r, az, kind) {
  const f = r.factors, out = [], dir = M.compass(az);
  if (f.canvas >= 0.7) out.push("Good cloud overhead to catch the light");
  else if (f.canvas >= 0.3) out.push("Some cloud overhead to catch the light");
  else out.push("Mostly clear above, so little cloud to light up");
  if (f.path < 0.5) out.push(`Cloud to the ${dir} may block the sun`);
  else if (f.path >= 0.9) out.push(`Clear horizon to the ${dir}`);
  if (f.overcast < 0.7) out.push("Heavy overcast overhead");
  else if (f.local < 0.7) out.push("Low cloud overhead may hide the colours");
  if (f.rain < 0.8) out.push("Rain is likely");
  if (f.clarity < 0.8) out.push("Hazy air will mute the colours");
  return out.slice(0, 3);
}

let countdownTimer = null;
function renderSelected() {
  const d = state.data, e = state.events[state.sel];
  if (!e) return;
  const kind = d.kind, off = d.offset;
  paintSky(e.score / 100, e);
  const word = kind === "sunset" ? "sunset" : "sunrise";
  $("when").textContent = `${dayName(e.t, off, kind)} · ${word} ${clock(e.t, off)}`;
  $("score").textContent = e.score;
  $("verdict").textContent = e.verdict;
  $("reasons").innerHTML = reasons(e, d.az, kind).map(t => `<li>${esc(t)}</li>`).join("");

  const tick = () => {
    const mins = Math.round((e.t - Date.now() / 1000) / 60);
    const look = kind === "sunset" ? "Look west!" : "Look east!";
    $("countdown").textContent = mins > 90 ? `In ${Math.floor(mins / 60)}h ${mins % 60}m`
      : mins > 0 ? `In ${mins} minutes` : mins > -20 ? `Happening now. ${look}` : "";
  };
  clearInterval(countdownTimer); tick(); countdownTimer = setInterval(tick, 30000);

  // window view (B) and side slice (A)
  e.layers = V.layersAt(d.locations, e.model, e.t);
  const peak = kind === "sunset" ? 10 : -10;
  if (state.sliderFor !== e.t) { $("timeSlider").value = String(peak); state.sliderFor = e.t; }
  $("timeSlider").setAttribute("aria-label", kind === "sunset" ? "Minutes from sunset" : "Minutes from sunrise");
  renderScene();
  $("slice").innerHTML = V.sliceSVG({ e, layers: e.layers, kind });

  // what to look for
  $("tips").innerHTML = M.lookFor(e, kind, d.az).map(x => `<div class="tip"><b>${esc(x.t)}</b><span>${esc(x.d)}</span></div>`).join("");

  // confidence and map
  renderConfidence();
  drawMap();
  renderElevation();
  drawTimeline();

  // week strip
  const best = state.events.reduce((b, x, i) => (x.score > state.events[b].score ? i : b), 0);
  $("weekTitle").textContent = kind === "sunset" ? "Sunsets this week" : "Sunrises this week";
  $("week").innerHTML = state.events.map((x, i) => `
    <button class="day ${i === state.sel ? "on" : ""}" data-i="${i}" aria-label="${esc(dayName(x.t, off, kind))}: ${x.score}">
      <span class="d">${esc(shortDay(x.t, off))}</span>
      ${V.miniStack(x)}
      <span class="s">${x.score}</span>
      <span class="best">${i === best && x.score >= 25 ? "Best" : ""}</span>
    </button>`).join("");

  // viewing times
  const v = M.viewingTimes(state.place.lat, state.place.lon, e.t, kind);
  const rows = kind === "sunset"
    ? [["Golden hour begins", v.golden], ["Sunset", e.t, true], ["Best colour", null, true, `${clock(v.peakStart, off)}–${clock(v.peakEnd, off)}`], ["Afterglow fades", v.civil]]
    : [["First light", v.civil], ["Best colour", null, true, `${clock(v.peakStart, off)}–${clock(v.peakEnd, off)}`], ["Sunrise", e.t, true], ["Golden hour ends", v.golden]];
  renderTerrain();
  if (e.terrainT && state.terrain && state.terrain.angle >= 0.5) {
    const label = kind === "sunset" ? "Sun goes behind the hills" : "Sun clears the hills";
    rows.splice(kind === "sunset" ? 1 : 3, 0, [label, e.terrainT]);
  }
  $("times").innerHTML = rows.filter(r => r[1] != null || r[3]).map(([label, t, hl, text]) =>
    `<span class="${hl ? "hl" : ""}">${label}</span><span class="t ${hl ? "hl" : ""}">${text || clock(t, off)}</span>`).join("");
  $("timesNote").textContent = kind === "sunset"
    ? `Face ${M.compass(d.az)} (${Math.round(d.az)}°). Clouds often light up best after the sun has gone, so don't leave too early.`
    : `Face ${M.compass(d.az)} (${Math.round(d.az)}°). The strongest colour usually comes before the sun appears.`;

  // details
  const names = { canvas: "Cloud canvas", path: "Clear horizon", local: "No low cloud", overcast: "Not overcast", rain: "Dry", clarity: "Clear air" };
  const i = e.inputs, n = x => x == null ? "–" : Math.round(x);
  $("detailBody").innerHTML = Object.entries(e.factors).map(([k, val]) => `
    <div class="f-row"><span>${names[k]}</span><div class="f-bar"><div class="f-fill" style="width:${Math.round(val * 100)}%"></div></div><span class="f-num">${Math.round(val * 100)}%</span></div>`).join("")
    + `<div class="raw">Overhead: mid cloud ${n(i.cMid)}%, high ${n(i.cHigh)}%, low ${n(i.low)}%, total ${n(i.total)}%<br>
       Towards the sun (75–250 km ${M.compass(d.az)}): low ${n(i.pathLow)}%, mid ${n(i.pathMid)}%<br>
       Rain ${n(i.rainP)}% · visibility ${n(i.visKm)} km · humidity ${n(i.hum)}%</div>`;
}

function renderConfidence() {
  const e = state.events[state.sel], el = $("conf");
  const ms = e.modelScores || [];
  const c = M.confidenceFrom(ms.map(x => x.score));
  el.hidden = !c;
  $("confDetail").hidden = !c;
  if (!c) return;
  const col = { High: "#7ee08a", Medium: "#ffd166", Low: "#ff8a7a" }[c.level];
  const range = c.min === c.max ? `${c.min}` : `${c.min}–${c.max}`;
  el.innerHTML = `<span class="dot" style="background:${col}"></span>${c.level} confidence · models say ${range}`;
  $("confDetail").innerHTML = `<b>Forecast confidence: ${c.level}.</b> ` +
    ms.map(x => `${MODEL_NAMES[x.model]} ${x.score}`).join(" · ") + `. The headline is the middle one (${MODEL_NAMES[e.model]})` +
    `. ${c.level === "High" ? "The weather models agree, so the forecast is more trustworthy."
      : c.level === "Medium" ? "The models partly disagree. Check again nearer the time."
      : "The models disagree a lot. Treat this score as a rough guess and check again later."}`;
}
/* ---------- terrain: the real horizon towards the sun ---------- */
async function terrainFor(lat, lon, az) {
  const key = `${lat.toFixed(3)},${lon.toFixed(3)},${Math.round(az / 2) * 2}`;
  const cache = store.get("wib-terrain2", {}) || {};
  if (cache[key]) return cache[key];
  const pts = M.TERRAIN_KM.map(km => M.destination(lat, lon, az, km));
  const d = await getJSON(`https://api.open-meteo.com/v1/elevation?latitude=${pts.map(p => p[0].toFixed(5)).join(",")}&longitude=${pts.map(p => p[1].toFixed(5)).join(",")}`, 10000);
  const h = M.horizonAngle(d.elevation);
  const keys = Object.keys(cache); if (keys.length > 30) delete cache[keys[0]];
  cache[key] = h; store.set("wib-terrain2", cache);
  return h;
}
function renderTerrain() {
  const d = state.data, e = state.events[state.sel], h = state.terrain;
  const note = $("terrainNote");
  if (!d || !e || !h) { note.hidden = true; return; }
  e.terrainT = M.terrainEventTime(state.place.lat, state.place.lon, e.t, h.angle, d.kind);
  const sum = M.terrainSummary(h, e.t, e.terrainT, d.kind);
  note.hidden = !sum || sum.level === "clear";
  if (sum) note.textContent = sum.text;
  $("locFlag").hidden = $("elevWarn").hidden && $("locWarn").hidden && note.hidden;
}

/* ---------- window view with time slider ---------- */
function renderScene() {
  const d = state.data, e = state.events[state.sel];
  if (!d || !e || !e.layers) return;
  const m = Number($("timeSlider").value), t = e.t + m * 60;
  const sunElev = M.solarPosition(state.place.lat, state.place.lon, t).elevation;
  $("scene").innerHTML = V.windowSVG({ e, layers: e.layers, kind: d.kind, az: d.az, minutes: m, sunElev, horizonDeg: state.terrain ? state.terrain.angle : 0 });
  const word = d.kind === "sunset" ? "sunset" : "sunrise";
  const g = V.glowCurve(m, d.kind);
  const rel = m === 0 ? `At ${word}` : `${Math.abs(m)} min ${m > 0 ? "after" : "before"} ${word}`;
  $("sliderLabel").textContent = `${rel} (${clock(t, d.offset)})${g >= 0.99 && e.factors.path >= 0.5 ? ": peak colour" : ""}`;
}
$("timeSlider").addEventListener("input", renderScene);

/* ---------- cloud timeline chart ---------- */
const SERIES = [
  { key: "cloud_cover_mid", loc: [0, 1], label: "Mid cloud overhead", col: "#ff9a7a" },
  { key: "cloud_cover_high", loc: [0, 1], label: "High cloud overhead", col: "#ffd9a8" },
  { key: "cloud_cover_low", loc: [0], label: "Low cloud overhead", col: "#9aa0b4" },
  { key: "cloud_cover_low", loc: [2, 3, 4], label: "Low cloud on light path", col: "#7ee0c8", dash: [5, 4] },
];
function drawTimeline() {
  const cv = $("timeline"), d = state.data, e = state.events[state.sel];
  if (!cv || !d || !e || !$("details").open) return;
  const dpr = Math.min(2, devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const before = d.kind === "sunset" ? 4 : 2, afterH = d.kind === "sunset" ? 2 : 4;
  const t0 = e.t - before * 3600, t1 = e.t + afterH * 3600, padL = 30, padR = 8, padT = 8, padB = 22;
  const x = t => padL + (t - t0) / (t1 - t0) * (W - padL - padR), y = v => padT + (1 - v / 100) * (H - padT - padB);
  g.strokeStyle = "rgba(255,255,255,0.15)"; g.fillStyle = "rgba(255,255,255,0.6)"; g.font = "11px Inter, system-ui, sans-serif"; g.lineWidth = 1;
  for (const v of [0, 50, 100]) { g.beginPath(); g.moveTo(padL, y(v)); g.lineTo(W - padR, y(v)); g.stroke(); g.fillText(v + "%", 0, y(v) + 4); }
  for (let h = -before; h <= afterH; h++) {
    if (h !== 0 && (h % 2 !== 0 || h === afterH)) continue;     // keep labels uncluttered and inside the chart
    const tt = e.t + h * 3600, label = h === 0 ? (d.kind === "sunset" ? "sunset" : "sunrise") : clock(tt, d.offset);
    g.fillText(label, Math.min(W - g.measureText(label).width, Math.max(padL, x(tt) - g.measureText(label).width / 2)), H - 6);
  }
  g.strokeStyle = "#ffcf6b"; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(x(e.t), padT); g.lineTo(x(e.t), H - padB); g.stroke(); g.setLineDash([]);
  for (const s of SERIES) {
    g.strokeStyle = s.col; g.lineWidth = 2.2; g.setLineDash(s.dash || []); g.beginPath();
    let started = false;
    for (let tt = t0; tt <= t1; tt += 900) {
      const vals = s.loc.map(i => mv(d.locations[i], s.key, e, tt)).filter(v => v != null);
      if (!vals.length) { started = false; continue; }
      const v = vals.reduce((a, b) => a + b, 0) / vals.length;
      if (!started) { g.moveTo(x(tt), y(v)); started = true; } else g.lineTo(x(tt), y(v));
    }
    g.stroke();
  }
  g.setLineDash([]);
  $("tlLegend").innerHTML = SERIES.map(s => `<span><i style="background:${s.col}"></i>${s.label}</span>`).join("");
}
$("details").addEventListener("toggle", drawTimeline);

function renderElevation() {
  const elev = state.data && state.data.locations[0].elevation;
  const el = $("elevWarn");
  const low = state.events[state.sel] && state.events[state.sel].inputs.low;
  el.hidden = !(elev >= 1500);
  if (!el.hidden) {
    el.textContent = low >= 20
      ? `High viewpoint (${Math.round(elev).toLocaleString()} m): some of the "low" cloud may be above you and light up, so this score may be too low.`
      : `High viewpoint (${Math.round(elev).toLocaleString()} m): if low cloud forms, it may light up rather than block the view.`;
  }
  $("locElev").textContent = elev != null ? `· ${Math.round(elev).toLocaleString()} m` : "";
  $("locFlag").hidden = el.hidden && $("locWarn").hidden && $("terrainNote").hidden;
}

$("conf").addEventListener("click", () => { $("details").open = true; $("details").scrollIntoView({ behavior: "smooth", block: "start" }); });

/* ---------- light path map ---------- */
let leafletReady = null, map = null, mapLayer = null;
/* OpenStreetMap tiles (CARTO now needs an API key). Darkened in CSS to match the theme. */
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
function loadLeaflet() {
  if (leafletReady) return leafletReady;
  leafletReady = new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(css);
    const js = document.createElement("script");
    js.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    js.onload = () => resolve(window.L); js.onerror = () => { leafletReady = null; reject(new Error("leaflet")); };
    document.head.appendChild(js);
  });
  return leafletReady;
}
const cloudColour = block => block < 20 ? "#7ee08a" : block < 55 ? "#ffd166" : "#9a9aa8";

async function drawMap() {
  if (!$("mapCard").open || !state.data) return;
  let L;
  try { L = await loadLeaflet(); } catch { $("mapNote").textContent = "The map couldn't load. Check your connection."; return; }
  const d = state.data, e = state.events[state.sel], p = state.place;
  if (!map) {
    map = L.map("map", { zoomControl: false, attributionControl: true });
    L.tileLayer(TILE_URL, {
      maxZoom: 18, className: "dark-tiles", attribution: TILE_ATTR,
    }).addTo(map);
  }
  if (mapLayer) mapLayer.remove();
  mapLayer = L.layerGroup().addTo(map);
  const end = M.destination(p.lat, p.lon, d.az, 300);
  L.polyline([[p.lat, p.lon], end], { color: "#ffb36b", weight: 3, opacity: 0.8, dashArray: "6 6" }).addTo(mapLayer);
  M.ALL_KM.forEach((km, i) => {
    const [la, lo] = d.pts[i];
    const low = mv(d.locations[i], "cloud_cover_low", e), mid = mv(d.locations[i], "cloud_cover_mid", e), high = mv(d.locations[i], "cloud_cover_high", e);
    const isPath = M.PATH_KM.includes(km);
    const block = isPath ? Math.min(100, (low || 0) + 0.5 * (mid || 0)) : (low || 0);
    const r = (n) => n == null ? "–" : Math.round(n);
    L.circleMarker([la, lo], { radius: km === 0 ? 9 : 7, color: "#fff", weight: 2, fillColor: km === 0 ? "#fff" : cloudColour(block), fillOpacity: 1 })
      .bindPopup(`<b>${km === 0 ? "You" : km + " km " + M.compass(d.az)}</b><br>${isPath ? "Light path: must be clear" : "Canvas: cloud here lights up"}<br>Low ${r(low)}% · mid ${r(mid)}% · high ${r(high)}%`)
      .addTo(mapLayer);
  });
  map.fitBounds(L.latLngBounds([[p.lat, p.lon], end]).pad(0.15));
  setTimeout(() => map.invalidateSize(), 50);
  $("mapNote").textContent = `The dashed line points ${M.compass(d.az)} towards the ${d.kind}. Clouds near you are the canvas; the points 75–250 km away need to be clear for the light to reach it. Tap a point for its cloud cover.`;
}
$("mapCard").addEventListener("toggle", drawMap);

$("week").addEventListener("click", e => {
  const b = e.target.closest(".day");
  if (!b) return;
  state.sel = Number(b.dataset.i);
  renderSelected();
});

function setKindButtons() {
  $("kindSunset").classList.toggle("on", state.kind === "sunset");
  $("kindSunrise").classList.toggle("on", state.kind === "sunrise");
}
for (const [id, kind] of [["kindSunset", "sunset"], ["kindSunrise", "sunrise"]]) {
  $(id).addEventListener("click", () => {
    if (state.kind === kind) return;
    state.kind = kind; store.set("wib-kind", kind); setKindButtons();
    refresh();
  });
}


/* ---------- rating and log ---------- */
const logAll = () => store.get("wib-log", []);
const isoDay = (unix, off) => { const d = localDate(unix, off); return d.toISOString().slice(0, 10); };
const entryId = (kind, t, off, place) => `${kind}-${isoDay(t, off)}-${place.lat.toFixed(3)},${place.lon.toFixed(3)}`;

/** The sunset/sunrise that has just happened (within the last 16 hours), scored. */
function recentEvent(d) {
  const now = Date.now() / 1000;
  const times = M.eventTimes(d.locations[0].daily, d.kind).filter(t => t != null && t <= now + 10 * 60 && t >= now - 16 * 3600);
  if (!times.length) return null;
  return M.scoreModels(d.locations, Math.max(...times));
}

let rateSel = null, rateEvent = null, photoMeta = "";
/* GitHub logging is off unless a repository is set in More (testers and other users never post to one by default). */
const logRepo = () => store.get("wib-log-repo", "");
const githubLogging = () => !!logRepo();
function applyLogMode() {
  const gh = githubLogging();
  $("rateLog").hidden = !gh;
  $("rateCopy").className = gh ? "btn small ghost" : "btn small linkbtn-solid";
}

/* position at the moment of rating, for the on-location check */
function currentPosition() {
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      () => res(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 300000 });
  });
}

/* photo date/location, read on the phone (the photo itself isn't uploaded anywhere) */
$("ratePhoto").addEventListener("change", async () => {
  const file = $("ratePhoto").files[0];
  photoMeta = ""; $("photoMeta").textContent = "";
  if (!file || !rateEvent) return;
  $("photoMeta").textContent = "Reading the photo…";
  let meta = null;
  try {
    const x = readExif(await file.slice(0, 256 * 1024).arrayBuffer());   // EXIF sits at the start of the file
    // camera clocks have no time zone: treat the time as local to the spot
    const k = x.taken;
    const taken = k ? Date.UTC(k.y, k.m - 1, k.d, k.hh, k.mm, k.ss) / 1000 - state.data.offset : null;
    meta = { takenUnix: taken, lat: x.lat, lon: x.lon };
  } catch { meta = null; }
  photoMeta = M.photoCheck(state.place, meta, rateEvent.t, state.data.offset, state.data.kind);
  $("photoMeta").textContent = photoMeta.charAt(0).toUpperCase() + photoMeta.slice(1) + ".";
});
function renderRate() {
  const d = state.data, e = state.past ? state.events[0] : recentEvent(d);
  rateEvent = e;
  $("rateCard").hidden = !e;
  if (!e) { renderRateBanner(); return; }
  const off = d.offset, word = d.kind;
  const id = entryId(d.kind, e.t, off, state.place);
  const existing = logAll().find(x => x.id === id);
  rateSel = existing ? existing.rating : null;
  const dn = dayName(e.t, off, d.kind);
  $("rateTitle").textContent = dn === "Tonight" || dn === "Today" ? `How was ${dn.toLowerCase()}'s ${word}?` : `How was the ${word} on ${dn}?`;
  $("rateSub").textContent = `The app ${state.past ? "would have predicted" : "predicted"} ${e.score}/100 for the ${word} at ${clock(e.t, off)}. Your rating helps tune the model.`;
  $("rateNotes").value = existing ? existing.notes : "";
  $("rateShare").hidden = !existing;
  if (existing) setLogLink(existing);
  photoMeta = existing ? existing.photoMeta || "" : ""; $("photoMeta").textContent = ""; $("ratePhoto").value = "";
  $("rateSave").textContent = existing && existing.notes ? "Update note" : "Save note";
  $("rateMsg").textContent = existing ? `Saved: ${bandText(existing.rating)}. The app said ${existing.predicted}. Tap another to change it.` : "";
  $("rateMore").open = false;
  $("rateShareNote").hidden = !sharing() || !!existing;
  drawScale();
  renderRateBanner();
}
/* One-tap bands line up with the app's 0–100 score, so a rating reads straight against the forecast. */
const BANDS = [
  { name: "Dull", lo: 0, hi: 24 }, { name: "Some colour", lo: 25, hi: 49 }, { name: "Good", lo: 50, hi: 74 },
  { name: "Great", lo: 75, hi: 89 }, { name: "On fire", lo: 90, hi: 100 },
];
const bandFor = score100 => BANDS.find(b => score100 <= b.hi) || BANDS[BANDS.length - 1];
const QUICK_NAME = n => bandFor(n * 10).name;
const bandText = n => { const b = bandFor(n * 10); return `${b.name} (${b.lo}–${b.hi})`; };
function drawScale() {
  document.querySelectorAll("#quick button").forEach(b => {
    const on = rateSel != null && QUICK_NAME(rateSel) === b.dataset.band;
    b.classList.toggle("on", on); b.setAttribute("aria-checked", on);
  });
}
$("quick").addEventListener("click", ev => {
  const b = ev.target.closest("button"); if (!b) return;
  rateSel = Number(b.dataset.n); drawScale(); saveRating(true);
});
$("rateSave").addEventListener("click", () => saveRating(false));
async function saveRating(quick) {
  if (rateSel == null) { $("rateMsg").textContent = "Tap how colourful it was first."; return; }
  const d = state.data, e = rateEvent, p = state.place;
  $("rateMsg").textContent = "Saving…";
  const pos = state.past ? null : await currentPosition();
  const ver = state.past ? { onLocation: false, text: "rated later from a past date" } : M.verification(p, pos, Date.now() / 1000, e.t, d.kind);
  const entry = {
    id: entryId(d.kind, e.t, d.offset, p), kind: d.kind, t: e.t, offset: d.offset,
    place: { name: p.label || p.name, detail: p.detail || "", lat: +p.lat.toFixed(4), lon: +p.lon.toFixed(4) },
    facing: Math.round(d.az), predicted: e.score, model: M.MODEL_VERSION,
    inputs: Object.fromEntries(Object.entries(e.inputs).map(([k, v]) => [k, v == null ? null : Math.round(v)])),
    rating: rateSel, notes: $("rateNotes").value.trim(), savedAt: Date.now(),
    date: isoDay(e.t, d.offset), verification: ver.text, onLocation: ver.onLocation, photoMeta,
  };
  const log = logAll().filter(x => x.id !== entry.id);
  log.push(entry); log.sort((a, b) => b.t - a.t);
  store.set("wib-log", log);
  $("rateMsg").innerHTML = `Thanks. Saved: <b>${bandText(entry.rating)}</b>${quick ? "" : " with your note"}. The app said ${entry.predicted}${entry.onLocation ? ' <span class="badge-ok">✓ on location</span>' : ""}`;
  $("rateShare").hidden = false; $("rateSave").textContent = entry.notes ? "Update note" : "Save note";
  setLogLink(entry);
  renderLog(); renderRateBanner();
  shareRating(entry);
}

/* ---------- anonymous rating sharing (Netlify Forms) ---------- */
const isDev = () => !!store.get("wib-dev", false);
const sharing = () => store.get("wib-share", true) !== false;
function clientId() {
  let id = store.get("wib-client", "");
  if (!id) { id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); store.set("wib-client", id); }
  return id;
}
function sharePayload(x) {
  const dev = isDev(), r = v => Math.round(v * 100) / 100; // about 1 km for everyone but the developer
  return {
    id: x.id, kind: x.kind, date: x.date, t: x.t, rating: x.rating, predicted: x.predicted, model: x.model,
    band: (b => `${b.lo}-${b.hi}`)(bandFor(x.rating * 10)), predictedBand: (b => `${b.lo}-${b.hi}`)(bandFor(x.predicted)),
    inputs: x.inputs, facing: x.facing, onLocation: !!x.onLocation,
    lat: dev ? x.place.lat : r(x.place.lat), lon: dev ? x.place.lon : r(x.place.lon),
    place: dev ? x.place.name : undefined, notes: dev ? x.notes || "" : undefined, savedAt: x.savedAt,
  };
}
async function shareRating(x) {
  if (!sharing() || location.protocol === "file:") return false;
  try {
    const body = new URLSearchParams({ "form-name": "rating", "bot-field": "", entry: JSON.stringify(sharePayload(x)),
      client: clientId(), dev: isDev() ? "1" : "0", release: RELEASE });
    const res = await fetch("/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
    if (!res.ok) return false;
    store.set("wib-log", logAll().map(e => e.id === x.id ? { ...e, sharedAt: Date.now() } : e));
    return true;
  } catch { return false; }
}
/** Send any rating saved or changed since it was last shared (e.g. rated offline). */
async function shareBacklog() {
  if (!sharing()) return;
  for (const x of logAll().filter(e => !e.sharedAt || e.sharedAt < e.savedAt).slice(0, 10)) await shareRating(x);
}
function renderRateBanner() {
  const e = rateEvent, b = $("rateBanner");
  if (!e || state.past || !state.data) { b.hidden = true; return; }
  const d = state.data, id = entryId(d.kind, e.t, d.offset, state.place);
  const done = logAll().some(x => x.id === id);
  const dn = dayName(e.t, d.offset, d.kind);
  b.textContent = `How was ${dn === "Tonight" || dn === "Today" ? dn.toLowerCase() + "'s" : "the"} ${d.kind}? Rate it ↓`;
  b.hidden = done;
}
$("rateBanner").addEventListener("click", () => $("rateCard").scrollIntoView({ behavior: "smooth", block: "start" }));

function logUrl(x) {
  const word = x.kind === "sunset" ? "Sunset" : "Sunrise";
  const title = `${word} ${x.date} – ${x.place.name} – ${QUICK_NAME(x.rating)}`;
  const body = M.logIssueBody(x, clock(x.t, x.offset));
  return `https://github.com/${logRepo()}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
function setLogLink(x) { applyLogMode(); if (githubLogging()) { $("rateLog").href = logUrl(x); $("rateLog").dataset.id = x.id; } }
function markSent(id) {
  store.set("wib-log", logAll().map(x => x.id === id ? { ...x, sentAt: Date.now() } : x));
  renderLog();
}
$("rateLog").addEventListener("click", () => setTimeout(() => markSent($("rateLog").dataset.id), 0));

function entryText(x) {
  const word = x.kind === "sunset" ? "Sunset" : "Sunrise";
  const lines = [
    `${word} ${isoDay(x.t, x.offset)} at ${clock(x.t, x.offset)}`,
    `Place: ${x.place.name}${x.place.detail ? ", " + x.place.detail : ""} (${x.place.lat}, ${x.place.lon})`,
    `Facing: ${M.compass(x.facing)} (${x.facing}°)`,
    `App score: ${x.predicted}/100 (model ${x.model})`,
    `My rating: ${bandText(x.rating)}`,
  ];
  if (x.notes) lines.push(`Notes: ${x.notes}`);
  if (x.verification) lines.push(`Check: ${x.verification}${x.photoMeta ? "; " + x.photoMeta : ""}`);
  return lines.join("\n");
}
async function copyText(text, msgEl) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta);
    ta.select(); let ok = false; try { ok = document.execCommand("copy"); } catch { /* ignore */ }
    ta.remove();
    if (!ok) { msgEl.textContent = "Couldn't copy automatically on this phone."; return; }
  }
  msgEl.textContent = "Copied. Paste it into Claude with your photo.";
}
$("rateCopy").addEventListener("click", () => {
  const e = logAll().find(x => x.id === entryId(state.data.kind, rateEvent.t, state.data.offset, state.place));
  if (e) copyText("Sunscore log entry\n" + entryText(e), $("rateMsg"));
});

function renderLog() {
  const log = logAll();
  $("logCard").hidden = !log.length;
  $("logEmpty").hidden = !!log.length;
  $("logCount").textContent = log.length ? `(${log.length})` : "";
  $("logList").innerHTML = log.map(x => `
    <div class="log-item">
      <div>${esc(x.place.name)}${x.onLocation ? '<span class="badge-ok">✓ on location</span>' : ""}<div class="lp">${x.kind === "sunset" ? "Sunset" : "Sunrise"} · ${esc(isoDay(x.t, x.offset))}${x.notes ? " · " + esc(x.notes.slice(0, 60)) : ""}</div></div>
      <div class="lr">${QUICK_NAME(x.rating)}<div class="lp">App ${x.predicted}</div></div>
      <div class="log-actions">
        ${githubLogging()
          ? `<a class="btn small ${x.sentAt ? "ghost" : "linkbtn-solid"} log-send" data-id="${esc(x.id)}" href="${esc(logUrl(x))}" target="_blank" rel="noopener">${x.sentAt ? "Logged ✓ · log again" : "Log on GitHub"}</a>`
          : `<button class="btn small ghost log-copy" data-id="${esc(x.id)}">Copy for Claude</button>`}
        <button class="del" data-id="${esc(x.id)}">Delete</button>
      </div>
    </div>`).join("");
}
$("logList").addEventListener("click", ev => {
  const cp = ev.target.closest(".log-copy");
  if (cp) { const e = logAll().find(x => x.id === cp.dataset.id); if (e) copyText("Sunscore log entry\n" + entryText(e), $("logMsg")); return; }
  const send = ev.target.closest(".log-send");
  if (send) { const id = send.dataset.id; setTimeout(() => markSent(id), 0); return; }
  const b = ev.target.closest(".del"); if (!b) return;
  store.set("wib-log", logAll().filter(x => x.id !== b.dataset.id));
  renderLog(); if (state.data) renderRate();
});
$("logCopyAll").addEventListener("click", () => {
  const log = logAll();
  copyText(`Sunscore log: ${log.length} entr${log.length === 1 ? "y" : "ies"}\n\n` + log.map(entryText).join("\n\n"), $("logMsg"));
});


/* ---------- batch scoring for several places ---------- */
/** Score several places at once (one request). If t is given, score that time; otherwise each place's next event. */
async function scoreSpots(spots, kind, t = null) {
  const now = Date.now() / 1000;
  const az = M.eventAzimuth(spots[0].lat, M.dayOfYear(t || now), kind);
  const pts = spots.flatMap(sp => M.ALL_KM.map(km => M.destination(sp.lat, sp.lon, az, km)));
  const daysAhead = t ? Math.ceil((t - now) / 86400) + 2 : 2;
  const params = new URLSearchParams({
    latitude: pts.map(p => p[0].toFixed(3)).join(","), longitude: pts.map(p => p[1].toFixed(3)).join(","),
    hourly: M.VARS.join(","), daily: "sunset,sunrise", models: M.WEATHER_MODELS.join(","), timezone: "auto", timeformat: "unixtime",
    forecast_days: String(Math.min(8, Math.max(2, daysAhead))),
  });
  let data = await getJSON("https://api.open-meteo.com/v1/forecast?" + params, 20000);
  if (!Array.isArray(data)) data = [data];
  const n = M.ALL_KM.length;
  return spots.map((sp, i) => {
    const locs = data.slice(i * n, i * n + n);
    let when = t;
    if (when == null) when = M.eventTimes(locs[0].daily, kind).find(x => x != null && x + 20 * 60 > now);
    if (when == null) return { ...sp, score: null };
    const r = M.scoreModels(locs, when);
    return r ? { ...sp, offset: locs[0].utc_offset_seconds || 0, ...r } : { ...sp, score: null };
  });
}

/* ---------- saved spots ---------- */
const spotsAll = () => store.get("wib-spots", []);
const sameSpot = (a, b) => Math.abs(a.lat - b.lat) < 0.002 && Math.abs(a.lon - b.lon) < 0.002;
function renderSaveButton() {
  const p = state.place; if (!p) return;
  const saved = spotsAll().some(x => sameSpot(x, p));
  $("saveSpot").hidden = false;
  $("saveSpot").textContent = saved ? "★ Saved spot (tap to remove)" : "☆ Save this spot";
}
$("saveSpot").addEventListener("click", () => {
  const p = state.place, list = spotsAll();
  if (list.some(x => sameSpot(x, p))) store.set("wib-spots", list.filter(x => !sameSpot(x, p)));
  else {
    const name = p.gps && p.label === "My location" ? prompt_name(p) : (p.label || p.name);
    list.unshift({ name, detail: p.detail || "", lat: +p.lat.toFixed(4), lon: +p.lon.toFixed(4) });
    store.set("wib-spots", list.slice(0, 12));
  }
  renderSaveButton();
  renderMySpots();
});
const prompt_name = p => `Spot at ${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`;

async function renderSpots() {
  const list = spotsAll();
  $("spots").hidden = !list.length;
  if (!list.length) return;
  $("spotList").innerHTML = list.map((sp, i) => `
    <button type="button" class="spot-row" data-i="${i}"><span>${esc(sp.name)}<br><small>${esc(sp.detail || `${sp.lat}, ${sp.lon}`)}</small></span><span class="spot-score" id="spotScore${i}">…</span></button>`).join("");
  try {
    const scored = await scoreSpots(list.slice(0, 10), state.kind);
    scored.forEach((sp, i) => { const el = $("spotScore" + i); if (el) { el.textContent = sp.score ?? "–"; el.style.color = sp.score != null ? scoreColour(sp.score) : ""; } });
  } catch { list.forEach((_, i) => { const el = $("spotScore" + i); if (el) el.textContent = ""; }); }
}
async function renderMySpots() {
  const list = spotsAll().slice(0, 12);
  $("mySpotsEmpty").hidden = !!list.length;
  $("mySpots").innerHTML = list.map((sp, i) => `
    <button class="spot-item" data-i="${i}"><span id="msi${i}" class="ms-slot"></span><span>${esc(sp.name)}<small id="msw${i}">${esc(sp.detail || `${sp.lat}, ${sp.lon}`)}</small></span><span class="ss" id="ms${i}">…</span></button>`).join("");
  if (!list.length) return;
  const kind = state.kind;
  try {
    const scored = await scoreSpots(list, kind);
    if (kind !== state.kind) return;
    scored.forEach((sp, i) => {
      const el = $("ms" + i); if (!el) return;
      el.textContent = sp.score ?? "–"; el.style.color = sp.score != null ? scoreColour(sp.score) : "";
      if (sp.score != null) { $("msi" + i).innerHTML = V.miniStack(sp); $("msw" + i).textContent = `${dayName(sp.t, sp.offset, kind)} · ${sp.verdict}`; }
    });
  } catch { list.forEach((_, i) => { const el = $("ms" + i); if (el) el.textContent = "–"; }); }
}
$("mySpots").addEventListener("click", ev => {
  const b = ev.target.closest(".spot-item"); if (!b) return;
  const sp = spotsAll()[Number(b.dataset.i)];
  run({ name: sp.name, label: sp.name, detail: sp.detail, lat: sp.lat, lon: sp.lon });
  showTab("tonight");
});

$("spotList").addEventListener("click", ev => {
  const b = ev.target.closest(".spot-row"); if (!b) return;
  const sp = spotsAll()[Number(b.dataset.i)];
  run({ name: sp.name, label: sp.name, detail: sp.detail, lat: sp.lat, lon: sp.lon });
});

/* ---------- find a better spot nearby ---------- */
let nearRadius = 25, nearMap = null, nearLayer = null;
document.querySelectorAll(".radius").forEach(b => b.addEventListener("click", () => {
  nearRadius = Number(b.dataset.r);
  document.querySelectorAll(".radius").forEach(x => x.classList.toggle("on", x === b));
}));
$("scanBtn").addEventListener("click", async () => {
  $("scanBtn").disabled = true; $("nearList").innerHTML = "";
  try {
    const found = await viewpointScan(nearRadius);
    if (!found) await ringScan(nearRadius, true);
  } catch {
    $("nearStatus").textContent = "Couldn't search right now. Try again in a minute.";
  } finally { $("scanBtn").disabled = false; }
});

/* real places from OpenStreetMap; returns false if there are too few to be useful */
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
async function overpass(query) {
  for (const url of OVERPASS) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const r = await fetch(url, { method: "POST", body: new URLSearchParams({ data: query }), signal: ctrl.signal });
      if (r.ok) return await r.json();
    } catch { /* try the next server */ } finally { clearTimeout(timer); }
  }
  throw new Error("overpass unavailable");
}
const directionsUrl = x => `https://www.google.com/maps/dir/?api=1&destination=${x.lat.toFixed(5)},${x.lon.toFixed(5)}`;
async function viewpointScan(R) {
  const p = state.place, e = state.events[state.sel], d = state.data;
  $("nearStatus").textContent = `Looking for viewpoints within ${R} km…`;
  let places;
  try { places = M.parseViewpoints(await overpass(M.overpassQuery(p.lat, p.lon, R)), p.lat, p.lon, 12); }
  catch { places = []; }
  if (places.length < 2) return false;
  $("nearStatus").textContent = `Scoring ${places.length} places…`;
  const here = { lat: p.lat, lon: p.lon, dist: 0, dir: "", name: "Where you are", kindLabel: "" };
  const scored = (await scoreSpots([here, ...places], d.kind, e.t)).filter(x => x.score != null);
  // the real horizon towards the sun for each place (cached; a few seconds the first time)
  for (const x of scored) {
    try { const h = await terrainFor(x.lat, x.lon, d.az); x.view = M.viewOpenness(h.angle); } catch { x.view = null; }
  }
  for (const x of scored) x.rank = x.score - (x.view ? x.view.penalty : 0);
  const h = scored.find(x => x.dist === 0), spots = scored.filter(x => x.dist !== 0).sort((a, b) => b.rank - a.rank);
  const best = spots[0];
  const open = spots.filter(x => x.view && x.view.level === "open");
  $("nearStatus").innerHTML = !best ? "" :
    `<b>Best bet: ${esc(best.name)}</b>, ${best.dist} km ${best.dir}: scores ${best.score}${best.view ? `, ${best.view.text}` : ""}.` +
    (h ? (Math.abs(best.score - h.score) <= 3 ? ` The sky is much the same where you are (${h.score}), so pick for the view.` : ` Where you are: ${h.score}.`) : "") +
    (open.length ? "" : " None of these has a fully open view towards the sun.");
  $("nearList").innerHTML = spots.slice(0, 8).map(x => `
    <div class="vp">
      <button class="near-item" data-lat="${x.lat}" data-lon="${x.lon}" data-name="${esc(x.name)}" data-vp="1">
        <span>${esc(x.name)}<br><small>${x.kindLabel}${x.ele ? ` · ${Math.round(x.ele)} m` : ""} · ${x.dist} km ${x.dir}${x.view ? ` · ${x.view.text}` : ""}</small></span>
        <span class="ns" style="color:${scoreColour(x.score)}">${x.score}</span>
      </button>
      <a class="vp-go" href="${directionsUrl(x)}" target="_blank" rel="noopener" aria-label="Directions to ${esc(x.name)}">Go ↗</a>
    </div>`).join("") +
    `<div class="note">Places from OpenStreetMap. Tap one to see its full forecast. Peaks and cliffs may need a walk, and access isn't checked.</div>`;
  drawNearMap(h ? [h, ...spots.slice(0, 8)] : spots.slice(0, 8), p);
  return true;
}

async function ringScan(R, fallback = false) {
  const p = state.place, e = state.events[state.sel], d = state.data;
  const cands = [{ lat: p.lat, lon: p.lon, dist: 0, dir: "" }];
  for (const [ring, n] of [[R / 2, 8], [R, 8]]) {
    for (let k = 0; k < n; k++) {
      const brg = k * 360 / n + (ring === R ? 22.5 : 0);
      const [la, lo] = M.destination(p.lat, p.lon, brg, ring);
      cands.push({ lat: la, lon: lo, dist: Math.round(ring), dir: M.compass(brg) });
    }
  }
  $("nearStatus").textContent = `No mapped viewpoints found, so scanning ${cands.length} areas around you…`;
  {
    const scored = (await scoreSpots(cands, d.kind, e.t)).filter(x => x.score != null);
    const here = scored.find(x => x.dist === 0);
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const spread = best.score - Math.min(...scored.map(x => x.score));
    $("nearStatus").innerHTML = (fallback ? `No mapped viewpoints within ${R} km. Here's how the sky compares around you. ` : "") + (!here ? ""
      : best.dist !== 0 && best.score - here.score >= 8 ? `<b>${best.dist} km ${best.dir} looks better:</b> ${best.score} vs ${here.score} here.`
      : spread < 5 ? `<b>Much the same everywhere within ${R} km</b> (around ${here.score}), so there's no need to travel for this one.`
      : here.score >= 50 ? `<b>You're already in a good spot.</b> Nowhere within ${R} km scores clearly better than here (${here.score}).`
      : `<b>Nowhere nearby is clearly better</b> than here (${here.score}).`);
    $("nearList").innerHTML = scored.slice(0, 6).map(x => `
      <button class="near-item" data-lat="${x.lat}" data-lon="${x.lon}" data-name="${x.dist ? `${x.dist} km ${x.dir}` : "Here"}">
        <span>${x.dist ? `${x.dist} km ${x.dir}` : "Where you are"}<br><small>${x.verdict}${x.dist ? " · tap to check it" : ""}</small></span>
        <span class="ns" style="color:${scoreColour(x.score)}">${x.score}</span>
      </button>`).join("") + `<div class="note">This only knows about the sky. Check the spot has an open view ${M.compass(d.az)}, with no hills, trees or buildings in the way.</div>`;
    drawNearMap(scored, p);
    nameNearby(scored.slice(0, 6).filter(x => x.dist));
    flagTerrain(scored.slice(0, 6), d.az);
  }
}
async function flagTerrain(list, az) {
  for (const x of list) {
    try {
      const h = await terrainFor(x.lat, x.lon, az);
      const btn = document.querySelector(`.near-item[data-lat="${x.lat}"][data-lon="${x.lon}"] small`);
      if (btn && h.angle >= 2) btn.textContent += ` · hills ${h.angle.toFixed(0)}° high towards the sun`;
      else if (btn && h.angle < 0.5) btn.textContent += " · open horizon";
    } catch { /* skip */ }
  }
}
async function reverseName(lat, lon) {
  const d = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`, 8000);
  return d.locality || d.city || null;
}
async function nameNearby(list) {
  await Promise.all(list.map(async x => {
    try {
      const name = await reverseName(x.lat, x.lon);
      const btn = document.querySelector(`.near-item[data-lat="${x.lat}"][data-lon="${x.lon}"]`);
      if (!name || !btn) return;
      btn.dataset.place = name;
      btn.querySelector("span").firstChild.textContent = `${x.dist} km ${x.dir} · near ${name}`;
    } catch { /* keep the distance-only label */ }
  }));
}
$("nearList").addEventListener("click", ev => {
  const b = ev.target.closest(".near-item"); if (!b || b.dataset.name === "Here") return;
  if (b.dataset.vp) {
    run({ name: b.dataset.name, label: b.dataset.name, detail: "", lat: Number(b.dataset.lat), lon: Number(b.dataset.lon) });
    showTab("tonight"); return;
  }
  const base = state.place.label || state.place.name;
  const label = b.dataset.place ? `Near ${b.dataset.place}` : `${b.dataset.name} of ${base}`;
  const detail = b.dataset.place ? `${b.dataset.name} of ${base.replace(/^Near /, "")}` : "";
  run({ name: label, label, detail, lat: Number(b.dataset.lat), lon: Number(b.dataset.lon) });
  showTab("tonight");
});
async function drawNearMap(scored, p) {
  let L; try { L = await loadLeaflet(); } catch { return; }
  $("nearMap").hidden = false;
  if (!nearMap) {
    nearMap = L.map("nearMap", { zoomControl: false });
    L.tileLayer(TILE_URL, { maxZoom: 18, className: "dark-tiles", attribution: TILE_ATTR }).addTo(nearMap);
  }
  if (nearLayer) nearLayer.remove();
  nearLayer = L.layerGroup().addTo(nearMap);
  for (const x of scored) {
    L.circleMarker([x.lat, x.lon], { radius: x.dist === 0 ? 13 : 11, color: x.dist === 0 ? "#fff" : "rgba(255,255,255,0.6)", weight: 2, fillColor: scoreColour(x.score), fillOpacity: 0.95 })
      .bindTooltip(String(x.score), { permanent: true, direction: "center", className: "near-tip" }).addTo(nearLayer);
  }
  nearMap.fitBounds(L.latLngBounds(scored.map(x => [x.lat, x.lon])).pad(0.12));
  setTimeout(() => nearMap.invalidateSize(), 50);
}


/* ---------- past dates ---------- */
async function loadPast(place, kind, dateStr) {
  const day = new Date(dateStr + "T12:00:00Z").getTime() / 1000;
  const az = M.eventAzimuth(place.lat, M.dayOfYear(day), kind);
  const pts = M.ALL_KM.map(km => M.destination(place.lat, place.lon, az, km));
  const next = new Date(day * 1000 + 86400000).toISOString().slice(0, 10);
  const recent = (Date.now() / 1000 - day) / 86400 <= 85;
  const params = new URLSearchParams({
    latitude: pts.map(p => p[0].toFixed(4)).join(","), longitude: pts.map(p => p[1].toFixed(4)).join(","),
    hourly: M.VARS.join(","), daily: "sunset,sunrise", models: M.WEATHER_MODELS.join(","), timezone: "auto", timeformat: "unixtime",
    start_date: dateStr, end_date: next,
  });
  const base = recent ? "https://api.open-meteo.com/v1/forecast?" : "https://historical-forecast-api.open-meteo.com/v1/forecast?";
  let data;
  try { data = await getJSON(base + params, 20000); }
  catch (err) {
    // the archive may not support every variable: retry with the core set
    params.set("hourly", ["cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high", "relative_humidity_2m", "precipitation"].join(","));
    data = await getJSON(base + params, 20000);
  }
  if (!Array.isArray(data)) data = [data];
  const d = { locations: data, az, pts, offset: data[0].utc_offset_seconds || 0, kind };
  const t = M.eventTimes(data[0].daily, kind)[0];
  if (t == null) throw new Error("no-event");
  const e = M.scoreModels(data, t);
  if (!e) throw new Error("no-data");
  return { d, e };
}

(() => {
  const today = new Date(), min = "2022-01-01";
  const iso = x => x.toISOString().slice(0, 10);
  $("pastDate").max = iso(today); $("pastDate").min = min;
  $("pastDate").value = iso(new Date(today.getTime() - 86400000));
})();
$("pastGo").addEventListener("click", async () => {
  const v = $("pastDate").value;
  if (!v) { $("pastStatus").textContent = "Pick a date first."; return; }
  if (v > new Date().toISOString().slice(0, 10)) { $("pastStatus").textContent = "Pick today or an earlier date."; return; }
  if (v < "2022-01-01") { $("pastStatus").textContent = "The archive goes back to 2022."; return; }
  $("pastGo").disabled = true; $("pastStatus").textContent = "Looking up the archived forecast…";
  try {
    const { d, e } = await loadPast(state.place, state.kind, v);
    state.live = state.live || { data: state.data, events: state.events, sel: state.sel };
    state.past = true; state.data = d; state.events = [e]; state.sel = 0;
    $("pastStatus").textContent = "";
    applyPastUi(); renderSelected(); renderRate();
    showTab("tonight");
  } catch (err) {
    $("pastStatus").textContent = err.message === "no-event" ? `There was no ${state.kind} here that day.`
      : "Couldn't get archived data for that date. Try another date.";
  } finally { $("pastGo").disabled = false; }
});
function applyPastUi() {
  $("pastBar").hidden = !state.past;
  $("weekCard").hidden = state.past;
  $("nearCard").hidden = state.past;
  $("countdown").hidden = state.past;
}
function leavePast() {
  if (!state.past) return;
  Object.assign(state, state.live, { past: false, live: null });
  applyPastUi(); renderSelected(); renderRate();
}
$("pastBack").addEventListener("click", leavePast);


/* ---------- share card ---------- */
async function shareCard() {
  const d = state.data, e = state.events[state.sel], p = state.place;
  const W = 1080, H = 1350, c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d"), t = e.score / 100;
  try { await document.fonts.ready; } catch { /* fonts optional */ }
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, mix("2b2d38", "2a1846", t)); grad.addColorStop(0.55, mix("4b4e5c", "b8336a", t)); grad.addColorStop(1, mix("6e707b", "ff7a2f", t));
  g.fillStyle = grad; g.fillRect(0, 0, W, H);
  // sun on the horizon
  const glow = g.createRadialGradient(W / 2, H * 0.86, 10, W / 2, H * 0.86, 420);
  glow.addColorStop(0, `rgba(255,200,120,${0.25 + 0.5 * t})`); glow.addColorStop(1, "rgba(255,200,120,0)");
  g.fillStyle = glow; g.fillRect(0, 0, W, H);
  g.fillStyle = mix("c9c6c0", "ffd27a", t); g.beginPath(); g.arc(W / 2, H * 0.86, 130, Math.PI, 0); g.fill();
  g.fillStyle = "#1a1424"; g.fillRect(0, H * 0.86, W, H);
  g.fillStyle = "#fff"; g.textAlign = "center";
  const serif = '"Fraunces", Georgia, serif', sans = '"Inter", system-ui, sans-serif';
  g.font = `700 52px ${serif}`; g.fillText("Sunscore", W / 2, 130);
  g.globalAlpha = 0.85; g.font = `500 42px ${sans}`;
  g.fillText(`${dayName(e.t, d.offset, d.kind)} · ${d.kind} ${clock(e.t, d.offset)}`, W / 2, 260);
  g.globalAlpha = 1; g.font = `700 340px ${serif}`; g.fillText(String(e.score), W / 2, 620);
  g.font = `500 76px ${serif}`; g.fillText(e.verdict, W / 2, 760);
  g.globalAlpha = 0.85; g.font = `500 40px ${sans}`;
  const place = (p.label || p.name).slice(0, 40);
  g.fillText(place, W / 2, 860);
  g.globalAlpha = 0.7; g.font = `400 30px ${sans}`;
  g.fillText("rickybalboasun.github.io/Will-it-burn", W / 2, H - 60);
  g.globalAlpha = 1;

  const where = /^near /i.test(place) ? place.replace(/^near/i, "near") : `at ${place}`;
  const text = `${dayName(e.t, d.offset, d.kind)}'s ${d.kind} ${where}: ${e.score}/100, ${e.verdict.toLowerCase().replace(/!$/, "")}${e.score >= 50 ? " 🔥" : ""}`;
  const url = location.href.split("#")[0];
  try {
    const blob = await new Promise(r => c.toBlob(r, "image/png"));
    const file = new File([blob], "will-it-burn.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text, title: "Sunscore" }); return; }
    if (navigator.share) { await navigator.share({ text, url, title: "Sunscore" }); return; }
  } catch (err) { if (err && err.name === "AbortError") return; }
  copyText(`${text}\n${url}`, $("shareMsg"));
}
$("shareBtn").addEventListener("click", shareCard);


/* ---------- add to calendar ---------- */
function icsDate(unix) { return new Date(unix * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
$("calBtn").addEventListener("click", () => {
  const d = state.data, e = state.events[state.sel], p = state.place;
  const v = M.viewingTimes(p.lat, p.lon, e.t, d.kind);
  const start = d.kind === "sunset" ? (v.golden || e.t - 3600) : (v.civil || e.t - 1800);
  const end = d.kind === "sunset" ? (v.civil || e.t + 1800) : (v.golden || e.t + 1800);
  const word = d.kind === "sunset" ? "Sunset" : "Sunrise";
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sunscore//EN", "BEGIN:VEVENT",
    `UID:${entryId(d.kind, e.t, d.offset, p)}@will-it-burn`, `DTSTAMP:${icsDate(Date.now() / 1000)}`,
    `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${word} ${e.score}/100 – ${e.verdict.replace(/[,;]/g, "")}`,
    `LOCATION:${(p.label || p.name).replace(/[,;]/g, " ")}`, `GEO:${p.lat.toFixed(4)};${p.lon.toFixed(4)}`,
    `DESCRIPTION:${word} at ${clock(e.t, d.offset)}. Face ${M.compass(d.az)}. Forecast score ${e.score}/100 – check again nearer the time: ${location.href.split("#")[0]}`,
    "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", `DESCRIPTION:${word} soon`, "END:VALARM",
    "END:VEVENT",
    // a short follow-up event so the phone nudges a rating once the colour has gone
    "BEGIN:VEVENT", `UID:rate-${entryId(d.kind, e.t, d.offset, p)}@sunscore`, `DTSTAMP:${icsDate(Date.now() / 1000)}`,
    `DTSTART:${icsDate(end + 15 * 60)}`, `DTEND:${icsDate(end + 20 * 60)}`,
    `SUMMARY:Rate the ${word.toLowerCase()} in Sunscore`,
    `DESCRIPTION:How was it? One tap: ${location.href.split("#")[0]}`,
    "BEGIN:VALARM", "TRIGGER:PT0M", "ACTION:DISPLAY", `DESCRIPTION:How was the ${word.toLowerCase()}?`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ];
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `${word.toLowerCase()}-${isoDay(e.t, d.offset)}.ics`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  $("timesMsg").textContent = "Calendar file downloaded. Open it to add the event, with a reminder 30 minutes before.";
});

/* ---------- which way? compass ---------- */
let compassOn = false, needleAngle = 0;
function setNeedle(a) { // rotate the short way round, so the arrow never spins through 360°
  needleAngle += ((a - needleAngle) % 360 + 540) % 360 - 180;
  $("needle").style.transform = `rotate(${needleAngle}deg)`;
}
function onHeading(ev) {
  let heading = null;
  if (typeof ev.webkitCompassHeading === "number") heading = ev.webkitCompassHeading;     // iOS
  else if (ev.absolute && ev.alpha != null) heading = (360 - ev.alpha) % 360;              // Android
  if (heading == null) return;
  const target = state.data.az, turn = ((target - heading + 540) % 360) - 180;
  setNeedle(turn);
  $("compassText").innerHTML = Math.abs(turn) < 10
    ? `<b>That way!</b> The sun ${state.data.kind === "sunset" ? "sets" : "rises"} straight ahead (${Math.round(target)}°).`
    : `Turn ${turn > 0 ? "right" : "left"} ${Math.round(Math.abs(turn))}° to face the ${state.data.kind}.`;
}
$("compassBtn").addEventListener("click", async () => {
  if (compassOn) {
    compassOn = false; $("compassBox").hidden = true; $("compassBtn").textContent = "Which way?";
    window.removeEventListener("deviceorientationabsolute", onHeading); window.removeEventListener("deviceorientation", onHeading);
    return;
  }
  try {
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      if (await DeviceOrientationEvent.requestPermission() !== "granted") throw new Error("denied");
    }
  } catch {
    $("timesMsg").textContent = `Compass access wasn't allowed. Face ${M.compass(state.data.az)} (${Math.round(state.data.az)}° on a compass).`;
    return;
  }
  compassOn = true; $("compassBox").hidden = false; $("compassBtn").textContent = "Hide compass";
  setNeedle(state.data.az);
  $("compassText").textContent = `Hold your phone flat. The arrow points ${M.compass(state.data.az)} (${Math.round(state.data.az)}°), where the sun ${state.data.kind === "sunset" ? "sets" : "rises"}.`;
  if ("ondeviceorientationabsolute" in window) window.addEventListener("deviceorientationabsolute", onHeading);
  else window.addEventListener("deviceorientation", onHeading);
});


/* ---------- service worker and alerts ---------- */
let swReg = null, swModule = false;
async function registerWorker() {
  try { swReg = await navigator.serviceWorker.register("sw.js", { type: "module" }); swModule = true; }
  catch { try { swReg = await navigator.serviceWorker.register("sw-classic.js"); } catch { /* no offline support */ } }
  renderAlerts();
}
function swCall(msg, ms = 20000) {
  return new Promise((resolve, reject) => {
    const target = (swReg && swReg.active) || navigator.serviceWorker.controller;
    if (!target) { reject(new Error("no-worker")); return; }
    const ch = new MessageChannel(), timer = setTimeout(() => reject(new Error("timeout")), ms);
    ch.port1.onmessage = ev => { clearTimeout(timer); resolve(ev.data); };
    target.postMessage(msg, [ch.port2]);
  });
}
const CONFIG_URL = () => new URL("__alert-config", (swReg && swReg.scope) || location.href).href;
async function alertConfig() {
  try { const r = await (await caches.open("wib-config")).match(CONFIG_URL()); return r ? await r.json() : null; } catch { return null; }
}
async function saveAlertConfig(cfg) {
  await (await caches.open("wib-config")).put(CONFIG_URL(), new Response(JSON.stringify(cfg), { headers: { "Content-Type": "application/json" } }));
}
function alertSupport() {
  if (!("serviceWorker" in navigator) || !swReg) return "no-worker";
  if (!swModule) return "no-module";
  if (!("periodicSync" in swReg)) return "no-periodic";
  if (!("Notification" in window)) return "no-notifications";
  return "ok";
}
async function renderAlerts() {
  document.querySelectorAll(".kindWord").forEach(x => x.textContent = state.kind);
  const cfg = await alertConfig(), on = !!(cfg && cfg.enabled);
  $("alertOn").hidden = false; $("alertOn").textContent = on ? "Update alert" : "Turn on alerts";
  $("alertOff").hidden = !on; $("alertTest").hidden = !on;
  $("alertBadge").textContent = on ? "(on)" : "";
  if (on) {
    $("alertThreshold").value = String(cfg.threshold);
    const last = cfg.lastCheck ? ` Last background check: ${ago(Date.now() - cfg.lastCheck.at)} (score ${cfg.lastCheck.score}).` : "";
    $("alertStatus").textContent = `On: ${cfg.kind}s at ${cfg.place.name} scoring ${cfg.threshold}+.${last}`;
  } else if (alertSupport() !== "ok" && swReg) {
    $("alertStatus").textContent = "Background alerts need Chrome on Android, with the app installed (menu → Install app). On other phones, use Add to calendar for promising evenings.";
  } else $("alertStatus").textContent = "";
}
$("alertOn").addEventListener("click", async () => {
  const sup = alertSupport();
  if (sup !== "ok") { await renderAlerts(); if (!$("alertStatus").textContent) $("alertStatus").textContent = "Alerts aren't supported on this phone or browser."; return; }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { $("alertStatus").textContent = "Notifications are blocked. Allow them for this app in your phone's settings, then try again."; return; }
  try {
    const st = await navigator.permissions.query({ name: "periodic-background-sync" });
    if (st.state !== "granted") {
      $("alertStatus").textContent = "Install the app first: in Chrome, open the ⋮ menu and choose Install app (or Add to home screen). Then open it from your home screen and turn alerts on.";
      return;
    }
    await swReg.periodicSync.register("wib-alert", { minInterval: 6 * 3600 * 1000 });
  } catch {
    $("alertStatus").textContent = "Your browser didn't allow background checks. Install the app from Chrome's menu, then try again.";
    return;
  }
  const p = state.place, old = await alertConfig();
  await saveAlertConfig({
    enabled: true, kind: state.kind, threshold: Number($("alertThreshold").value),
    place: { name: p.label || p.name, lat: +p.lat.toFixed(4), lon: +p.lon.toFixed(4) },
    notified: (old && old.notified) || [], lastCheck: old && old.lastCheck,
  });
  await renderAlerts();
  $("alertStatus").textContent += " Your phone decides exactly when to check, usually a few times a day.";
});
$("alertOff").addEventListener("click", async () => {
  try { if (swReg && swReg.periodicSync) await swReg.periodicSync.unregister("wib-alert"); } catch { /* ignore */ }
  const cfg = await alertConfig(); if (cfg) { cfg.enabled = false; await saveAlertConfig(cfg); }
  await renderAlerts(); $("alertStatus").textContent = "Alerts are off.";
});
$("alertTest").addEventListener("click", async () => {
  $("alertStatus").textContent = "Checking the forecast…";
  try {
    const r = await swCall({ type: "check-now", force: true });
    $("alertStatus").textContent = r.status === "notified" ? `Test alert sent (score ${r.score}). Check your notifications.`
      : r.status === "fetch-failed" ? "Couldn't reach the forecast. Try again." : `Check finished: ${r.status}.`;
  } catch { $("alertStatus").textContent = "The background worker isn't ready yet. Reload the app and try again."; }
});
$("alertCard").addEventListener("toggle", () => { if ($("alertCard").open) renderAlerts(); });

/* ---------- flow ---------- */
/* forecast cache: a few recent places, so the app opens instantly and works offline */
const FRESH_MS = 15 * 60 * 1000;
const cacheKey = (place, kind) => `${place.lat.toFixed(2)},${place.lon.toFixed(2)},${kind}`;
function cacheGet(key) { return (store.get("wib-cache", []) || []).find(x => x.key === key) || null; }
function cachePut(key, d) {
  const list = (store.get("wib-cache", []) || []).filter(x => x.key !== key);
  list.unshift({ key, at: Date.now(), d });
  store.set("wib-cache", list.slice(0, 4));
}
const ago = ms => { const m = Math.round(ms / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

function showForecast(place, d, at, mode) {
  const events = scoreEvents(d);
  if (!events.length) throw new Error("no-event");
  const keepSel = state.data && state.data.kind === d.kind && state.place === place && !state.past ? state.sel : 0;
  state.data = d; state.events = events; state.sel = Math.min(keepSel, events.length - 1);
  state.past = false; state.live = null; applyPastUi();
  state.updatedAt = at;
  renderPlace(place); renderSaveButton(); renderSelected(); renderRate(); renderLog(); show("result");
  $("nearList").innerHTML = ""; $("nearStatus").textContent = ""; $("nearMap").hidden = true;
  $("offline").hidden = mode !== "offline";
  if (mode === "offline") $("offline").textContent = `Offline · forecast from ${ago(Date.now() - at)}`;
  renderUpdated(mode === "updating");
  if (!state.terrain || state.terrainFor !== `${place.lat},${place.lon},${d.kind}`) {
    state.terrain = null;
    const tag = `${place.lat},${place.lon},${d.kind}`;
    terrainFor(place.lat, place.lon, d.az).then(h => {
      if (state.place !== place || state.data !== d) return;
      state.terrain = h; state.terrainFor = tag; renderSelected();
    }).catch(() => { /* terrain is optional */ });
  }
}
function renderUpdated(updating) {
  $("updated").textContent = updating ? "Updating…" : state.updatedAt ? `Updated ${ago(Date.now() - state.updatedAt)}` : "";
}
setInterval(() => { if (state.updatedAt && !state.past) renderUpdated(false); }, 60000);

async function refresh(force = false) {
  const place = state.place, kind = state.kind, key = cacheKey(place, kind);
  const cached = cacheGet(key);
  const fresh = cached && Date.now() - cached.at < FRESH_MS;
  try {
    if (cached) showForecast(place, cached.d, cached.at, fresh && !force ? "fresh" : "updating");
    else loading(kind === "sunset" ? "Checking the sky…" : "Checking the morning sky…");
  } catch { /* cached data had no upcoming events; fetch instead */ }
  if (fresh && !force) return;
  try {
    const d = await loadForecast(place, kind);
    if (place !== state.place || kind !== state.kind) return;
    cachePut(key, d);
    showForecast(place, d, Date.now(), "live");
  } catch (e) {
    if (place !== state.place || kind !== state.kind) return;
    if (cached) { try { showForecast(place, cached.d, cached.at, "offline"); return; } catch { /* fall through */ } }
    openPicker(e.message === "no-event" ? `There's no ${kind} here in the next week. Try another place.`
      : /429/.test(e.message) ? "The forecast service is busy right now. Try again in a minute."
      : "Couldn't get the forecast. Check your connection, or try another place.");
  }
}
$("refreshBtn").addEventListener("click", () => { if (!state.past) refresh(true); });

async function run(place) {
  state.place = place;
  if (!place.gps) store.set("wib-place", place); else store.set("wib-place", { gps: true });
  renderPlace(place);
  if (place.gps) nameForGps(place);
  await refresh();
}

/** Tidy reverse-geocoding output: "Swansea, Wales, United Kingdom" rather than the full official names. */
function placeDetail(d, name) {
  let country = d.countryName || "";
  try { if (d.countryCode) country = new Intl.DisplayNames(["en"], { type: "region" }).of(d.countryCode) || country; } catch { /* keep the long name */ }
  const clean = t => (t || "").replace(/\s*\[[^\]]*\]/g, "").replace(/ \(the\)$/, "").trim();
  const parts = [d.city && d.city !== name ? d.city : null, clean(d.principalSubdivision), clean(country)].filter(Boolean);
  return [...new Set(parts)].join(", ");
}

async function nameForGps(place) {
  try {
    const d = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${place.lat}&longitude=${place.lon}&localityLanguage=en`);
    const name = d.locality || d.city;
    if (name && state.place === place) {
      place.label = `Near ${name}`;
      place.detail = placeDetail(d, name);
      renderPlace(place);
    }
  } catch { /* coordinates only */ }
}

function openPicker(msg) {
  $("pickerText").textContent = msg || "Where are you watching from?";
  $("results").innerHTML = ""; $("searchErr").hidden = true;
  show("picker");
  renderSpots();
}

function locate() {
  if (!navigator.geolocation) { openPicker("Location isn't available. Search for a place instead."); return; }
  loading("Finding your location…");
  navigator.geolocation.getCurrentPosition(
    p => run({ name: "My location", label: "My location", lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, gps: true }),
    () => openPicker("Couldn't get your location. Search for a place instead."),
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 120000 }
  );
}

$("searchForm").addEventListener("submit", async e => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) { $("searchErr").textContent = "Type a town or place name."; $("searchErr").hidden = false; return; }
  $("searchErr").hidden = true; $("results").innerHTML = "<div class='status'>Searching…</div>";
  try {
    const d = await getJSON("https://geocoding-api.open-meteo.com/v1/search?count=6&language=en&name=" + encodeURIComponent(q));
    const list = d.results || [];
    $("results").innerHTML = "";
    if (!list.length) { $("searchErr").textContent = "No places found. Try another spelling."; $("searchErr").hidden = false; return; }
    for (const p of list) {
      const b = document.createElement("button"); b.type = "button";
      const sub = [p.admin1, p.country].filter(Boolean).join(", ");
      b.innerHTML = `${esc(p.name)}<br><small>${esc(sub)}</small>`;
      b.addEventListener("click", () => run({ name: p.name, label: p.name, detail: sub, lat: p.latitude, lon: p.longitude }));
      $("results").appendChild(b);
    }
  } catch {
    $("results").innerHTML = ""; $("searchErr").textContent = "Search failed. Check your connection."; $("searchErr").hidden = false;
  }
});
$("gpsBtn").addEventListener("click", locate);
$("placeBtn").addEventListener("click", () => openPicker());

/* ---------- logging settings ---------- */
$("logRepo").value = logRepo(); applyLogMode();
$("logRepoSave").addEventListener("click", () => {
  const v = $("logRepo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
  if (v && !/^[\w.-]+\/[\w.-]+$/.test(v)) { $("logRepoMsg").textContent = "Use the form owner/repository, or leave it empty."; return; }
  store.set("wib-log-repo", v); $("logRepo").value = v;
  $("logRepoMsg").textContent = v ? "Saved. Log entries now have a GitHub button." : "GitHub logging is off.";
  applyLogMode(); renderLog(); if (state.data) renderRate();
});

/* ---------- tabs ---------- */
function showTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.hidden = t.dataset.tab !== name);
  document.querySelectorAll(".tabbar button").forEach(b => { b.classList.toggle("on", b.dataset.go === name); b.setAttribute("aria-current", b.dataset.go === name ? "page" : "false"); });
  window.scrollTo(0, 0);
  if (name === "spots") renderMySpots();
  if (name === "log") renderLog();
  if (name === "more") renderAlerts();
}
$("tabbar").addEventListener("click", e => { const b = e.target.closest("button[data-go]"); if (b) showTab(b.dataset.go); });
/* ---------- install to home screen ---------- */
let installPrompt = null;
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const invited = new URLSearchParams(location.search).has("install");
function renderInstall() {
  const can = !standalone() && (installPrompt || isIOS());
  const dismissed = !invited && store.get("wib-install-x", 0) > Date.now() - 14 * 86400000;
  $("installBar").hidden = !can || dismissed;
  $("installBtn2").hidden = !installPrompt || standalone();
  if (isIOS() && !installPrompt) {
    $("installText").innerHTML = "<b>Add Sunscore to your home screen</b><br>Tap Share <span aria-hidden=\"true\">⬆︎</span>, then <b>Add to Home Screen</b>.";
    $("installBtn").hidden = true;
  }
}
async function doInstall() {
  if (!installPrompt) return;
  installPrompt.prompt();
  try { await installPrompt.userChoice; } catch { /* ignore */ }
  installPrompt = null; renderInstall();
}
window.addEventListener("beforeinstallprompt", ev => { ev.preventDefault(); installPrompt = ev; renderInstall(); });
window.addEventListener("appinstalled", () => { installPrompt = null; store.set("wib-installed", true); renderInstall(); });
$("installBtn").addEventListener("click", doInstall);
$("installBtn2").addEventListener("click", doInstall);
$("installX").addEventListener("click", () => { store.set("wib-install-x", Date.now()); $("installBar").hidden = true; });
$("shareApp").addEventListener("click", async () => {
  const url = location.origin + location.pathname.replace(/index\.html$/, "") + "?install=1";
  const text = "Sunscore tells you how good tonight's sunset (or tomorrow's sunrise) will be, 0–100. Open this and add it to your home screen:";
  try {
    if (navigator.share) { await navigator.share({ title: "Sunscore", text, url }); return; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  await copyText(url, $("shareAppMsg"));
  if ($("shareAppMsg").textContent.startsWith("Copied")) $("shareAppMsg").textContent = "Link copied: " + url;
});
renderInstall();

/* developer mode: tap the model version five times */
let devTaps = 0, devTimer = null;
function applyDev() { $("devCard").hidden = !isDev(); }
$("modelVersion").addEventListener("click", () => {
  devTaps++; clearTimeout(devTimer); devTimer = setTimeout(() => { devTaps = 0; }, 1500);
  if (devTaps >= 5) { devTaps = 0; store.set("wib-dev", true); applyDev(); showTab("more"); $("devCard").scrollIntoView({ block: "center" }); }
});
$("devOpen").addEventListener("click", () => showTab("log"));
$("devOff").addEventListener("click", () => { store.set("wib-dev", false); applyDev(); });
$("shareRatings").checked = sharing();
$("shareRatings").addEventListener("change", e => { store.set("wib-share", e.target.checked); if (state.data) renderRate(); if (e.target.checked) shareBacklog(); });
applyDev();
$("howBtn2").addEventListener("click", () => $("how").showModal());
$("newBtn").addEventListener("click", () => $("whatsNew").showModal());

/* ---------- start ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", registerWorker);
}
$("modelVersion").textContent = M.MODEL_VERSION;
setTimeout(shareBacklog, 4000);
$("scaleKey").textContent = M.SCALE_KEY;
$("howBtn").addEventListener("click", () => $("how").showModal());
// "What's new": shown once per release to people who used an earlier version
const RELEASE = "4.5";
(() => {
  const seen = store.get("wib-release");
  const returning = store.get("wib-place") || store.get("wib-kind");
  if (seen !== RELEASE && returning) setTimeout(() => { try { $("whatsNew").showModal(); } catch { /* dialog unsupported */ } }, 1200);
  store.set("wib-release", RELEASE);
})();
try { localStorage.removeItem("wib-last"); } catch { /* old cache format */ }
setKindButtons();
const saved = store.get("wib-place");
if (saved && !saved.gps && saved.lat != null) run(saved); else locate();
