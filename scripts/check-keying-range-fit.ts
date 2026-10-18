// Candidate colour spaces for Color Range's Lab and YUV: each scored with keyingMath's box-and-ease model over every
// keying_crange quadrant of that space (cells off by more than 3, of the opaque palette cells).
//
//   node scripts/check-keying-range-fit.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";
import { ROOT } from "./lib/suites.ts";

type Coords = (s: number[]) => number[];
const cbrtF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const srgbLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
function lab(lin: number[], white = [0.95047, 1, 1.08883], scale = [2.55, 1, 1], offset = 128): number[] {
  const x = (0.4124 * lin[0] + 0.3576 * lin[1] + 0.1805 * lin[2]) / white[0];
  const y = (0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]) / white[1];
  const z = (0.0193 * lin[0] + 0.1192 * lin[1] + 0.9505 * lin[2]) / white[2];
  const [fx, fy, fz] = [x, y, z].map(cbrtF);
  return [(116 * fy - 16) * scale[0], 500 * (fx - fy) * scale[1] + offset, 200 * (fy - fz) * scale[2] + offset];
}
const yuv = (s: number[], w: number[], ku: number, kv: number, offset = 0.5) => {
  const y = w[0] * s[0] + w[1] * s[1] + w[2] * s[2];
  return [y * 255, ((s[2] - y) * ku + offset) * 255, ((s[0] - y) * kv + offset) * 255];
};
const R601 = [0.299, 0.587, 0.114];
const R709 = [0.2126, 0.7152, 0.0722];
const CANDIDATES: Record<number, Record<string, Coords>> = {
  1: {
    srgb: (s) => lab(s.map(srgbLinear)),
    raw: (s) => lab(s),
    rawGamma22: (s) => lab(s.map((v) => v ** 2.2)),
    rawHalfAB: (s) => lab(s, undefined, [2.55, 0.5, 0.5]),
    srgbHalfAB: (s) => lab(s.map(srgbLinear), undefined, [2.55, 0.5, 0.5]),
    rawAB255: (s) => lab(s, undefined, [2.55, 255 / 256, 255 / 256], 127.5),
    rawE: (s) => lab(s, [1, 1, 1]),
    srgbE: (s) => lab(s.map(srgbLinear), [1, 1, 1]),
  },
  2: {
    ycbcr601: (s) => yuv(s, R601, 0.564, 0.713),
    ycbcr709: (s) => yuv(s, R709, 0.5389, 0.635),
    yuv601: (s) => yuv(s, R601, 0.492, 0.877),
    yuv709: (s) => yuv(s, R709, 0.492, 0.877),
    yuv601raw: (s) => yuv(s, R601, 1, 1),
    yuv601half: (s) => yuv(s, R601, 0.5, 0.5),
  },
};

const ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 2 * x * x : 1 - 2 * (1 - x) * (1 - x));
const table = JSON.parse(readFileSync(join(ROOT, "fixtures", "keying.palette.json"), "utf8")).comps.keying_crange;
const cells = keyingCells().filter((c) => c.src[3] === 255);
const at = (v: unknown, f: number) => (Array.isArray(v) ? v[Math.min(f, v.length - 1)] : v) as number;
for (const space of [1, 2]) {
  for (const [name, coords] of Object.entries(CANDIDATES[space])) {
    let off = 0;
    let total = 0;
    for (let f = 0; f < table.frames; f++) {
      const image = frame("keying_crange", f);
      table.tiles.forEach((tile: { params: Record<string, unknown> }, q: number) => {
        const p = (i: number) => at(tile.params[`p${i}`], f);
        if (p(3) !== space) return;
        const min = [p(4), p(6), p(8)];
        const max = [p(5), p(7), p(9)];
        const fuzz = p(2);
        for (const cell of cells) {
          const c = coords(cell.src.slice(0, 3).map((v) => v / 255));
          let keyed = 1;
          for (let i = 0; i < 3; i++) {
            const d = Math.max(min[i] - c[i], c[i] - max[i]);
            keyed *= 1 - (fuzz > 0 ? ease(d / fuzz) : d > 0 ? 1 : 0);
          }
          const [x, y] = cellPoint(cell, q);
          total++;
          if (Math.abs((1 - keyed) * 255 - pixel(image, x, y)[3]) > 3) off++;
        }
      });
    }
    console.log(`space ${space} ${name.padEnd(12)} ${off} of ${total} cells off`);
  }
}
