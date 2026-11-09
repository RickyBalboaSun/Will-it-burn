// Will It Burn? – scoring model and astronomy helpers.
// Pure functions only (no DOM, no network) so they can be tested in Node.
// The scoring must stay identical to model/logic.py in the private data repo;
// tests/parity.test.mjs checks this against fixtures generated from the Python.

export const MODEL_VERSION = "1.2.0";

// Three independent weather models; the headline score is their median (scoreModels).
export const WEATHER_MODELS = ["ecmwf_ifs025", "gfs_seamless", "icon_seamless"];

export const CANVAS_KM = [0, 25];          // cloud here is what lights up
export const PATH_KM = [75, 150, 250];     // cloud here blocks the low sun
export const ALL_KM = [...CANVAS_KM, ...PATH_KM];
export const VARS = [
  "cloud_cover", "cloud_cover_low", "cloud_cover_mid", "cloud_cover_high",
  "visibility", "relative_humidity_2m", "precipitation_probability", "precipitation",
];

/* ---------- smooth scoring helpers (all return 0..1) ---------- */
export const band = (x, lo0, lo1, hi1, hi0) => {
  if (x == null || x <= lo0 || x >= hi0) return 0;
  if (x >= lo1 && x <= hi1) return 1;
  return x < lo1 ? (x - lo0) / (lo1 - lo0) : (hi0 - x) / (hi0 - hi1);
};
export const rampDown = (x, a, b) => (x == null || x <= a) ? 1 : x >= b ? 0 : 1 - (x - a) / (b - a);
export const rampUp = (x, a, b) => 1 - rampDown(x, a, b);
export const lerp = (a, b, f) => a + (b - a) * f;
export const mean = xs => {
  const v = xs.filter(x => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** Plain-English verdict. Mirrors verdict_for() in logic.py. */
export function verdictFor(score, f = null) {
  if (score >= 75) return "Fire in the sky!";
  if (score >= 50) return "Potentially good";
  if (f && f.canvas < 0.15 && f.path >= 0.8 && f.overcast >= 0.9 && f.local >= 0.9) return "Clear: simple glow";
  if (score >= 25) return "Some colour possible";
  return "Not looking good";
}

/** One-line key for the 0–100 scale. */
export const SCALE_KEY = "Under 25 poor · 25+ some colour · 50+ good · 75+ fire";

/**
 * Score one event. S maps distance_km -> { variable: value at the event time }.
 * Mirrors score_conditions() in logic.py.
 */
export function scoreSamples(S) {
  const obs = S[0];
  const cMid = mean(CANVAS_KM.map(d => S[d].cloud_cover_mid));
  const cHigh = mean(CANVAS_KM.map(d => S[d].cloud_cover_high));
  const canvas = Math.min(1, 0.65 * band(cMid, 5, 30, 70, 90) + 0.45 * band(cHigh, 10, 25, 80, 95));
  const base = lerp(0.25, 1, canvas);

  const blocks = PATH_KM.map(d => Math.min(100, (S[d].cloud_cover_low || 0) + 0.5 * (S[d].cloud_cover_mid || 0)));
  const path = rampDown(mean(blocks), 15, 75);

  const local = lerp(0.3, 1, rampDown(obs.cloud_cover_low, 20, 80));
  const overcast = lerp(0.2, 1, rampDown(obs.cloud_cover, 85, 100));

  let pp = obs.precipitation_probability;
  if (pp == null && obs.precipitation != null) pp = Math.min(100, obs.precipitation * 200);
  const rain = 1 - 0.6 * ((pp || 0) / 100);

  const visKm = obs.visibility != null ? obs.visibility / 1000 : null;
  const visF = visKm != null ? lerp(0.5, 1, rampUp(visKm, 5, 25)) : 1;
  const humF = lerp(0.85, 1, band(obs.relative_humidity_2m, 15, 35, 70, 95));
  const clarity = visF * humF;

  const raw = 100 * base * path * local * overcast * rain * clarity;
  const score = Math.round(Math.max(0, Math.min(100, raw)));
  return {
    score,
    raw,
    verdict: verdictFor(score, { canvas, path, local, overcast }),
    factors: { canvas, path, local, overcast, rain, clarity },
    inputs: {
      cMid, cHigh,
      pathLow: mean(PATH_KM.map(d => S[d].cloud_cover_low)),
      pathMid: mean(PATH_KM.map(d => S[d].cloud_cover_mid)),
      low: obs.cloud_cover_low, total: obs.cloud_cover,
      rainP: pp, visKm, hum: obs.relative_humidity_2m,
    },
  };
}

/* ---------- geometry ---------- */
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

/** Approximate bearing of the rising or setting sun (degrees from north). Matches logic.py for sunsets. */
export function eventAzimuth(lat, dayOfYear, kind = "sunset") {
  const decl = rad(23.44) * Math.sin(rad(360 / 365 * (dayOfYear - 81)));
  const c = Math.max(-1, Math.min(1, Math.sin(decl) / Math.cos(rad(lat))));
  const a = deg(Math.acos(c));
  return kind === "sunrise" ? a : 360 - a;
}

/** Great-circle destination point. */
export function destination(lat, lon, bearingDeg, km) {
  if (!km) return [lat, lon];
  const R = 6371, p1 = rad(lat), l1 = rad(lon), th = rad(bearingDeg), d = km / R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(p2), ((deg(l2) + 540) % 360) - 180];
}

export function dayOfYear(unix) {
  const d = new Date(unix * 1000);
  return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
}

export const compass = a =>
  ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(((a % 360) + 360) % 360 / 45) % 8];

