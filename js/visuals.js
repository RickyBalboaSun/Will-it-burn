// Will It Burn? – cartoon visuals drawn from the forecast.
//   windowSVG  (B) what you'll see facing the sun, with a time offset for the slider
//   sliceSVG   (A) side cross-section from you to 250 km towards the sun
//   miniStack  (C) tiny cloud-layers + horizon icon for day cards and lists
// Pure functions returning markup strings, so they can be tested in Node.
import * as M from "./model.js";

const PAL = {
  lit: "#ff8f7a", lit2: "#ffc2a8", gold: "#ffd27a", grey: "#8e8a9c", dark: "#4a4556",
  ground: "#1a1424", ray: "#ffcf6b", path: "#7ee0c8", block: "#ff9c8a",
};
const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const mixHex = (a, b, t) => {
  const pa = a.match(/\w\w/g).map(h => parseInt(h, 16)), pb = b.match(/\w\w/g).map(h => parseInt(h, 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * clamp(t)).toString(16).padStart(2, "0")).join("");
};
function rng(seed) { let x = Math.abs(Math.floor(seed)) % 2147483647 || 7; return () => (x = x * 16807 % 2147483647) / 2147483647; }
const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Cartoon cloud: rounded base plus three puffs. */
function cloud(x, y, w, fill, op = 1) {
  const h = w * 0.34, r1 = w * 0.22, r2 = w * 0.3;
  return `<g opacity="${op.toFixed(2)}" fill="${fill}">` +
    `<rect x="${x.toFixed(1)}" y="${(y + h * 0.45).toFixed(1)}" width="${w.toFixed(1)}" height="${(h * 0.55).toFixed(1)}" rx="${(h * 0.27).toFixed(1)}"/>` +
    `<circle cx="${(x + w * 0.28).toFixed(1)}" cy="${(y + h * 0.55).toFixed(1)}" r="${(r1 / 2 * 1.6).toFixed(1)}"/>` +
    `<circle cx="${(x + w * 0.52).toFixed(1)}" cy="${(y + h * 0.42).toFixed(1)}" r="${(r2 / 2 * 1.6).toFixed(1)}"/>` +
    `<circle cx="${(x + w * 0.76).toFixed(1)}" cy="${(y + h * 0.58).toFixed(1)}" r="${(r1 / 2 * 1.5).toFixed(1)}"/></g>`;
}
const wisp = (x, y, w, fill, op = 0.9) =>
  `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="5" rx="2.5" fill="${fill}" opacity="${op}" transform="rotate(-5 ${x.toFixed(1)} ${y.toFixed(1)})"/>`;

/**
 * Cloud cover per layer at each sample distance, for the model whose breakdown is shown.
 * Returns { 0: {low, mid, high}, 25: {...}, ... } (percent, may be null).
 */
export function layersAt(locations, model, t) {
  const out = {};
  M.ALL_KM.forEach((km, i) => {
    const v = k => M.valueAt(locations[i], model ? `${k}_${model}` : k, t);
    out[km] = { low: v("cloud_cover_low"), mid: v("cloud_cover_mid"), high: v("cloud_cover_high") };
  });
  return out;
}

/**
 * How strongly clouds catch colour at `minutes` from the event (sunset: + is after).
 * Rises before sunset, peaks 5–15 min after, fades by ~30 min after; mirrored for sunrise.
 */
export function glowCurve(minutes, kind = "sunset") {
  const m = kind === "sunset" ? minutes : -minutes;
  if (m <= -30) return 0.3;
  if (m < 0) return 0.3 + 0.45 * (m + 30) / 30;
  if (m <= 5) return 0.75 + 0.25 * m / 5;
  if (m <= 15) return 1;
  if (m <= 30) return 1 - 0.8 * (m - 15) / 15;
  return 0.2;
}

/* ---------------- B: window view ---------------- */
/**
 * opts: { e (scored event), layers (layersAt), kind, az, minutes, sunElev (deg at that time), W, H }
 */
