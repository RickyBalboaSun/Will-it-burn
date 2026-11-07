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
