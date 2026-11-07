// Minimal EXIF reader for JPEG photos: date/time taken and GPS position only.
// No dependencies; returns {taken: {y,m,d,hh,mm,ss} | null, lat: number|null, lon: number|null}.

export function readExif(buffer) {
  const v = new DataView(buffer);
  const out = { taken: null, lat: null, lon: null };
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return out;            // not a JPEG
  let p = 2;
  while (p + 4 <= v.byteLength) {
    if (v.getUint8(p) !== 0xff) break;
    const marker = v.getUint8(p + 1), len = v.getUint16(p + 2);
    if (marker === 0xe1 && p + 10 <= v.byteLength && v.getUint32(p + 4) === 0x45786966) {   // "Exif"
      return parseTiff(v, p + 10, Math.min(len - 8, v.byteLength - p - 10), out);
    }
    if (marker === 0xda || marker === 0xd9) break;                            // image data: no EXIF before it
    p += 2 + len;
  }
  return out;
}

function parseTiff(v, start, length, out) {
  const end = start + length;
  const le = v.getUint16(start) === 0x4949;
  const u16 = o => v.getUint16(start + o, le), u32 = o => v.getUint32(start + o, le);
  const inRange = o => start + o >= start && start + o < end;
  const readIfd = off => {
    const tags = {};
    if (!inRange(off + 2)) return tags;
    const n = u16(off);
    for (let i = 0; i < n && i < 512; i++) {
      const e = off + 2 + i * 12;
      if (!inRange(e + 12)) break;
      tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), valueOff: e + 8 };
    }
    return tags;
  };
  const ascii = t => {
    const o = t.count > 4 ? u32(t.valueOff) : t.valueOff;
    let s = "";
    for (let i = 0; i < t.count - 1 && inRange(o + i); i++) s += String.fromCharCode(v.getUint8(start + o + i));
    return s;
  };
  const rationals = t => {
    const o = u32(t.valueOff), r = [];
    for (let i = 0; i < t.count && inRange(o + i * 8 + 7); i++) { const d = u32(o + i * 8 + 4); r.push(d ? u32(o + i * 8) / d : 0); }
    return r;
  };
  try {
    const ifd0 = readIfd(u32(4));
    const exif = ifd0[0x8769] ? readIfd(u32(ifd0[0x8769].valueOff)) : {};
    const dt = exif[0x9003] || exif[0x9004] || ifd0[0x0132];
    if (dt) {
      const m = ascii(dt).match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (m) out.taken = { y: +m[1], m: +m[2], d: +m[3], hh: +m[4], mm: +m[5], ss: +m[6] };
    }
    if (ifd0[0x8825]) {
      const g = readIfd(u32(ifd0[0x8825].valueOff));
      const dms = t => { const [a, b, c] = rationals(t); return a + (b || 0) / 60 + (c || 0) / 3600; };
      if (g[2] && g[4]) {
        const lat = dms(g[2]) * (g[1] && ascii(g[1]) === "S" ? -1 : 1);
        const lon = dms(g[4]) * (g[3] && ascii(g[3]) === "W" ? -1 : 1);
        if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0)) { out.lat = lat; out.lon = lon; }
      }
    }
  } catch { /* malformed EXIF: return what we have */ }
  return out;
}
