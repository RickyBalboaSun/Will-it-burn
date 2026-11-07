import * as M from "./model.js";

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
  models: null,      // multi-model forecast for confidence
  past: false,       // looking back at a past date
  updatedAt: null,
};

/* ---------- data ---------- */
async function loadForecast(place, kind) {
  const now = Date.now() / 1000;
  const az = M.eventAzimuth(place.lat, M.dayOfYear(now), kind);
  const pts = M.ALL_KM.map(km => M.destination(place.lat, place.lon, az, km));
  const params = new URLSearchParams({
    latitude: pts.map(p => p[0].toFixed(4)).join(","),
    longitude: pts.map(p => p[1].toFixed(4)).join(","),
    hourly: M.VARS.join(","), daily: "sunset,sunrise",
    timezone: "auto", timeformat: "unixtime", forecast_days: "8",
  });
  let data = await getJSON("https://api.open-meteo.com/v1/forecast?" + params);
  if (!Array.isArray(data)) data = [data];
  return { locations: data, az, pts, offset: data[0].utc_offset_seconds || 0, kind };
}

/** Same points, three independent weather models, to judge forecast confidence. */
async function loadModels(d) {
  const params = new URLSearchParams({
    latitude: d.pts.map(p => p[0].toFixed(4)).join(","),
    longitude: d.pts.map(p => p[1].toFixed(4)).join(","),
    hourly: M.VARS.join(","), models: M.CONFIDENCE_MODELS.join(","),
    timezone: "auto", timeformat: "unixtime", forecast_days: "8",
  });
  let data = await getJSON("https://api.open-meteo.com/v1/forecast?" + params, 15000);
  return Array.isArray(data) ? data : [data];
}
const MODEL_NAMES = { ecmwf_ifs025: "European (ECMWF)", gfs_seamless: "American (GFS)", icon_seamless: "German (ICON)" };

/** Score an event time with each weather model. Returns [{model, score}] for models with data. */
function modelScores(locs, t) {
  const out = [];
  for (const m of M.CONFIDENCE_MODELS) {
    const S = M.samplesAt(locs, t, "_" + m);
    if (M.hasData(S)) out.push({ model: m, score: M.scoreSamples(S).score });
  }
  return out;
}

function scoreEvents(d) {
  const now = Date.now() / 1000;
  const times = (d.locations[0].daily[d.kind] || []).filter(t => t != null && t + 20 * 60 > now);
  const out = [];
  for (const t of times) {
    const S = M.samplesAt(d.locations, t);
    if (!M.hasData(S)) continue;
    out.push({ t, ...M.scoreSamples(S) });
    if (out.length >= 7) break;
  }
  return out;
}

