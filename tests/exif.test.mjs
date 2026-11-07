import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { readExif } from "../js/exif.js";
const ab = f => { const b = readFileSync(f); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

test("reads date taken and GPS from a camera JPEG", { skip: !existsSync("/tmp/test-photo.jpg") }, () => {
  const x = readExif(ab("/tmp/test-photo.jpg"));
  assert.equal(x.taken.hh, 17); assert.equal(x.taken.mm, 31);
  assert.ok(Math.abs(x.lat - (37 + 36 / 60 + 35.2 / 3600)) < 1e-6);
  assert.ok(Math.abs(x.lon + (112 + 9 / 60 + 42 / 3600)) < 1e-6, "west is negative");
});
test("photos without EXIF give nulls, not errors", { skip: !existsSync("/tmp/no-exif.jpg") }, () => {
  assert.deepEqual(readExif(ab("/tmp/no-exif.jpg")), { taken: null, lat: null, lon: null });
});
test("the real Bryce photo has no date or location (stripped when shared)", { skip: !existsSync("/tmp/bryce-copy.jpg") }, () => {
  const x = readExif(ab("/tmp/bryce-copy.jpg"));
  assert.equal(x.taken, null); assert.equal(x.lat, null);
});
test("non-JPEG input is ignored", () => {
  assert.deepEqual(readExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer), { taken: null, lat: null, lon: null });
});
