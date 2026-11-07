import { test } from "node:test";
import assert from "node:assert/strict";
import * as V from "../js/visuals.js";

const ev = (over = {}) => ({ t: 1000, score: 74, factors: { canvas: 0.9, path: 1, local: 1, overcast: 1, rain: 1, clarity: 1, ...(over.factors || {}) },
  inputs: { cMid: 55, cHigh: 30, low: 0, pathLow: 0, ...(over.inputs || {}) } });
const layers = (o = {}) => ({ 0: { low: 0, mid: 55, high: 30 }, 25: { low: 0, mid: 50, high: 30 }, 75: { low: 0, mid: 5, high: 0 }, 150: { low: 0, mid: 0, high: 0 }, 250: { low: 0, mid: 0, high: 0 }, ...o });

test("window view draws clouds and a labelled sun", () => {
  const svg = V.windowSVG({ e: ev(), layers: layers(), kind: "sunset", az: 250, minutes: 10, sunElev: -2 });
  assert.match(svg, /^<svg/); assert.match(svg, /<\/svg>$/);
  assert.ok((svg.match(/<circle/g) || []).length > 5, "has cartoon clouds");
  assert.match(svg, /Sun 2° below · facing west/);
  assert.match(svg, /aria-label="Cartoon of the sunset sky facing west/);
});

test("window view: a blocked horizon draws a cloud bank, a clear one does not", () => {
  const clear = V.windowSVG({ e: ev(), layers: layers(), kind: "sunset", az: 250 });
  const blocked = V.windowSVG({ e: ev({ factors: { path: 0.1 } }), layers: layers({ 75: { low: 80, mid: 20, high: 0 }, 150: { low: 90, mid: 10, high: 0 }, 250: { low: 70, mid: 0, high: 0 } }), kind: "sunset", az: 250 });
  assert.ok((blocked.match(/opacity="0.92"/g) || []).length > 5);
  assert.equal((clear.match(/opacity="0.92"/g) || []).length, 0);
});

test("window view is stable for the same event (no jumping when the slider moves)", () => {
  const a = V.windowSVG({ e: ev(), layers: layers(), kind: "sunset", az: 250, minutes: 0, sunElev: 0 });
  const b = V.windowSVG({ e: ev(), layers: layers(), kind: "sunset", az: 250, minutes: 0, sunElev: 0 });
  assert.equal(a, b);
});

test("glow curve peaks after sunset and before sunrise", () => {
  assert.equal(V.glowCurve(10, "sunset"), 1);
  assert.ok(V.glowCurve(-20, "sunset") < V.glowCurve(0, "sunset"));
  assert.ok(V.glowCurve(30, "sunset") < 0.3);
  assert.equal(V.glowCurve(-10, "sunrise"), 1);
});

test("side slice: ray reaches the canvas when clear, stops with an × when blocked", () => {
  const ok = V.sliceSVG({ e: ev(), layers: layers(), kind: "sunset" });
  assert.ok(!ok.includes("×") && ok.includes("Light path<"));
  const bad = V.sliceSVG({ e: ev({ factors: { path: 0.1 } }), layers: layers({ 150: { low: 85, mid: 20, high: 0 } }), kind: "sunset" });
  assert.ok(bad.includes("×") && bad.includes("Light path: blocked"));
  assert.match(bad, /The light is blocked/);
});

test("mini stack: four dots per row, coloured by cover", () => {
  const html = V.miniStack(ev());
  assert.equal((html.match(/<i /g) || []).length, 12);
  assert.ok(html.includes("#7ee0c8"), "clear horizon is green");
  assert.ok(V.miniStack(ev({ factors: { path: 0.2 } })).includes("#ff9c8a"), "blocked horizon is red");
});
