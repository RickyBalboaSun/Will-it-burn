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
function clock(unix, off) {
  const d = localDate(unix, off);
  let h = d.getUTCHours(); const m = String(d.getUTCMinutes()).padStart(2, "0");
  const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
  return `${h}:${m}${ap}`;
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

function paintSky(t) {
  const top = mix("2b2d38", "2a1846", t), mid = mix("4b4e5c", "b8336a", t), low = mix("6e707b", "ff7a2f", t);
  $("sky").style.background = `linear-gradient(180deg, ${top} 0%, ${mid} 55%, ${low} 100%)`;
  document.querySelector('meta[name="theme-color"]').content = top;
}

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
  paintSky(e.score / 100);
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

/* ---------- flow ---------- */
async function refresh() {
  const place = state.place;
  loading(state.kind === "sunset" ? "Checking the sky…" : "Checking the morning sky…");
  try {
    let d, offlineAt = null;
    const key = `${place.lat.toFixed(3)},${place.lon.toFixed(3)},${state.kind}`;
    try {
      d = await loadForecast(place, state.kind);
      store.set("wib-last", { key, at: Date.now(), d });
    } catch (err) {
      const last = store.get("wib-last");
      if (!last || last.key !== key) throw err;
      d = last.d; offlineAt = last.at;
    }
    if (place !== state.place) return;
    const events = scoreEvents(d);
    if (!events.length) throw new Error("no-event");
    state.data = d; state.events = events; state.sel = 0;
    renderPlace(place); renderSelected(); show("result");
    $("offline").hidden = !offlineAt;
    if (offlineAt) {
      const t = new Date(offlineAt);
      $("offline").textContent = `Offline · forecast from ${t.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
    }
  } catch (e) {
    openPicker(e.message === "no-event"
      ? `There's no ${state.kind} here in the next week. Try another place.`
      : "Couldn't get the forecast. Check your connection, or try another place.");
  }
}

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
setKindButtons();
const saved = store.get("wib-place");
if (saved && !saved.gps && saved.lat != null) run(saved); else locate();