/* ---------- rendering ---------- */
function show(which) {
  for (const id of ["loading", "picker", "result"]) $(id).hidden = id !== which;
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
  // high cloud: thin wisps near the top
  const nHigh = Math.round((inp.cHigh || 0) / 100 * 16);
  for (let i = 0; i < nHigh; i++) {
    const y = H * (0.04 + rand() * 0.3), x = rand() * W, w = W * (0.25 + rand() * 0.4), h = 3 + rand() * 6;
    g.save(); g.translate(x, y); g.rotate((rand() - 0.5) * 0.25);
    g.fillStyle = mix("9a9cab", "ffc2b0", lit); g.globalAlpha = 0.18 + 0.3 * rand();
    g.beginPath(); g.ellipse(0, 0, w / 2, h, 0, 0, Math.PI * 2); g.fill(); g.restore();
  }
  // mid cloud: flattened rafts of cloudlets, lit from below (altocumulus-like)
  const nMid = Math.round((inp.cMid || 0) / 100 * 20);
  for (let i = 0; i < nMid; i++) {
    const cx = rand() * W * 1.2 - W * 0.1, cy = H * (0.2 + rand() * 0.42), size = 10 + rand() * 16, n = 4 + Math.floor(rand() * 5);
    for (let k = 0; k < n; k++) {
      const px = cx + (k - n / 2) * size * 1.5 + (rand() - 0.5) * size, py = cy + (rand() - 0.5) * size * 0.6;
      const rx = size * (1.2 + rand() * 0.9), ry = size * (0.38 + rand() * 0.22);
      const cg = g.createLinearGradient(0, py - ry, 0, py + ry);
      cg.addColorStop(0, mix("5e6070", "6b4a78", lit)); cg.addColorStop(0.55, mix("7a7c8a", "c45a7a", lit)); cg.addColorStop(1, mix("8d8f9c", "ff8a66", lit));
      g.fillStyle = cg; g.globalAlpha = 0.5 + 0.2 * rand();
      g.beginPath(); g.ellipse(px, py, rx, ry, (rand() - 0.5) * 0.15, 0, Math.PI * 2); g.fill();
    }
  }
  // low cloud overhead: dark, unlit
  const nLow = Math.round((inp.low || 0) / 100 * 14);
  for (let i = 0; i < nLow; i++) {
    const cx = rand() * W, cy = H * (0.55 + rand() * 0.3), r = 30 + rand() * 40;
    g.fillStyle = "#3a3844"; g.globalAlpha = 0.55;
    g.beginPath(); g.ellipse(cx, cy, r * 1.8, r * 0.7, 0, 0, Math.PI * 2); g.fill();
  }
  // cloud bank on the horizon if the light path is blocked
  const bank = 1 - f.path;
  if (bank > 0.05) {
    g.globalAlpha = 0.85; g.fillStyle = "#34323d";
    for (let x = -20; x < W + 40; x += 34) {
      const r = 26 + rand() * 22;
      g.beginPath(); g.arc(x, horizon - bank * 50 + rand() * 10, r, 0, Math.PI * 2); g.fill();
    }
    g.fillRect(0, horizon - bank * 50, W, H);
  }
  g.globalAlpha = 1;
  // ground
  g.fillStyle = "#14111b"; g.fillRect(0, horizon, W, H - horizon);
  // gentle scrim so text stays readable
  g.fillStyle = "rgba(10,8,16,0.18)"; g.fillRect(0, 0, W, H);
}
addEventListener("resize", () => { clearTimeout(drawSky.t); drawSky.t = setTimeout(drawSky, 150); });

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

  // confidence and map
  renderConfidence();
  drawMap();

  // week strip
  const best = state.events.reduce((b, x, i) => (x.score > state.events[b].score ? i : b), 0);
  $("weekTitle").textContent = kind === "sunset" ? "Sunsets this week" : "Sunrises this week";
  $("week").innerHTML = state.events.map((x, i) => `
    <button class="day ${i === state.sel ? "on" : ""}" data-i="${i}" aria-label="${esc(dayName(x.t, off, kind))}: ${x.score}">
      <span class="d">${esc(shortDay(x.t, off))}</span>
      <span class="s">${x.score}</span>
      <span class="bar" style="background:${scoreColour(x.score)}"></span>
      <span class="best">${i === best && x.score >= 25 ? "Best" : ""}</span>
    </button>`).join("");

  // viewing times
  const v = M.viewingTimes(state.place.lat, state.place.lon, e.t, kind);
  const rows = kind === "sunset"
    ? [["Golden hour begins", v.golden], ["Sunset", e.t, true], ["Best colour", null, true, `${clock(v.peakStart, off)}–${clock(v.peakEnd, off)}`], ["Afterglow fades", v.civil]]
    : [["First light", v.civil], ["Best colour", null, true, `${clock(v.peakStart, off)}–${clock(v.peakEnd, off)}`], ["Sunrise", e.t, true], ["Golden hour ends", v.golden]];
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
  const ms = state.models ? modelScores(state.models, e.t) : [];
  const c = M.confidenceFrom(ms.map(x => x.score));
  el.hidden = !c;
  $("confDetail").hidden = !c;
  if (!c) return;
  const col = { High: "#7ee08a", Medium: "#ffd166", Low: "#ff8a7a" }[c.level];
  const range = c.min === c.max ? `${c.min}` : `${c.min}–${c.max}`;
  el.innerHTML = `<span class="dot" style="background:${col}"></span>${c.level} confidence · models say ${range}`;
  $("confDetail").innerHTML = `<b>Forecast confidence: ${c.level}.</b> ` +
    ms.map(x => `${MODEL_NAMES[x.model]} ${x.score}`).join(" · ") +
    `. ${c.level === "High" ? "The weather models agree, so the forecast is more trustworthy."
      : c.level === "Medium" ? "The models partly disagree. Check again nearer the time."
      : "The models disagree a lot. Treat this score as a rough guess and check again later."}`;
}
$("conf").addEventListener("click", () => { $("details").open = true; $("details").scrollIntoView({ behavior: "smooth", block: "start" }); });