export function windowSVG({ e, layers, kind, az, minutes = 10, sunElev = -3, W = 358, H = 250 }) {
  const f = e.factors, rand = rng(e.t);
  const lit = clamp(f.path * glowCurve(minutes, kind) * (0.55 + 0.45 * e.score / 100));
  const g = H * 0.8;                        // horizon
  const over = layers[0], near = layers[25];
  const avg = k => { const v = [over[k], near[k]].filter(x => x != null); return v.length ? v.reduce((a, b) => a + b) / v.length : 0; };
  const high = avg("high"), mid = avg("mid"), lowOver = over.low || 0;
  const pathLow = M.mean(M.PATH_KM.map(km => layers[km].low)) || 0;
  const top = mixHex("2b2d38", "2a1846", lit), midC = mixHex("4b4e5c", "b8336a", lit), low = mixHex("6e707b", "ff7a2f", lit);
  const o = [];
  o.push(`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(sceneLabel(e, kind, az, high, mid, pathLow))}" xmlns="http://www.w3.org/2000/svg">`);
  o.push(`<defs><linearGradient id="wsky" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="0.6" stop-color="${midC}"/><stop offset="1" stop-color="${low}"/></linearGradient>` +
    `<radialGradient id="wglow" cx="0.5" cy="1" r="0.75"><stop offset="0" stop-color="#ffc878" stop-opacity="${(0.15 + 0.6 * lit).toFixed(2)}"/><stop offset="1" stop-color="#ffc878" stop-opacity="0"/></radialGradient>` +
    `<clipPath id="wclip"><rect width="${W}" height="${H}" rx="16"/></clipPath></defs>`);
  o.push(`<g clip-path="url(#wclip)"><rect width="${W}" height="${H}" fill="url(#wsky)"/><rect x="0" y="${g - H * 0.6}" width="${W}" height="${H * 0.6}" fill="url(#wglow)"/>`);
  // high cloud: wisps near the top
  const nH = Math.round(high / 100 * 9);
  for (let i = 0; i < nH; i++) o.push(wisp(rand() * W * 0.85, 12 + rand() * g * 0.22, 50 + rand() * 80, mixHex("9a9cab", PAL.lit2, lit), 0.85));
  // mid cloud: rafts across the middle
  const nM = Math.round(mid / 100 * 10);
  for (let i = 0; i < nM; i++) o.push(cloud(rand() * W * 0.9 - 20, g * (0.25 + rand() * 0.35), 60 + rand() * 50, mixHex(PAL.grey, PAL.lit, lit)));
  // low cloud overhead: dark patches near the top of the view
  const nL = Math.round(lowOver / 100 * 6);
  for (let i = 0; i < nL; i++) o.push(cloud(rand() * W * 0.9 - 20, g * (0.05 + rand() * 0.5), 90 + rand() * 50, PAL.dark, 0.85));
  // the sun, at its real elevation for this time
  const sy = g - sunElev * 9, sr = 15;
  if (sunElev > -2.5) o.push(`<circle cx="${W / 2}" cy="${sy.toFixed(1)}" r="${sr}" fill="${PAL.gold}"/>`);
  // low cloud on the far horizon (the light path)
  if (pathLow > 12) {
    const bankH = 8 + pathLow / 100 * 46;
    for (let x = -20; x < W + 30; x += 30) o.push(`<circle cx="${x + rand() * 10}" cy="${(g - bankH * 0.4 + rand() * 6).toFixed(1)}" r="${(bankH * (0.55 + rand() * 0.3)).toFixed(1)}" fill="${PAL.dark}" opacity="0.92"/>`);
  }
  // ground
  o.push(`<path d="M0 ${g} Q ${W * 0.3} ${g - 6} ${W * 0.55} ${g + 2} T ${W} ${g - 3} L ${W} ${H} L 0 ${H} Z" fill="${PAL.ground}"/>`);
  if (sunElev <= -2.5) o.push(`<circle cx="${W / 2}" cy="${Math.min(H - 18, sy).toFixed(1)}" r="${sr}" fill="none" stroke="${PAL.gold}" stroke-width="2" stroke-dasharray="4 4" opacity="0.8"/>`);
  o.push(`<text x="${W / 2}" y="${H - 10}" text-anchor="middle" font-size="11" fill="rgba(255,255,255,0.75)" font-family="Inter, system-ui, sans-serif">${esc(sunText(sunElev))} · facing ${esc(M.compass(az))}</text>`);
  o.push(`</g></svg>`);
  return o.join("");
}
function sunText(el) {
  if (el >= 0.5) return `Sun ${Math.round(el)}° up`;
  if (el > -0.5) return "Sun on the horizon";
  return `Sun ${Math.round(-el)}° below`;
}
function sceneLabel(e, kind, az, high, mid, pathLow) {
  return `Cartoon of the ${kind} sky facing ${M.compass(az)}: high cloud ${Math.round(high)}%, mid cloud ${Math.round(mid)}%, low cloud on the horizon ${Math.round(pathLow)}%.`;
}

