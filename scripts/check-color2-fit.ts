// Fits Photo Filter's colour space against the color2 probe: for its frames without
// Preserve Luminosity, the filter (mixed with white by Density in linear light) scales the
// image's linear colour in a space S (white-normalised); each candidate S is scored by its
// worst cell.
//
//   node scripts/check-color2-fit.ts
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff, type Image } from "./lib/tiff.ts";

type M = number[][];
const compArg = process.argv.indexOf("--comp");
const COMP = compArg > 0 ? process.argv[compArg + 1] : "color2_probe";
const read = (f: number) => readTiff(new Uint8Array(readFileSync(framePath(COMP, f))));
const cell = (img: Image, k: number) => {
  const o = (((k >> 4) * 8 + 4) * img.width + (k % 16) * 8 + 4) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};
const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const enc = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const mul = (m: M, v: number[]) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const matMul = (a: M, b: M): M => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
function inv(m: M): M {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}
const XYZ: M = [
  [0.4124, 0.3576, 0.1805],
  [0.2126, 0.7152, 0.0722],
  [0.0193, 0.1192, 0.9505],
];
const BRADFORD: M = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];
const HPE: M = [
  [0.38971, 0.68898, -0.07868],
  [-0.22981, 1.1834, 0.04641],
  [0, 0, 1],
];
const CAT02: M = [
  [0.7328, 0.4296, -0.1624],
  [-0.7036, 1.6975, 0.0061],
  [0.003, 0.0136, 0.9834],
];
const SPACES: Record<string, M> = {
  rgb: [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ],
  xyz: XYZ,
  xyzD50: [
    [0.4361, 0.3851, 0.1431],
    [0.2225, 0.7169, 0.0606],
    [0.0139, 0.0971, 0.7141],
  ],
  xyz709exact: [
    [0.412391, 0.357584, 0.180481],
    [0.212639, 0.715169, 0.072192],
    [0.019331, 0.119195, 0.950532],
  ],
  bradford: matMul(BRADFORD, XYZ),
  hpe: matMul(HPE, XYZ),
  cat02: matMul(CAT02, XYZ),
};
const CASES: [number, number[], number][] = [
  [32, [236, 138, 0], 0.25],
  [34, [51, 128, 255], 0.6],
  [35, [255, 0, 0], 1],
  [39, [172, 122, 51], 0.7],
];
const src = read(0);
const D50: M = SPACES.xyzD50;
const D50i = inv(D50);
const WHITE = mul(D50, [1, 1, 1]);
const fLab = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fLabInv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
const toLab = (x: number[]) => {
  const [fx, fy, fz] = x.map((v, i) => fLab(v / WHITE[i]));
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};
const fromLab = ([L, a, b]: number[]) => {
  const fy = (L + 16) / 116;
  return [fy + a / 500, fy, fy - b / 200].map((f, i) => fLabInv(f) * WHITE[i]);
};
const PRESERVE: [number, number[], number][] = [
  [31, [236, 138, 0], 0.25],
  [33, [51, 128, 255], 0.6],
  [36, [255, 0, 0], 1],
  [37, [0, 34, 205], 0.5],
  [38, [0, 193, 177], 0.4],
];
const setLum = (o: number[], f: number[], w: number[], clampFirst: boolean) => {
  const e = (x: number[]) => mul(D50i, x).map((v) => enc(clampFirst ? Math.min(1, Math.max(0, v)) : Math.max(0, v)));
  const oc = e(o);
  let c = e(f);
  const lum = (x: number[]) => w[0] * x[0] + w[1] * x[1] + w[2] * x[2];
  const d = lum(oc) - lum(c);
  c = c.map((v) => v + d);
  const l = lum(c);
  const n = Math.min(...c);
  const x = Math.max(...c);
  if (n < 0) c = c.map((v) => l + ((v - l) * l) / (l - n));
  if (x > 1) c = c.map((v) => l + ((v - l) * (1 - l)) / (x - l));
  return mul(D50, c.map(lin));
};
const VARIANTS: Record<string, (orig: number[], filtered: number[]) => number[]> = {
  setLum601: (o, f) => setLum(o, f, [0.299, 0.587, 0.114], true),
  setLumW3C: (o, f) => setLum(o, f, [0.3, 0.59, 0.11], true),
  setLum709: (o, f) => setLum(o, f, [0.2126, 0.7152, 0.0722], true),
  setLumD50Y: (o, f) => setLum(o, f, [0.2225, 0.7169, 0.0606], true),
  setLumEq: (o, f) => setLum(o, f, [1 / 3, 1 / 3, 1 / 3], true),
  labL: (o, f) => {
    const lf = toLab(f);
    return fromLab([toLab(o)[0], lf[1], lf[2]]);
  },
  scaleY: (o, f) => f.map((v) => (f[1] > 0 ? (v * o[1]) / f[1] : 0)),
};
const predict = (f: number, color: number[], d: number, preserve: boolean) => {
  const out = read(f);
  const filt = color.map((c) => 1 - d + d * lin(c / 255));
  const sw = mul(D50, [1, 1, 1]);
  const sf = mul(D50, filt).map((v, i) => v / sw[i]);
  let sum = 0;
  let worst = 0;
  for (let k = 0; k < 256; k++) {
    const o = mul(D50, cell(src, k).map((v) => lin(v / 255)));
    const fo = o.map((v, i) => v * sf[i]);
    const r = mul(D50i, preserve ? setLum(o, fo, [0.3, 0.59, 0.11], true) : fo).map((v) =>
      Math.round(enc(Math.min(1, Math.max(0, v))) * 255),
    );
    const ae = cell(out, k);
    if (process.argv.includes("--cells") && r.some((v, i) => Math.abs(v - ae[i]) > 3)) {
      console.log(`  ${cell(src, k)} ae ${ae} ours ${r}`);
    }
    for (let i = 0; i < 3; i++) {
      sum += Math.abs(r[i] - ae[i]);
      worst = Math.max(worst, Math.abs(r[i] - ae[i]));
    }
  }
  return { sum, worst };
};
const xyzArg = process.argv.indexOf("--search-xyz");
if (xyzArg > 0) {
  // The filter as XYZ scale factors (relative to white), fitted directly.
  const f = Number(process.argv[xyzArg + 1]);
  const out = read(f);
  const err = (s: number[]) => {
    let sum = 0;
    let worst = 0;
    for (let k = 0; k < 256; k++) {
      const o = mul(D50, cell(src, k).map((v) => lin(v / 255)));
      const r = mul(D50i, o.map((v, i) => v * s[i])).map((v) => Math.round(enc(Math.min(1, Math.max(0, v))) * 255));
      const ae = cell(out, k);
      for (let i = 0; i < 3; i++) {
        sum += Math.abs(r[i] - ae[i]);
        worst = Math.max(worst, Math.abs(r[i] - ae[i]));
      }
    }
    return { sum, worst };
  };
  let best = [0.5, 0.5, 0.5];
  let bestSum = err(best).sum;
  for (const step of [0.1, 0.03, 0.01, 0.003, 0.001, 0.0003]) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < 3; i++)
        for (const d of [-step, step]) {
          const c = best.slice();
          c[i] = Math.max(0, c[i] + d);
          const e = err(c).sum;
          if (e < bestSum) [best, bestSum, improved] = [c, e, true];
        }
    }
  }
  const asRgb = mul(D50i, best.map((v, i) => v * WHITE[i]));
  console.log(`frame ${f}: xyz scale ${best.map((v) => v.toFixed(4))} sum ${bestSum} worst ${err(best).worst}; as linear rgb ${asRgb.map((v) => v.toFixed(4))}`);
  process.exit(0);
}
const searchArg = process.argv.indexOf("--search");
if (searchArg > 0) {
  const [f, r, g, b, d, p] = process.argv[searchArg + 1].split(",").map(Number);
  let best = [r, g, b];
  let bestSum = predict(f, best, d, p === 1).sum;
  for (const step of [16, 8, 4, 2, 1]) {
    let improved = true;
    while (improved) {
      improved = false;
      for (let i = 0; i < 3; i++) {
        for (const s of [-step, step]) {
          const c = best.slice();
          c[i] = Math.min(255, Math.max(0, c[i] + s));
          const e = predict(f, c, d, p === 1).sum;
          if (e < bestSum) [best, bestSum, improved] = [c, e, true];
        }
      }
    }
  }
  console.log(`frame ${f}: color ${best} sum ${bestSum} worst ${predict(f, best, d, p === 1).worst}`);
  process.exit(0);
}
for (const [name, variant] of Object.entries(VARIANTS)) {
  const report: string[] = [];
  for (const [f, color, d] of PRESERVE) {
    const out = read(f);
    const filt = color.map((c) => 1 - d + d * lin(c / 255));
    const sw = mul(D50, [1, 1, 1]);
    const sf = mul(D50, filt).map((v, i) => v / sw[i]);
    let fw = 0;
    let over = 0;
    let worstCell = "";
    for (let k = 0; k < 256; k++) {
      const o = mul(D50, cell(src, k).map((v) => lin(v / 255)));
      const r = mul(D50i, variant(o, o.map((v, i) => v * sf[i]))).map((v) => Math.round(enc(Math.min(1, Math.max(0, v))) * 255));
      const ae = cell(out, k);
      const e = Math.max(...r.map((v, i) => Math.abs(v - ae[i])));
      if (e > fw) [fw, worstCell] = [e, `${cell(src, k)} ae ${ae} ours ${r}`];
      if (e > 3) over++;
    }
    report.push(`@${f} ${fw}/${over} (${worstCell})`);
  }
  console.log(`preserve ${name}: ${report.join("  ")}`);
}
for (const [name, m] of Object.entries(SPACES)) {
  const mi = inv(m);
  let worst = 0;
  const report: string[] = [];
  for (const [f, color, d] of CASES) {
    const out = read(f);
    const filt = color.map((c) => 1 - d + d * lin(c / 255));
    const sw = mul(m, [1, 1, 1]);
    const sf = mul(m, filt).map((v, i) => v / sw[i]);
    let fw = 0;
    for (let k = 0; k < 256; k++) {
      const s = mul(m, cell(src, k).map((v) => lin(v / 255)));
      const r = mul(mi, s.map((v, i) => v * sf[i])).map((v) => Math.round(enc(Math.min(1, Math.max(0, v))) * 255));
      const ae = cell(out, k);
      const e = Math.max(...r.map((v, i) => Math.abs(v - ae[i])));
      if (e > fw) fw = e;
    }
    report.push(`@${f} ${fw}`);
    worst = Math.max(worst, fw);
  }
  console.log(`${name.padEnd(9)} worst ${worst}  ${report.join("  ")}`);
}
