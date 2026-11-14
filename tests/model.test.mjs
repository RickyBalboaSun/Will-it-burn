// Run with: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as M from "../js/model.js";

const fx = JSON.parse(readFileSync(new URL("./parity-fixtures.json", import.meta.url)));

test("model version matches the Python model", () => {
  assert.equal(M.MODEL_VERSION, fx.model_version);
});

test("scores match the Python model on 400 random cases", () => {
  for (const c of fx.cases) {
    const S = Object.fromEntries(Object.entries(c.S).map(([k, v]) => [Number(k), v]));
    const r = M.scoreSamples(S, c.air || {});
    // Python rounds exact halves to even; allow that one-point difference only at .5
    const half = Math.abs((r.raw % 1) - 0.5) < 1e-9;
    assert.ok(r.score === c.score || (half && Math.abs(r.score - c.score) === 1), `${r.score} vs ${c.score}`);
    const map = { canvas: "canvas", path: "light_path", local: "local_low_cloud", overcast: "overcast", rain: "rain", clarity: "clarity", air: "air" };
    if (!half) assert.equal(r.verdict, c.verdict, "verdict matches Python");
    for (const [js, py] of Object.entries(map)) assert.ok(Math.abs(r.factors[js] - c.factors[py]) <= 0.005 + 1e-12, `${js} ${r.factors[js]} vs ${c.factors[py]}`); // Python reports factors to 2 dp
  }
});

test("azimuth and sample points match the Python model", () => {
  for (const g of fx.geo) {
    assert.ok(Math.abs(M.eventAzimuth(g.lat, g.doy, "sunset") - g.az) < 1e-9);
    M.ALL_KM.forEach((km, i) => {
      const [la, lo] = M.destination(g.lat, g.lon, g.az, km);
      assert.ok(Math.abs(la - g.pts[i][0]) < 1e-9 && Math.abs(lo - g.pts[i][1]) < 1e-9);
    });
  }
});

test("sunrise azimuth mirrors sunset", () => {
  const s = M.eventAzimuth(51.57, 310, "sunset"), r = M.eventAzimuth(51.57, 310, "sunrise");
  assert.ok(Math.abs(s + r - 360) < 1e-9);
  assert.ok(r > 90 && r < 180); // south-east in November
});

test("solar elevation is near zero at a known sunset (Bryce, 6 Nov 2026 ~17:20 MST)", () => {
  const t = Date.UTC(2026, 10, 7, 0, 20) / 1000;
  const p = M.solarPosition(37.6097, -112.1617, t);
  assert.ok(Math.abs(p.elevation) < 1.5, `elevation ${p.elevation}`);
  assert.ok(p.azimuth > 240 && p.azimuth < 258, `azimuth ${p.azimuth}`);
});

test("solar noon elevation in London midsummer ~62 degrees", () => {
  const t = Date.UTC(2026, 5, 21, 12, 2) / 1000;
  const p = M.solarPosition(51.5, -0.12, t);
  assert.ok(Math.abs(p.elevation - 62) < 1, `elevation ${p.elevation}`);
});

test("viewing times are ordered sensibly", () => {
  const t = Date.UTC(2026, 10, 7, 0, 20) / 1000;
  const v = M.viewingTimes(37.6097, -112.1617, t, "sunset");
  assert.ok(v.golden < t && t < v.civil);
  assert.ok((t - v.golden) / 60 > 20 && (t - v.golden) / 60 < 70, "golden hour 20-70 min before");
  assert.ok((v.civil - t) / 60 > 20 && (v.civil - t) / 60 < 40, "civil dusk 20-40 min after");
  const r = M.viewingTimes(37.6097, -112.1617, t - 10 * 3600, "sunrise");
  assert.ok(r.civil < t - 10 * 3600 && r.golden > t - 10 * 3600);
});

test("valueAt interpolates and returns null outside the data", () => {
  const loc = { hourly: { time: [0, 3600], x: [0, 60] } };
  assert.equal(M.valueAt(loc, "x", 1800), 30);
  assert.equal(M.valueAt(loc, "x", 7200), null);
  assert.equal(M.valueAt(loc, "missing", 0), null);
});

test("confidence levels", () => {
  assert.equal(M.confidenceFrom([60, 65, 70]).level, "High");
  assert.equal(M.confidenceFrom([30, 50, 55]).level, "Medium");
  assert.equal(M.confidenceFrom([10, 70]).level, "Low");
  assert.equal(M.confidenceFrom([50]), null);
});