/* ---------------- A: side slice ---------------- */
/** opts: { e, layers, kind, W, H } */
export function sliceSVG({ e, layers, kind, W = 330, H = 230 }) {
  const f = e.factors, g = H - 46;
  const X = { 0: 30, 25: 0.3 * W, 75: 0.52 * W, 150: 0.72 * W, 250: 0.9 * W };
  const band = { high: g * 0.12, mid: g * 0.36, low: g * 0.66 };
  const pathOk = f.path >= 0.5;
  const o = [];
  o.push(`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${esc(sliceLabel(layers, pathOk, kind))}" xmlns="http://www.w3.org/2000/svg" font-family="Inter, system-ui, sans-serif">`);
  o.push(`<defs><linearGradient id="ssky" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#2a1846"/><stop offset="0.6" stop-color="#5a2d66"/><stop offset="1" stop-color="${pathOk ? "#d8704c" : "#5c5a68"}"/></linearGradient><clipPath id="sclip"><rect width="${W}" height="${H}" rx="14"/></clipPath></defs>`);
  o.push(`<g clip-path="url(#sclip)"><rect width="${W}" height="${H}" fill="url(#ssky)"/>`);
  for (const [name, y] of [["High", g * 0.24], ["Mid", g * 0.52], ["Low", g]]) {
    o.push(`<line x1="0" x2="${W}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.18)" stroke-dasharray="3 4"/>`);
    o.push(`<text x="${(W * 0.41).toFixed(1)}" y="${(y - 5).toFixed(1)}" font-size="9" letter-spacing="0.6" fill="rgba(255,255,255,0.55)" text-anchor="middle">${name.toUpperCase()}</text>`);
  }
  // sun just below the horizon at the far end
  o.push(`<circle cx="${W - 18}" cy="${g + 6}" r="16" fill="${PAL.gold}"/>`);
  // clouds at each distance, sized by cover
  let blockAt = null;
  for (const km of M.ALL_KM) {
    const L = layers[km], canvasZone = km <= 25, x = X[km];
    if (L.high != null && L.high >= 10) {
      const w = 26 + L.high / 100 * 50;
      o.push(wisp(x - w / 2, band.high, w, canvasZone && pathOk ? PAL.lit2 : PAL.grey));
      o.push(wisp(x - w / 3, band.high + 8, w * 0.7, canvasZone && pathOk ? PAL.lit2 : PAL.grey, 0.6));
    }
    if (L.mid != null && L.mid >= 10) {
      const w = 26 + L.mid / 100 * 60;
      o.push(cloud(x - w / 2, band.mid, w, canvasZone && pathOk ? PAL.lit : PAL.grey));
    }
    if (L.low != null && L.low >= 10) {
      const w = 26 + L.low / 100 * 60;
      o.push(cloud(x - w / 2, band.low, w, PAL.dark));
      if (!canvasZone && L.low + 0.5 * (L.mid || 0) >= 55 && blockAt == null) blockAt = km;
    }
  }
  // the light ray: under the clouds to the canvas, or stopped by a bank on the light path
  const sx = W - 30, sy = g - 2;
  if (blockAt == null && pathOk) {
    o.push(`<line x1="${sx}" y1="${sy}" x2="${X[25] + 8}" y2="${band.mid + 18}" stroke="${PAL.ray}" stroke-width="2.5" stroke-dasharray="6 4"/>`);
  } else {
    const bx = blockAt != null ? X[blockAt] + 18 : X[150];
    o.push(`<line x1="${sx}" y1="${sy}" x2="${bx}" y2="${band.low + 12}" stroke="${PAL.ray}" stroke-opacity="0.55" stroke-width="2.5" stroke-dasharray="6 4"/>`);
    o.push(`<text x="${bx - 4}" y="${band.low + 4}" font-size="16" fill="${PAL.block}" text-anchor="end" font-weight="700">×</text>`);
  }
  // ground, you, distances
  o.push(`<path d="M-20 ${g + 4} Q ${W / 2} ${g - 10} ${W + 20} ${g + 4} L ${W + 20} ${H} L -20 ${H} Z" fill="${PAL.ground}"/>`);
  o.push(`<circle cx="${X[0]}" cy="${g - 10}" r="6" fill="#fff"/><rect x="${X[0] - 2}" y="${g - 5}" width="4" height="8" rx="2" fill="#fff"/>`);
  for (const km of M.ALL_KM) o.push(`<text x="${X[km]}" y="${g + 20}" font-size="10" fill="rgba(255,255,255,0.7)" text-anchor="middle">${km ? km + " km" : "You"}</text>`);
  o.push(`<line x1="${X[0] - 6}" x2="${X[25] + 30}" y1="${g + 30}" y2="${g + 30}" stroke="${PAL.lit}" stroke-width="2"/><text x="${X[0] - 6}" y="${g + 41}" font-size="9.5" fill="${PAL.lit2}">Canvas</text>`);
  o.push(`<line x1="${X[75] - 14}" x2="${X[250] + 14}" y1="${g + 30}" y2="${g + 30}" stroke="${pathOk ? PAL.path : PAL.block}" stroke-width="2"/><text x="${X[250] + 14}" y="${g + 41}" font-size="9.5" fill="${pathOk ? "#b5f0e2" : "#ffc9bf"}" text-anchor="end">Light path${pathOk ? "" : ": blocked"}</text>`);
  o.push(`</g></svg>`);
  return o.join("");
}
function sliceLabel(layers, pathOk, kind) {
  const r = x => x == null ? "unknown" : Math.round(x) + "%";
  return `Side view towards the ${kind}. Overhead: mid cloud ${r(layers[0].mid)}, high ${r(layers[0].high)}, low ${r(layers[0].low)}. ` +
    `Light path 75 to 250 km: low cloud ${M.PATH_KM.map(k => r(layers[k].low)).join(", ")}. ${pathOk ? "The light can get through." : "The light is blocked."}`;
}

/* ---------------- C: mini sky stack ---------------- */
/** Tiny icon: dot rows for high / mid / low cloud overhead and a horizon line (clear or blocked). */
export function miniStack(e) {
  const i = e.inputs, f = e.factors, pathOk = f.path >= 0.5;
  const dots = (pct, col) => {
    const n = Math.round(clamp((pct || 0) / 100) * 4);
    return `<span class="ms-row">${Array.from({ length: 4 }, (_, k) => `<i style="background:${k < n ? col : "transparent"}"></i>`).join("")}</span>`;
  };
  const lit = pathOk && f.canvas >= 0.3;
  return `<span class="ms" aria-hidden="true">` +
    dots(i.cHigh, lit ? PAL.lit2 : PAL.grey) + dots(i.cMid, lit ? PAL.lit : PAL.grey) + dots(i.low, PAL.dark) +
    `<span class="ms-hz" style="border-color:${pathOk ? PAL.path : PAL.block}"><b style="background:${pathOk ? PAL.gold : PAL.grey}"></b></span></span>`;
}
