// Searches how After Effects blends the hue modes (Hue, Saturation, Color, Luminosity) of a generator's pattern over
// translucent pixels: candidate inputs and compositions against generate2_checker_alpha's three half-opaque cells.
//
//   node scripts/check-generate2-hue.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

type V = [number, number, number];
const lum = (c: V) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const clip = (c: V): V => {
  const l = lum(c);
  const n = Math.min(...c);
  const x = Math.max(...c);
  let r = c;
  if (n < 0) r = r.map((v) => l + ((v - l) * l) / (l - n)) as V;
  if (x > 1) r = r.map((v) => l + ((v - l) * (1 - l)) / (x - l)) as V;
  return r;
};
const setLum = (c: V, l: number, doClip: boolean): V => {
  const d = l - lum(c);
  const r = c.map((v) => v + d) as V;
  return doClip ? clip(r) : r;
};
const sat = (c: V) => Math.max(...c) - Math.min(...c);
const setSat = (c: V, s: number): V => {
  const mx = Math.max(...c);
  const mn = Math.min(...c);
  return mx <= mn ? [0, 0, 0] : (c.map((v) => ((v - mn) * s) / (mx - mn)) as V);
};
const MODES: Record<number, (b: V, s: V, k: boolean) => V> = {
  14: (b, s, k) => setLum(setSat(s, sat(b)), lum(b), k),
  15: (b, s, k) => setLum(setSat(b, sat(s)), lum(b), k),
  16: (b, s, k) => setLum(s, lum(b), k),
  17: (b, s, k) => setLum(b, lum(s), k),
};

const n: V = [51 / 255, 153 / 255, 1];
const a = 0.8;
const ad = 0.5;
const CELLS: { x: number; y: number; b: V }[] = [
  { x: 30, y: 70, b: [26 / 255, 51 / 255, 153 / 255] },
  { x: 130, y: 30, b: [217 / 255, 51 / 255, 64 / 255] },
  { x: 70, y: 110, b: [242 / 255, 140 / 255, 26 / 255] },
];
const ae = (frame: number, x: number, y: number) => {
  const ref = readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", "generate2_checker_alpha", `frame_${String(frame).padStart(5, "0")}.tif`))));
  const o = (y * ref.width + x) * 4;
  return Array.from(ref.data.subarray(o, o + 3));
};

const mul = (c: V, k: number): V => c.map((v) => v * k) as V;
const add = (c: V, d: V): V => c.map((v, i) => v + d[i]) as V;
const mix = (c: V, d: V, t: number): V => c.map((v, i) => v + (d[i] - v) * t) as V;
const alpha = a + ad * (1 - a);

const INPUTS: Record<string, (b: V) => { bb: V; ss: V }> = {
  straight: (b) => ({ bb: b, ss: n }),
  premul: (b) => ({ bb: mul(b, ad), ss: mul(n, a) }),
  premulDst: (b) => ({ bb: mul(b, ad), ss: n }),
  premulSrc: (b) => ({ bb: b, ss: mul(n, a) }),
  overWhite: (b) => ({ bb: add(mul(b, ad), [1 - ad, 1 - ad, 1 - ad]), ss: add(mul(n, a), [1 - a, 1 - a, 1 - a]) }),
  overGrey: (b) => ({ bb: add(mul(b, ad), mul([1, 1, 1], 0.5 * (1 - ad))), ss: add(mul(n, a), mul([1, 1, 1], 0.5 * (1 - a))) }),
  srcOverDst: (b) => ({ bb: b, ss: mix(b, n, a) }),
  dstOverSrc: (b) => ({ bb: mix(n, b, ad), ss: n }),
  bothOver: (b) => ({ bb: mix(n, b, ad), ss: mix(b, n, a) }),
};
const OUTPUTS: Record<string, (b: V, B: V) => V> = {
  standard: (b, B) => mul(add(add(mul(n, (1 - ad) * a), mul(b, ad * (1 - a))), mul(B, a * ad)), 1 / alpha),
  plainB: (_b, B) => B,
  mixB: (b, B) => mix(b, B, a),
  overNeutralBlack: (_b, B) => mul(B, 1 / alpha),
  overNeutralWhite: (_b, B) => mul(add(B, mul([1, 1, 1], -(1 - alpha))), 1 / alpha),
  overNeutralGrey: (_b, B) => mul(add(B, mul([1, 1, 1], -0.5 * (1 - alpha))), 1 / alpha),
  patternOverMix: (b, B) => mul(add(mul(n, (1 - ad) * a), mul(mix(b, B, a), ad)), 1 / alpha),
};

const rows: { key: string; err: number; worst: string }[] = [];
for (const [iname, input] of Object.entries(INPUTS)) {
  for (const [oname, output] of Object.entries(OUTPUTS)) {
    for (const k of [true, false]) {
      let err = 0;
      let worst = "";
      for (const mode of [14, 15, 16, 17]) {
        for (const cell of CELLS) {
          const { bb, ss } = input(cell.b);
          const out = output(cell.b, MODES[mode](bb, ss, k)).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
          const ref = ae(mode, cell.x, cell.y);
          const e = Math.max(...out.map((v, i) => Math.abs(v - ref[i])));
          if (e > err) {
            err = e;
            worst = `mode ${mode} (${cell.x},${cell.y}) ours ${out.join(",")} ae ${ref.join(",")}`;
          }
        }
      }
      rows.push({ key: `${iname} / ${oname} / clip ${k}`, err, worst });
    }
  }
}
for (const r of rows.sort((x, y) => x.err - y.err).slice(0, 8)) console.log(`${r.key.padEnd(44)} worst ${r.err}  ${r.worst}`);