test("look-for tips match the conditions", () => {
  const mk = (factors, inputs) => ({ factors: { canvas: 1, path: 1, local: 1, overcast: 1, rain: 1, clarity: 1, ...factors }, inputs: { cMid: 50, cHigh: 0, low: 0, pathLow: 0, rainP: 0, visKm: 40, ...inputs } });
  const titles = (e, kind = "sunset") => M.lookFor(e, kind, 250).map(t => t.t);
  assert.ok(titles(mk({}, {})).includes("Underlit clouds"));
  assert.ok(titles(mk({ canvas: 0 }, { cMid: 0 })).includes("Belt of Venus"));
  const venus = M.lookFor(mk({ canvas: 0 }, { cMid: 0 }), "sunset", 250).find(t => t.t === "Belt of Venus");
  assert.match(venus.d, /north-east|east/);
  assert.ok(titles(mk({}, { rainP: 50 })).includes("Rainbow chance"));
  assert.ok(titles(mk({ path: 0.2 }, {})).includes("Watch for a gap"));
  assert.ok(titles(mk({}, { low: 40 })).includes("Sunbeams"));
  assert.ok(M.lookFor(mk({}, {}), "sunrise", 110)[0].d.includes("before sunrise"));
  assert.ok(M.lookFor(mk({ canvas: 0.1, path: 0.5, overcast: 0.5 }, { cMid: 0 }), "sunset", 250).length >= 1);
});

test("alert timing rules", () => {
  const off = -7 * 3600, day = Date.UTC(2026, 10, 9) / 1000 - off;           // local midnight, 9 Nov
  const sunset = { t: day + 17 * 3600 + 20 * 60, score: 74 };
  const at = h => day + h * 3600;
  const cfg = { threshold: 60, notified: [] };
  assert.equal(M.shouldAlert(cfg, sunset, at(14), off, "a"), true, "afternoon before a good sunset");
  assert.equal(M.shouldAlert(cfg, sunset, at(3), off, "a"), false, "not at 3am");
  assert.equal(M.shouldAlert(cfg, sunset, at(17), off, "a"), false, "not within 30 min of sunset");
  assert.equal(M.shouldAlert({ ...cfg, threshold: 80 }, sunset, at(14), off, "a"), false, "below threshold");
  assert.equal(M.shouldAlert({ ...cfg, notified: ["a"] }, sunset, at(14), off, "a"), false, "only once per event");
  const sunrise = { t: day + 86400 + 7 * 3600, score: 70 };
  assert.equal(M.shouldAlert(cfg, sunrise, at(20), off, "b"), true, "evening before a good sunrise");
  assert.equal(M.shouldAlert(cfg, sunrise, at(14), off, "b"), false, "not in the afternoon for tomorrow's sunrise");
});

test("median of three weather models", () => {
  const t = 3600;
  const loc = mids => ({ hourly: Object.assign({ time: [0, 7200] }, ...M.WEATHER_MODELS.flatMap((m, i) =>
    M.VARS.map(v => ({ [`${v}_${m}`]: [v === "cloud_cover_mid" ? mids[i] : v === "visibility" ? 40000 : v === "relative_humidity_2m" ? 50 : 0, null].map((x, k) => k ? x ?? (v === "cloud_cover_mid" ? mids[i] : 0) : x) }))))});
  const near = loc([0, 55, 95]), far = loc([5, 5, 5]);
  const r = M.scoreModels([near, near, far, far, far], t);
  const scores = r.modelScores.map(x => x.score);
  assert.equal(scores.length, 3);
  assert.equal(r.score, [...scores].sort((a, b) => a - b)[1]);
  assert.ok(M.WEATHER_MODELS.includes(r.model));
});

test("event times come from suffixed daily keys", () => {
  assert.deepEqual(M.eventTimes({ sunset: [1] }, "sunset"), [1]);
  assert.deepEqual(M.eventTimes({ sunset_gfs_seamless: [2], sunrise_gfs_seamless: [3] }, "sunrise"), [3]);
  assert.deepEqual(M.eventTimes({}, "sunset"), []);
});