/* ---------- light path map ---------- */
let leafletReady = null, map = null, mapLayer = null;
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
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      maxZoom: 18, subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
  }
  if (mapLayer) mapLayer.remove();
  mapLayer = L.layerGroup().addTo(map);
  const end = M.destination(p.lat, p.lon, d.az, 300);
  L.polyline([[p.lat, p.lon], end], { color: "#ffb36b", weight: 3, opacity: 0.8, dashArray: "6 6" }).addTo(mapLayer);
  M.ALL_KM.forEach((km, i) => {
    const [la, lo] = d.pts[i];
    const low = M.valueAt(d.locations[i], "cloud_cover_low", e.t), mid = M.valueAt(d.locations[i], "cloud_cover_mid", e.t), high = M.valueAt(d.locations[i], "cloud_cover_high", e.t);
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
const RUBRIC = n => n == null ? "Tap a number. Rate what you saw, not the photo."
  : n <= 2 ? "Grey or no visible colour"
  : n <= 4 ? "A coloured band on the horizon only"
  : n <= 6 ? "Some clouds lit up, colour in part of the sky"
  : n <= 8 ? "Strong colour across much of the sky"
  : "Exceptional: the whole sky lit up";
const logAll = () => store.get("wib-log", []);
const isoDay = (unix, off) => { const d = localDate(unix, off); return d.toISOString().slice(0, 10); };
const entryId = (kind, t, off, place) => `${kind}-${isoDay(t, off)}-${place.lat.toFixed(3)},${place.lon.toFixed(3)}`;

/** The sunset/sunrise that has just happened (within the last 16 hours), scored. */
function recentEvent(d) {
  const now = Date.now() / 1000;
  const times = (d.locations[0].daily[d.kind] || []).filter(t => t != null && t <= now + 10 * 60 && t >= now - 16 * 3600);
  if (!times.length) return null;
  const t = Math.max(...times);
  const S = M.samplesAt(d.locations, t);
  return M.hasData(S) ? { t, ...M.scoreSamples(S) } : null;
}

let rateSel = null, rateEvent = null;
function renderRate() {
  const d = state.data, e = state.past ? state.events[0] : recentEvent(d);
  rateEvent = e;
  $("rateCard").hidden = !e;
  if (!e) return;
  const off = d.offset, word = d.kind;
  const id = entryId(d.kind, e.t, off, state.place);
  const existing = logAll().find(x => x.id === id);
  rateSel = existing ? existing.rating : null;
  const dn = dayName(e.t, off, d.kind);
  $("rateTitle").textContent = dn === "Tonight" || dn === "Today" ? `How was ${dn.toLowerCase()}'s ${word}?` : `How was the ${word} on ${dn}?`;
  $("rateSub").textContent = `The app ${state.past ? "would have predicted" : "predicted"} ${e.score}/100 for the ${word} at ${clock(e.t, off)}. Your rating helps tune the model.`;
  $("rateNotes").value = existing ? existing.notes : "";
  $("rateCopy").hidden = !existing;
  $("rateSave").textContent = existing ? "Update rating" : "Save rating";
  $("rateMsg").textContent = existing ? "Saved on this phone." : "";
  drawScale();
}
function drawScale() {
  $("scale").innerHTML = Array.from({ length: 11 }, (_, n) =>
    `<button role="radio" aria-checked="${rateSel === n}" class="${rateSel === n ? "on" : ""}" data-n="${n}">${n}</button>`).join("");
  $("rubric").textContent = RUBRIC(rateSel);
}
$("scale").addEventListener("click", ev => {
  const b = ev.target.closest("button"); if (!b) return;
  rateSel = Number(b.dataset.n); drawScale();
});
$("rateSave").addEventListener("click", () => {
  if (rateSel == null) { $("rateMsg").textContent = "Tap a number from 0 to 10 first."; return; }
  const d = state.data, e = rateEvent, p = state.place;
  const entry = {
    id: entryId(d.kind, e.t, d.offset, p), kind: d.kind, t: e.t, offset: d.offset,
    place: { name: p.label || p.name, detail: p.detail || "", lat: +p.lat.toFixed(4), lon: +p.lon.toFixed(4) },
    facing: Math.round(d.az), predicted: e.score, model: M.MODEL_VERSION,
    inputs: Object.fromEntries(Object.entries(e.inputs).map(([k, v]) => [k, v == null ? null : Math.round(v)])),
    rating: rateSel, notes: $("rateNotes").value.trim(), savedAt: Date.now(),
  };
  const log = logAll().filter(x => x.id !== entry.id);
  log.push(entry); log.sort((a, b) => b.t - a.t);
  store.set("wib-log", log);
  $("rateMsg").textContent = "Saved on this phone. Tap Copy for Claude, then paste it to Claude with your photo.";
  $("rateCopy").hidden = false; $("rateSave").textContent = "Update rating";
  renderLog();
});

function entryText(x) {
  const word = x.kind === "sunset" ? "Sunset" : "Sunrise";
  const lines = [
    `${word} ${isoDay(x.t, x.offset)} at ${clock(x.t, x.offset)}`,
    `Place: ${x.place.name}${x.place.detail ? ", " + x.place.detail : ""} (${x.place.lat}, ${x.place.lon})`,
    `Facing: ${M.compass(x.facing)} (${x.facing}°)`,
    `App score: ${x.predicted}/100 (model ${x.model})`,
    `My rating: ${x.rating}/10`,
  ];
  if (x.notes) lines.push(`Notes: ${x.notes}`);
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
  if (e) copyText("Will It Burn log entry\n" + entryText(e), $("rateMsg"));
});

function renderLog() {
  const log = logAll();
  $("logCard").hidden = !log.length;
  $("logCount").textContent = log.length ? `(${log.length})` : "";
  $("logList").innerHTML = log.map(x => `
    <div class="log-item">
      <div>${esc(x.place.name)}<div class="lp">${x.kind === "sunset" ? "Sunset" : "Sunrise"} · ${esc(isoDay(x.t, x.offset))}${x.notes ? " · " + esc(x.notes.slice(0, 60)) : ""}</div></div>
      <div class="lr">You ${x.rating}/10<div class="lp">App ${x.predicted}</div></div>
      <button class="del" data-id="${esc(x.id)}">Delete</button>
    </div>`).join("");
}
$("logList").addEventListener("click", ev => {
  const b = ev.target.closest(".del"); if (!b) return;
  store.set("wib-log", logAll().filter(x => x.id !== b.dataset.id));
  renderLog(); if (state.data) renderRate();
});
$("logCopyAll").addEventListener("click", () => {
  const log = logAll();
  copyText(`Will It Burn log: ${log.length} entr${log.length === 1 ? "y" : "ies"}\n\n` + log.map(entryText).join("\n\n"), $("logMsg"));
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
    hourly: M.VARS.join(","), daily: "sunset,sunrise", timezone: "auto", timeformat: "unixtime",
    forecast_days: String(Math.min(8, Math.max(2, daysAhead))),
  });
  let data = await getJSON("https://api.open-meteo.com/v1/forecast?" + params, 20000);
  if (!Array.isArray(data)) data = [data];
  const n = M.ALL_KM.length;
  return spots.map((sp, i) => {
    const locs = data.slice(i * n, i * n + n);
    let when = t;
    if (when == null) when = (locs[0].daily[kind] || []).find(x => x != null && x + 20 * 60 > now);
    if (when == null) return { ...sp, score: null };
    const S = M.samplesAt(locs, when);
    return M.hasData(S) ? { ...sp, t: when, offset: locs[0].utc_offset_seconds || 0, ...M.scoreSamples(S) } : { ...sp, score: null };
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
  const p = state.place, e = state.events[state.sel], d = state.data;
  const R = nearRadius, cands = [{ lat: p.lat, lon: p.lon, dist: 0, dir: "" }];
  for (const [ring, n] of [[R / 2, 8], [R, 8]]) {
    for (let k = 0; k < n; k++) {
      const brg = k * 360 / n + (ring === R ? 22.5 : 0);
      const [la, lo] = M.destination(p.lat, p.lon, brg, ring);
      cands.push({ lat: la, lon: lo, dist: Math.round(ring), dir: M.compass(brg) });
    }
  }
  $("scanBtn").disabled = true; $("nearStatus").textContent = `Scanning ${cands.length} places…`; $("nearList").innerHTML = "";
  try {
    const scored = (await scoreSpots(cands, d.kind, e.t)).filter(x => x.score != null);
    const here = scored.find(x => x.dist === 0);
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    $("nearStatus").innerHTML = !here ? "" : best.dist === 0 || best.score - here.score < 8
      ? `<b>You're already in a good spot.</b> Nowhere within ${R} km scores clearly better than here (${here.score}).`
      : `<b>${best.dist} km ${best.dir} looks better:</b> ${best.score} vs ${here.score} here.`;
    $("nearList").innerHTML = scored.slice(0, 6).map(x => `
      <button class="near-item" data-lat="${x.lat}" data-lon="${x.lon}" data-name="${x.dist ? `${x.dist} km ${x.dir}` : "Here"}">
        <span>${x.dist ? `${x.dist} km ${x.dir}` : "Where you are"}<br><small>${x.verdict}${x.dist ? " · tap to check it" : ""}</small></span>
        <span class="ns" style="color:${scoreColour(x.score)}">${x.score}</span>
      </button>`).join("") + `<div class="note">This only knows about the sky. Check the spot has an open view ${M.compass(d.az)}, with no hills, trees or buildings in the way.</div>`;
    drawNearMap(scored, p);
  } catch {
    $("nearStatus").textContent = "Couldn't scan right now. Try again in a minute.";
  } finally { $("scanBtn").disabled = false; }
});
$("nearList").addEventListener("click", ev => {
  const b = ev.target.closest(".near-item"); if (!b || b.dataset.name === "Here") return;
  const base = state.place.label || state.place.name;
  run({ name: `${b.dataset.name} of ${base}`, label: `${b.dataset.name} of ${base}`, detail: "", lat: Number(b.dataset.lat), lon: Number(b.dataset.lon) });
  window.scrollTo({ top: 0, behavior: "smooth" });
});
async function drawNearMap(scored, p) {
  let L; try { L = await loadLeaflet(); } catch { return; }
  $("nearMap").hidden = false;
  if (!nearMap) {
    nearMap = L.map("nearMap", { zoomControl: false });
    L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", { maxZoom: 18, subdomains: "abcd",
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>' }).addTo(nearMap);
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
    hourly: M.VARS.join(","), daily: "sunset,sunrise", timezone: "auto", timeformat: "unixtime",
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
  const t = (data[0].daily[kind] || [])[0];
  if (t == null) throw new Error("no-event");
  const S = M.samplesAt(data, t);
  if (!M.hasData(S)) throw new Error("no-data");
  return { d, e: { t, ...M.scoreSamples(S) } };
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
    state.live = state.live || { data: state.data, events: state.events, models: state.models, sel: state.sel };
    state.past = true; state.data = d; state.events = [e]; state.sel = 0; state.models = null;
    $("pastStatus").textContent = ""; $("pastCard").open = false;
    applyPastUi(); renderSelected(); renderRate();
    window.scrollTo({ top: 0, behavior: "smooth" });
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
  g.font = `700 52px ${serif}`; g.fillText("Will It Burn?", W / 2, 130);
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
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], text, title: "Will It Burn?" }); return; }
    if (navigator.share) { await navigator.share({ text, url, title: "Will It Burn?" }); return; }
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
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Will It Burn//EN", "BEGIN:VEVENT",
    `UID:${entryId(d.kind, e.t, d.offset, p)}@will-it-burn`, `DTSTAMP:${icsDate(Date.now() / 1000)}`,
    `DTSTART:${icsDate(start)}`, `DTEND:${icsDate(end)}`,
    `SUMMARY:${word} ${e.score}/100 – ${e.verdict.replace(/[,;]/g, "")}`,
    `LOCATION:${(p.label || p.name).replace(/[,;]/g, " ")}`, `GEO:${p.lat.toFixed(4)};${p.lon.toFixed(4)}`,
    `DESCRIPTION:${word} at ${clock(e.t, d.offset)}. Face ${M.compass(d.az)}. Forecast score ${e.score}/100 – check again nearer the time: ${location.href.split("#")[0]}`,
    "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", `DESCRIPTION:${word} soon`, "END:VALARM",
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
  state.models = null; state.past = false; state.live = null; applyPastUi();
  state.updatedAt = at;
  renderPlace(place); renderSaveButton(); renderSelected(); renderRate(); renderLog(); show("result");
  $("nearList").innerHTML = ""; $("nearStatus").textContent = ""; $("nearMap").hidden = true;
  $("offline").hidden = mode !== "offline";
  if (mode === "offline") $("offline").textContent = `Offline · forecast from ${ago(Date.now() - at)}`;
  renderUpdated(mode === "updating");
  if (mode !== "offline") loadModels(d).then(m => {
    if (state.data !== d) return;
    state.models = m; renderConfidence();
  }).catch(() => { /* confidence is optional */ });
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

async function nameForGps(place) {
  try {
    const d = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${place.lat}&longitude=${place.lon}&localityLanguage=en`);
    const name = d.locality || d.city;
    if (name && state.place === place) {
      place.label = `Near ${name}`;
      place.detail = [d.city && d.city !== name ? d.city : null, d.principalSubdivision, (d.countryName || "").replace(/ \(the\)$/, "")].filter(Boolean).join(", ");
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

/* ---------- start ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
$("modelVersion").textContent = M.MODEL_VERSION;
try { localStorage.removeItem("wib-last"); } catch { /* old cache format */ }
setKindButtons();
const saved = store.get("wib-place");
if (saved && !saved.gps && saved.lat != null) run(saved); else locate();
