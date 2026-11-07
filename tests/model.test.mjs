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
    const r = M.scoreSamples(S);
    // Python rounds exact halves to even; allow that one-point difference only at .5
    const half = Math.abs((r.raw % 1) - 0.5) < 1e-9;
    assert.ok(r.score === c.score || (half && Math.abs(r.score - c.score) === 1), `${r.score} vs ${c.score}`);
    const map = { canvas: "canvas", path: "light_path", local: "local_low_cloud", overcast: "overcast", rain: "rain", clarity: "clarity" };
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