test("rating verification", () => {
  const spot = { lat: 51.57, lon: -4.0 }, ev = 1_000_000;
  const near = M.verification(spot, { lat: 51.5703, lon: -4.0002, accuracy: 15 }, ev + 22 * 60, ev);
  assert.equal(near.onLocation, true); assert.match(near.text, /^rated on location \(\d+ m from the spot\), 22 min after sunset$/);
  const far = M.verification(spot, { lat: 51.48, lon: -3.18, accuracy: 15 }, ev + 3 * 3600, ev);
  assert.equal(far.onLocation, false); assert.match(far.text, /km from the spot, 3\.0 h after sunset/);
  assert.match(M.verification(spot, null, ev + 600, ev).text, /location not available/);
  assert.equal(M.verification(spot, { lat: 51.57, lon: -4.0 }, ev + 2 * 86400, ev).onLocation, false, "next-day rating isn't on location");
});

test("photo metadata check", () => {
  const spot = { lat: 51.57, lon: -4.0 }, ev = Date.UTC(2026, 10, 8, 16, 36) / 1000;
  assert.equal(M.photoCheck(spot, null, ev, 0), "photo has no time or location data");
  const t = M.photoCheck(spot, { takenUnix: ev + 11 * 60, lat: 51.5705, lon: -4.0005 }, ev, 0);
  assert.match(t, /^photo taken 16:47 \(11 min after sunset\), \d+ m from the spot$/);
  assert.match(M.photoCheck(spot, { takenUnix: ev + 5 * 86400 }, ev, 0), /different day.*no location in the photo/);
});

test("log issue body is what the ingest job expects", () => {
  const body = M.logIssueBody({ kind: "sunset", date: "2026-11-08", place: { name: "Near Mumbles", detail: "Swansea", lat: 51.57, lon: -4 },
    facing: 236, predicted: 62, model: "1.2.0", rating: 8, notes: "Pink\nclouds", savedAt: Date.UTC(2026, 10, 8, 16, 58), verification: "rated on location", photoMeta: "" }, "16:36");
  assert.match(body, /<!-- will-it-burn-log v1 -->\nkind: sunset\ndate: 2026-11-08\n/);
  assert.match(body, /\nrating: 8\n/); assert.match(body, /\nnotes: Pink clouds\n/); assert.match(body, /<!-- end -->/);
});

test("horizon angle from terrain", () => {
  const flat = M.TERRAIN_KM.map(() => 100);
  const f = M.horizonAngle(flat);
  assert.ok(f.angle < 0.05, `flat ground gives a near-zero (curvature-lowered) horizon, got ${f.angle}`);
  const ridge = M.TERRAIN_KM.map(km => km === 2 ? 300 : 100);   // a 200 m ridge 2 km away
  const r = M.horizonAngle(ridge);
  assert.equal(r.atKm, 2); assert.ok(Math.abs(r.angle - 5.67) < 0.1, `ridge angle ${r.angle}`);
  const rim = M.TERRAIN_KM.map((km, i) => i === 0 ? 2400 : 2400 - km * 60);   // standing on a rim, land falls away
  assert.ok(M.horizonAngle(rim).angle < 0, "from a rim the horizon is below eye level");
});

test("terrain moves the effective sunset earlier", () => {
  const lat = 51.57, lon = -4.0, sunset = Date.UTC(2026, 10, 8, 16, 36) / 1000;
  const t3 = M.terrainEventTime(lat, lon, sunset, 3, "sunset");
  assert.ok(t3 < sunset && (sunset - t3) / 60 > 15 && (sunset - t3) / 60 < 40, `3° ridge: ${(sunset - t3) / 60} min earlier`);
  const s = M.terrainSummary({ angle: 3, atKm: 2, rise: 200 }, sunset, t3, "sunset");
  assert.equal(s.level, "high"); assert.match(s.text, /3\.0° up, 2 km away.*min before the official sunset/);
  assert.equal(M.terrainSummary({ angle: 0.2, atKm: 30, rise: 5 }, sunset, sunset, "sunset").level, "clear");
});

test("a cliff-edge viewpoint doesn't create a false ridge", () => {
  // you stand on the rim, but your terrain cell averages part of the drop (60 m lower than the rim behind you)
  const rim = M.TERRAIN_KM.map((km, i) => i === 0 ? 2440 : km <= 1 ? 2500 : 2500 - km * 2);
  assert.ok(M.horizonAngle(rim).angle < 0.5, `got ${M.horizonAngle(rim).angle}`);
  // a real ridge 2 km away is still found
  const ridge = M.TERRAIN_KM.map(km => km === 2 ? 2700 : 2500);
  assert.ok(M.horizonAngle(ridge).angle > 5);
});

