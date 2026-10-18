// Searches formulations of the non-separable blending modes (luminance weights x saturation measure x clipping) against
// channel_solid_composite's Hue, Saturation, Color and Luminosity frames: the layer at Source Opacity 70 % over the solid
// (0.2, 0.6, 0.9) at Opacity 80 %, mixed as W3C compositing does. Prints each formulation's worst and mean error in
// premultiplied 8-bit units, best first.
//
//   node scripts/check-channel-hsl.ts [--mode hue|saturation|color|luminosity]
import { cardCells, refPixel } from "./check-channel-probe.ts";

type V = [number, number, number];
const FRAMES: Record<string, number> = { hue: 13, saturation: 14, color: 15, luminosity: 16 };
const only = process.argv.includes("--mode") ? process.argv[process.argv.indexOf("--mode") + 1] : undefined;
const sa = 0.7;
const da = 0.8;
const d: V = [0.2, 0.6, 0.9];

const WEIGHTS: Record<string, V> = { w3c: [0.3, 0.59, 0.11], r601: [0.299, 0.587, 0.114], r709: [0.2126, 0.7152, 0.0722], equal: [1 / 3, 1 / 3, 1 / 3] };
const MEASURES: Record<string, (c: V, w: V) => number> = {
  maxMin: (c) => Math.max(...c) - Math.min(...c),
  euclid: (c, w) => {
    const l = c[0] * w[0] + c[1] * w[1] + c[2] * w[2];
    return Math.hypot(c[0] - l, c[1] - l, c[2] - l);
  },
  hsl: (c) => {
    const hi = Math.max(...c);
    const lo = Math.min(...c);
    const den = 1 - Math.abs(hi + lo - 1);
    return den <= 1e-6 ? 0 : (hi - lo) / den;
  },
  hsv: (c) => (Math.max(...c) <= 0 ? 0 : (Math.max(...c) - Math.min(...c)) / Math.max(...c)),
};

function clip(c: V, l: number, w: V): V {
  const lo = Math.min(...c);
  const hi = Math.max(...c);
  let r = c;
  if (lo < 0) r = r.map((v) => l + ((v - l) * l) / (l - lo)) as V;
  if (hi > 1) r = r.map((v) => l + ((v - l) * (1 - l)) / (hi - l)) as V;
  void w;
  return r;
}

function blend(mode: string, b: V, s: V, w: V, measure: (c: V, w: V) => number, clipping: boolean): V {
  const lum = (c: V) => c[0] * w[0] + c[1] * w[1] + c[2] * w[2];
  const withChroma = (c: V, l: number, k: number): V => {
    const lc = lum(c);
    const r = c.map((v) => l + (v - lc) * k) as V;
    return clipping ? clip(r, l, w) : r;
  };
  const ratio = (to: V, from: V) => {
    const m = measure(from, w);
    return m <= 1e-6 ? 0 : measure(to, w) / m;
  };
  if (mode === "hue") return withChroma(s, lum(b), ratio(b, s));
  if (mode === "saturation") return withChroma(b, lum(b), ratio(s, b));
  if (mode === "color") return withChroma(s, lum(b), 1);
  return withChroma(b, lum(s), 1);
}

for (const mode of Object.keys(FRAMES)) {
  if (only && mode !== only) continue;
  const px = refPixel("channel_solid_composite", FRAMES[mode]);
  const results: [string, number, number][] = [];
  for (const [wName, w] of Object.entries(WEIGHTS))
    for (const [mName, measure] of Object.entries(MEASURES))
      for (const clipping of [true, false]) {
        let worst = 0;
        let sum = 0;
        let count = 0;
        for (const cell of cardCells("a")) {
          if (cell.rgba[3] !== 255) continue;
          const s = cell.rgba.slice(0, 3).map((v) => v / 255) as V;
          const out = px(cell.i * 10 + 5, cell.j * 10 + 5);
          const a = sa + da * (1 - sa);
          const B = blend(mode, d, s, w, measure, clipping);
          for (let k = 0; k < 3; k++) {
            const mine = Math.min(a, Math.max(0, (1 - da) * sa * s[k] + (1 - sa) * da * d[k] + sa * da * B[k]));
            const diff = Math.abs(mine - (out[k] / 255) * (out[3] / 255)) * 255;
            worst = Math.max(worst, diff);
            sum += diff;
            count++;
          }
        }
        results.push([`${wName} ${mName} ${clipping ? "clip" : "noclip"}`, worst, sum / count]);
      }
  results.sort((x, y) => x[2] - y[2]);
  console.log(`== ${mode}`);
  for (const [name, worst, mean] of results.slice(0, 6)) console.log(`${name.padEnd(28)} worst ${worst.toFixed(1).padStart(5)}  mean ${mean.toFixed(2)}`);
}