/* ---------- forecast data ---------- */
/** Linearly interpolate an hourly variable to unix time t. Returns null if t is outside the data. */
export function valueAt(loc, v, t) {
  const times = loc.hourly.time, vals = loc.hourly[v];
  if (!vals) return null;
  for (let i = 0; i < times.length - 1; i++) {
    if (times[i] <= t && t <= times[i + 1]) {
      const a = vals[i], b = vals[i + 1];
      if (a == null || b == null) return a == null ? b : a;
      return a + (b - a) * (t - times[i]) / (times[i + 1] - times[i]);
    }
  }
  return null;
}

/** Sample every location at time t. locations[i] corresponds to ALL_KM[i]. */
export function samplesAt(locations, t, suffix = "") {
  const S = {};
  ALL_KM.forEach((km, i) => {
    S[km] = {};
    for (const v of VARS) S[km][v] = valueAt(locations[i], v + suffix, t);
  });
  return S;
}

/** True if the forecast has cloud data at this time for every location. */
export function hasData(S) {
  return ALL_KM.every(km => S[km].cloud_cover_mid != null && S[km].cloud_cover_low != null);
}

/* ---------- sun position (NOAA algorithm) ---------- */
export function solarPosition(lat, lon, unix) {
  const jd = unix / 86400 + 2440587.5;
  const T = (jd - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(rad(M)) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * T) + Math.sin(rad(3 * M)) * 0.000289;
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));
  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
  const y = Math.tan(rad(eps / 2)) ** 2;
  const eqTime = 4 * deg(y * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M))
    + 4 * e * y * Math.sin(rad(M)) * Math.cos(2 * rad(L0))
    - 0.5 * y * y * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * rad(M)));
  const minutesUtc = ((unix % 86400) + 86400) % 86400 / 60;
  const trueSolarTime = ((minutesUtc + eqTime + 4 * lon) % 1440 + 1440) % 1440;
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;
  const cosZen = Math.sin(rad(lat)) * Math.sin(rad(decl)) + Math.cos(rad(lat)) * Math.cos(rad(decl)) * Math.cos(rad(hourAngle));
  const zenith = deg(Math.acos(Math.max(-1, Math.min(1, cosZen))));
  const azDenom = Math.cos(rad(lat)) * Math.sin(rad(zenith));
  let azimuth;
  if (Math.abs(azDenom) > 1e-6) {
    let a = (Math.sin(rad(lat)) * Math.cos(rad(zenith)) - Math.sin(rad(decl))) / azDenom;
    a = Math.max(-1, Math.min(1, a));
    azimuth = 180 - deg(Math.acos(a));
    if (hourAngle > 0) azimuth = -azimuth;
    azimuth = (azimuth + 360) % 360;
  } else azimuth = lat > 0 ? 180 : 0;
  return { elevation: 90 - zenith, azimuth };
}

/** Time in [t0, t1] when the sun's elevation crosses `target` degrees (bisection), or null. */
export function crossingTime(lat, lon, t0, t1, target) {
  let f0 = solarPosition(lat, lon, t0).elevation - target;
  const f1 = solarPosition(lat, lon, t1).elevation - target;
  if (f0 * f1 > 0) return null;
  for (let i = 0; i < 40; i++) {
    const tm = (t0 + t1) / 2, fm = solarPosition(lat, lon, tm).elevation - target;
    if (f0 * fm <= 0) t1 = tm; else { t0 = tm; f0 = fm; }
  }
  return Math.round((t0 + t1) / 2);
}