test("viewpoints: query and parsing", () => {
  const q = M.overpassQuery(37.61, -112.16, 25);
  assert.ok(q.includes('"tourism"="viewpoint"') && q.includes("around:25000,37.61000,-112.16000"));
  const json = { elements: [
    { type: "node", lat: 37.6227, lon: -112.1661, tags: { tourism: "viewpoint", name: "Sunset Point" } },
    { type: "way", center: { lat: 37.6150, lon: -112.1705 }, tags: { tourism: "viewpoint", name: "Inspiration Point" } },
    { type: "node", lat: 37.6151, lon: -112.1704, tags: { tourism: "viewpoint", name: "Inspiration Point" } }, // duplicate
    { type: "node", lat: 37.70, lon: -112.20, tags: { natural: "peak", name: "Boat Mesa", ele: "2650" } },
    { type: "node", lat: 37.64, lon: -112.15, tags: { tourism: "viewpoint" } }, // unnamed
    { type: "node", lat: 37.6100, lon: -112.1600, tags: { tourism: "viewpoint", name: "Right here" } }, // < 300 m
    { type: "node", lat: 37.5, lon: -112.0, tags: { amenity: "cafe", name: "Cafe" } },
  ] };
  const v = M.parseViewpoints(json, 37.61, -112.16);
  assert.deepEqual(v.map(x => x.name), ["Inspiration Point", "Sunset Point", "Boat Mesa", "Viewpoint"]);
  assert.equal(v[2].ele, 2650);
  assert.equal(v[2].kindLabel, "Peak");
  assert.ok(v[0].dist > 0 && typeof v[0].dir === "string");
});

test("viewpoints: openness from horizon angle", () => {
  assert.equal(M.viewOpenness(0.2).level, "open");
  assert.equal(M.viewOpenness(2).level, "partly");
  assert.equal(M.viewOpenness(6).level, "blocked");
  assert.equal(M.viewOpenness(null), null);
});

test("moon: phase and rise/set agree with SunCalc reference values", () => {
  // 11 Nov 2026 00:00 UTC: just after new moon (SunCalc: 3.0% lit, waxing)
  const p = M.moonPhase(Date.UTC(2026, 10, 11) / 1000);
  assert.ok(Math.abs(p.lit - 0.0297) < 0.01 && p.waxing, JSON.stringify(p));
  // a full moon sits roughly opposite the sun: rises around sunset
  const full = M.moonPhase(Date.UTC(2026, 10, 24, 15) / 1000);
  assert.ok(full.lit > 0.95, JSON.stringify(full));
  const t = M.moonTimes(51.62, -3.94, Date.UTC(2026, 10, 24) / 1000, Date.UTC(2026, 10, 25) / 1000);
  assert.ok(t.rise && t.set, JSON.stringify(t));
});

test("blue hour falls after sunset and before sunrise", () => {
  const set = Date.UTC(2026, 10, 11, 0, 20) / 1000; // ~17:20 MST at Bryce
  const b = M.blueHour(37.61, -112.17, set, "sunset");
  assert.ok(b.start > set && b.end > b.start && b.end - set < 3600, JSON.stringify(b));
});

test("comfort advice", () => {
  assert.equal(M.comfortAdvice(1, 5), "Wrap up warm: hat and gloves.");
  assert.equal(M.comfortAdvice(6, 10), "Bring a warm jacket.");
  assert.equal(M.comfortAdvice(14, 10), "Bring a jacket.");
  assert.equal(M.comfortAdvice(20, 5), "Comfortable: no jacket needed.");
});

test("daily nudge: once a day, after the chosen hour, not late at night", () => {
  const off = -7 * 3600, at = h => Date.UTC(2026, 10, 11, h + 7) / 1000; // local hour h in Arizona
  assert.equal(M.shouldNudge({ daily: null }, at(9), off), null);
  assert.equal(M.shouldNudge({ daily: 8 }, at(7), off), null);
  assert.equal(M.shouldNudge({ daily: 8 }, at(9), off), "2026-11-11");
  assert.equal(M.shouldNudge({ daily: 8, nudged: "2026-11-11" }, at(15), off), null);
  assert.equal(M.shouldNudge({ daily: 8 }, at(22), off), null);
});

test("ratings go to the Netlify form when hosted elsewhere", () => {
  assert.deepEqual(M.ratingsEndpoint("sunscore.day"), { url: "https://sunscore.netlify.app/", sameOrigin: false });
  assert.deepEqual(M.ratingsEndpoint("sunscore.netlify.app"), { url: "/", sameOrigin: true });
  assert.deepEqual(M.ratingsEndpoint("127.0.0.1"), { url: "/", sameOrigin: true });
});
