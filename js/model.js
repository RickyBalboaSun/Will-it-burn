// Will It Burn? – scoring model and astronomy helpers.
// Pure functions only (no DOM, no network) so they can be tested in Node.
// The scoring must stay identical to model/logic.py in the private data repo;
// tests/parity.test.mjs checks this against fixtures generated from the Python.

export const MODEL_VERSION = "1.1.0";

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

export function verdictFor(score) {
  if (score >= 75) return "Fire in the sky!";
  if (score >= 50) return "Potentially good";
  if (score >= 25) return "Some colour possible";
  return "Not looking good";
}

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
    verdict: verdictFor(score),
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

/* ---------- multi-model confidence ---------- */
export const CONFIDENCE_MODELS = ["ecmwf_ifs025", "gfs_seamless", "icon_seamless"];

/** Summarise how much weather models disagree. scores: array of numbers. */
export function confidenceFrom(scores) {
  const v = scores.filter(s => s != null);
  if (v.length < 2) return null;
  const spread = Math.max(...v) - Math.min(...v);
  const level = spread <= 15 ? "High" : spread <= 30 ? "Medium" : "Low";
  return { level, spread, min: Math.min(...v), max: Math.max(...v), n: v.length };
}