/**
 * Useful times around a sunset or sunrise.
 * golden: when the sun is 6° above the horizon (start of golden hour before sunset / end after sunrise)
 * civil: when the sun is 6° below (end of the afterglow at dusk / start of colour at dawn)
 * peak: the window when sky colour usually peaks
 */
export function viewingTimes(lat, lon, eventUnix, kind = "sunset") {
  const H = 3 * 3600;
  if (kind === "sunset") {
    return {
      golden: crossingTime(lat, lon, eventUnix - H, eventUnix, 6),
      civil: crossingTime(lat, lon, eventUnix, eventUnix + H, -6),
      peakStart: eventUnix + 5 * 60, peakEnd: eventUnix + 20 * 60,
    };
  }
  return {
    civil: crossingTime(lat, lon, eventUnix - H, eventUnix, -6),
    golden: crossingTime(lat, lon, eventUnix, eventUnix + H, 6),
    peakStart: eventUnix - 20 * 60, peakEnd: eventUnix - 5 * 60,
  };
}

/* ---------- multi-model scoring ---------- */
export const CONFIDENCE_MODELS = WEATHER_MODELS;

/**
 * Event times (sunset or sunrise) from a daily block. With several models,
 * Open-Meteo suffixes daily keys (sunset_ecmwf_ifs025...), so take the first present.
 */
export function eventTimes(daily, kind) {
  if (daily[kind]) return daily[kind];
  for (const m of WEATHER_MODELS) if (daily[`${kind}_${m}`]) return daily[`${kind}_${m}`];
  return [];
}

/**
 * Score time t with each weather model and return the median model's result,
 * plus `model` (whose breakdown is shown) and `modelScores`. Mirrors score_models() in logic.py.
 * Lower median when only two models have data; null if none do.
 */
export function scoreModels(locations, t) {
  const res = [];
  for (const m of WEATHER_MODELS) {
    const S = samplesAt(locations, t, "_" + m);
    if (hasData(S)) res.push({ model: m, r: scoreSamples(S) });
  }
  if (!res.length) return null;
  res.sort((a, b) => a.r.score - b.r.score);
  const mid = res[Math.floor((res.length - 1) / 2)];
  return { ...mid.r, t, model: mid.model, modelScores: res.map(x => ({ model: x.model, score: x.r.score })) };
}

/** Summarise how much weather models disagree. scores: array of numbers. */
export function confidenceFrom(scores) {
  const v = scores.filter(s => s != null);
  if (v.length < 2) return null;
  const spread = Math.max(...v) - Math.min(...v);
  const level = spread <= 15 ? "High" : spread <= 30 ? "Medium" : "Low";
  return { level, spread, min: Math.min(...v), max: Math.max(...v), n: v.length };
}

/**
 * Things worth looking for, given the forecast. Returns up to 4 short tips.
 * e: scored event (from scoreSamples); kind: "sunset" | "sunrise"; az: bearing of the sun.
 */
export function lookFor(e, kind, az) {
  const f = e.factors, i = e.inputs, tips = [];
  const opposite = compass(az + 180), towards = compass(az);
  const after = kind === "sunset" ? "after sunset" : "before sunrise";
  if (f.canvas >= 0.6 && f.path >= 0.6)
    tips.push({ t: "Underlit clouds", d: `The clouds overhead should light up from below. The strongest colour usually comes 5–15 minutes ${after}, so stay put.` });
  if ((i.cHigh || 0) >= 25 && f.path >= 0.5)
    tips.push({ t: "High wisps catch it last", d: `High, wispy cirrus stays lit longest. Watch it turn pink and then violet well ${after}.` });
  if (f.canvas < 0.3 && f.path >= 0.7 && f.overcast >= 0.9)
    tips.push({ t: "Belt of Venus", d: `With a clear sky, turn round and look ${opposite} just ${after}: a pink band sits above the blue-grey shadow of the Earth.` });
  if (((i.low || 0) >= 20 && (i.low || 0) <= 70) || ((i.pathLow || 0) >= 20 && (i.pathLow || 0) <= 60))
    tips.push({ t: "Sunbeams", d: `Broken low cloud can split the light into rays (crepuscular rays) fanning out from the ${towards} horizon.` });
  if ((i.rainP || 0) >= 30 && f.path >= 0.5)
    tips.push({ t: "Rainbow chance", d: `Showers about with a low sun: turn your back to the sun and look ${opposite} for a rainbow.` });
  if (i.visKm != null && i.visKm < 12)
    tips.push({ t: "Red sun disc", d: `Hazy air dims the colours but turns the sun itself deep red near the horizon. A zoom lens makes the most of it.` });
  if (f.path < 0.4)
    tips.push({ t: "Watch for a gap", d: `Cloud on the ${towards} horizon may block the sun. If a gap opens, it can flare up for a few minutes, so keep an eye on it.` });
  if (!tips.length)
    tips.push({ t: "Simple and clean", d: `Expect a clean glow on the ${towards} horizon. Good for silhouettes: put something interesting against the bright sky.` });
  return tips.slice(0, 4);
}

/**
 * Should a background check send an alert?
 * cfg: { threshold, notified: [eventIds] }; e: scored event {t, score}; now/offset in seconds.
 * Alerts only for an event later today (place's local time), from 08:00 local until 30 min before it, once per event.
 */
export function shouldAlert(cfg, e, now, offset, id) {
  if (!e || e.score == null || e.score < cfg.threshold) return false;
  if ((cfg.notified || []).includes(id)) return false;
  const localHour = new Date((now + offset) * 1000).getUTCHours();
  const sameDay = Math.floor((now + offset) / 86400) === Math.floor((e.t + offset) / 86400);
  const kindMorning = new Date((e.t + offset) * 1000).getUTCHours() < 12;
  if (kindMorning) {
    // sunrise: alert the evening before (18:00-23:00) for tomorrow morning's event
    const tomorrow = Math.floor((e.t + offset) / 86400) - Math.floor((now + offset) / 86400) === 1;
    return tomorrow && localHour >= 18 && localHour <= 23;
  }
  return sameDay && localHour >= 8 && e.t - now >= 30 * 60;
}

/** Great-circle distance in km. */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const humanGap = mins => { const a = Math.abs(Math.round(mins)); return a < 90 ? `${a} min` : `${(a / 60).toFixed(a < 600 ? 1 : 0)} h`; };
const humanDist = km => km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(km < 10 ? 1 : 0)} km`;

/**
 * How trustworthy is a rating? Compares where/when it was made with the spot and the event.
 * pos: {lat, lon, accuracy} or null; nowSec, eventSec in unix seconds.
 */
export function verification(spot, pos, nowSec, eventSec, kind = "sunset") {
  const mins = (nowSec - eventSec) / 60, word = kind;
  const when = mins >= 0 ? `${humanGap(mins)} after ${word}` : `${humanGap(mins)} before ${word}`;
  if (!pos) return { onLocation: false, text: `rated ${when} (location not available)` };
  const km = distanceKm(spot.lat, spot.lon, pos.lat, pos.lon);
  const near = km <= 0.5 + Math.min(1, (pos.accuracy || 0) / 1000);
  const fresh = mins >= -30 && mins <= 3 * 60;
  return {
    onLocation: near && fresh,
    text: near ? `rated on location (${humanDist(km)} from the spot), ${when}` : `rated ${humanDist(km)} from the spot, ${when}`,
  };
}

/** Describe photo metadata relative to the spot and event. meta: {takenUnix, lat, lon} (any may be missing). */
export function photoCheck(spot, meta, eventSec, offset, kind = "sunset") {
  if (!meta || (meta.takenUnix == null && meta.lat == null)) return "photo has no time or location data";
  const parts = [];
  if (meta.takenUnix != null) {
    const d = new Date((meta.takenUnix + offset) * 1000);
    const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const mins = (meta.takenUnix - eventSec) / 60;
    parts.push(Math.abs(mins) > 24 * 60 ? `photo taken on a different day (${d.toISOString().slice(0, 10)})`
      : `photo taken ${hhmm} (${humanGap(mins)} ${mins >= 0 ? "after" : "before"} ${kind})`);
  } else parts.push("photo has no time");
  if (meta.lat != null && meta.lon != null) parts.push(`${humanDist(distanceKm(spot.lat, spot.lon, meta.lat, meta.lon))} from the spot`);
  else parts.push("no location in the photo");
  return parts.join(", ");
}

/** The GitHub issue body that the data repo's ingest job parses. */
export function logIssueBody(x, clockText) {
  const lines = [
    "Rated in the Sunscore app.", "", "<!-- will-it-burn-log v1 -->",
    `kind: ${x.kind}`, `date: ${x.date}`, `time_local: ${clockText}`,
    `place: ${x.place.name}`, `detail: ${x.place.detail || ""}`, `lat: ${x.place.lat}`, `lon: ${x.place.lon}`,
    `facing: ${x.facing}`, `app_score: ${x.predicted}`, `model: ${x.model}`, `rating: ${x.rating}`,
    `notes: ${(x.notes || "").replace(/\s+/g, " ")}`, `rated_at: ${new Date(x.savedAt).toISOString().slice(0, 16)}Z`,
    `verification: ${x.verification || ""}`, `photo_meta: ${x.photoMeta || ""}`, "<!-- end -->", "",
    "**Attach your photo below this line** (drag it in, or tap the paperclip), then submit.", "",
  ];
  return lines.join("\n");
}

/* ---------- terrain: how high is the real horizon towards the sun? ---------- */
/** Distances (km) sampled along the sun's bearing; dense close in, where hills matter most. */
export const TERRAIN_KM = [0, 0.15, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6.5, 8, 10, 12.5, 15, 20, 25, 30, 40, 50, 65, 80];

/**
 * Horizon angle from ground heights along the bearing.
 * heights[i] is the elevation (m) at TERRAIN_KM[i]; heights[0] is where you stand.
 * Includes Earth's curvature and standard refraction (k = 0.13). Eye height 1.7 m.
 * Returns {angle (deg), atKm, rise (m above you)} for the highest obstruction.
 */
export function horizonAngle(heights, kms = TERRAIN_KM, eye = 1.7) {
  // Terrain cells are ~90 m across, so a viewpoint on a cliff edge can sit in a cell that averages part of the drop.
  // Treat you as at least as high as the ground 150 m towards the sun, and ignore anything closer than 300 m.
  const R = 6371000, k = 0.13, h0 = Math.max(heights[0], kms[1] <= 0.15 && heights[1] != null ? heights[1] : -Infinity) + eye;
  let best = { angle: -Infinity, atKm: null, rise: 0 };
  for (let i = 1; i < kms.length; i++) {
    if (kms[i] < 0.3) continue;
    const d = kms[i] * 1000, h = heights[i];
    if (h == null || !isFinite(h)) continue;
    const drop = d * d * (1 - k) / (2 * R);                  // curvature minus refraction
    const ang = deg(Math.atan2(h - drop - h0, d));
    if (ang > best.angle) best = { angle: ang, atKm: kms[i], rise: h - h0 };
  }
  return best;
}

/** When the sun drops below a horizon at `angle` degrees (sunset) or rises above it (sunrise). */
export function terrainEventTime(lat, lon, eventUnix, angle, kind = "sunset") {
  // the sun's centre is at about -0.83° at the official sunset/sunrise (refraction + radius)
  const target = angle - 0.83 + 0.27;   // top edge of the sun meets the terrain line
  const H = 3 * 3600;
  return kind === "sunset" ? crossingTime(lat, lon, eventUnix - H, eventUnix + 600, target)
                           : crossingTime(lat, lon, eventUnix - 600, eventUnix + H, target);
}

/** Plain-English summary of the horizon. */
export function terrainSummary(h, eventUnix, terrainUnix, kind = "sunset") {
  if (h.angle == null || !isFinite(h.angle)) return null;
  const mins = terrainUnix != null ? Math.round(Math.abs(eventUnix - terrainUnix) / 60) : null;
  const dist = h.atKm < 1 ? `${Math.round(h.atKm * 1000)} m` : `${h.atKm} km`;
  if (h.angle < 0.5) return { level: "clear", text: `Open horizon towards the ${kind}.` };
  const caveat = " (From terrain data: trees and buildings aren't included.)";
  const when = mins ? ` The sun ${kind === "sunset" ? "disappears behind it about " + mins + " min before the official sunset" : "clears it about " + mins + " min after the official sunrise"}.` : "";
  if (h.angle < 2) return { level: "low", text: `Slightly raised horizon (${h.angle.toFixed(1)}°, high ground ${dist} away).${when}${caveat}` };
  return { level: "high", text: `Hills or ridges block the low sun: the horizon is ${h.angle.toFixed(1)}° up, ${dist} away.${when} Clouds overhead can still light up, but you won't see the sun touch the horizon.${caveat}` };
}
