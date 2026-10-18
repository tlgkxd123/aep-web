// Linear Color Key, Using Chroma: for candidate chroma spaces, how many opaque palette cells a single threshold on the
// distance to the key misclassifies against AE's hard (softness 0) matte, and the threshold.
//
//   node scripts/check-keying-chroma.ts <comp> <frame> <quadrant> <key r,g,b 0-255>
import { rgbToHsl } from "../src/render/effects/keyingMath.ts";
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";

const [comp, n, quadrant, keyArg] = process.argv.slice(2);
const key = keyArg.split(",").map((v) => Number(v) / 255);
const image = frame(comp, Number(n));
const Y = ([r, g, b]: number[]) => 0.299 * r + 0.587 * g + 0.114 * b;
const polar = (h: number, s: number) => [s * Math.cos(2 * Math.PI * h), s * Math.sin(2 * Math.PI * h)];
const hsv = (c: number[]) => {
  const mx = Math.max(...c);
  const mn = Math.min(...c);
  return [rgbToHsl(c)[0], mx > 0 ? (mx - mn) / mx : 0, mx];
};
const spaces: Record<string, (c: number[]) => number[]> = {
  rgChroma: (c) => {
    const s = c[0] + c[1] + c[2];
    return s > 0 ? [c[0] / s, c[1] / s] : [1 / 3, 1 / 3];
  },
  uv: (c) => [c[2] - Y(c), c[0] - Y(c)],
  uvOverY: (c) => (Y(c) > 0 ? [(c[2] - Y(c)) / Y(c), (c[0] - Y(c)) / Y(c)] : [0, 0]),
  cbcr: (c) => [-0.168736 * c[0] - 0.331264 * c[1] + 0.5 * c[2], 0.5 * c[0] - 0.418688 * c[1] - 0.081312 * c[2]],
  hslPolar: (c) => polar(rgbToHsl(c)[0], rgbToHsl(c)[1]),
  hsvPolar: (c) => polar(hsv(c)[0], hsv(c)[1]),
  chromaPolar: (c) => polar(rgbToHsl(c)[0], Math.max(...c) - Math.min(...c)),
  overMax: (c) => (Math.max(...c) > 0 ? c.map((v) => v / Math.max(...c)) : [0, 0, 0]),
  minusMean: (c) => c.map((v) => v - (c[0] + c[1] + c[2]) / 3),
  minusY: (c) => c.map((v) => v - Y(c)),
  opponent: (c) => [c[0] - c[1], (c[0] + c[1]) / 2 - c[2]],
  hs: (c) => [rgbToHsl(c)[0], rgbToHsl(c)[1]],
};
const samples = keyingCells()
  .filter((c) => c.src[3] === 255)
  .map((cell) => {
    const [x, y] = cellPoint(cell, Number(quadrant));
    const out = pixel(image, x, y);
    return { c: cell.src.slice(0, 3).map((v) => v / 255), keyed: out[0] < 128, src: cell.src.slice(0, 3).join(",") };
  });
const lin = (rows: number[][]) => (c: number[]) => rows.map((r) => r[0] * c[0] + r[1] * c[1] + r[2] * c[2]);
Object.assign(spaces, {
  yuvUV: lin([[-0.14713, -0.28886, 0.436], [0.615, -0.51499, -0.10001]]),
  hexAB: lin([[1, -0.5, -0.5], [0, Math.sqrt(3) / 2, -Math.sqrt(3) / 2]]),
  rgbMinusG: lin([[1, -1, 0], [0, 1, -1]]),
  labAB: (c: number[]) => labAB(c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))),
  labABraw: (c: number[]) => labAB(c),
});
function labAB(l: number[]) {
  const X = (0.4124 * l[0] + 0.3576 * l[1] + 0.1805 * l[2]) / 0.95047;
  const Y = 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
  const Z = (0.0193 * l[0] + 0.1192 * l[1] + 0.9505 * l[2]) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [5 * (f(X) - f(Y)), 2 * (f(Y) - f(Z))];
}
if (process.argv.includes("--soft")) {
  // m = d^2 / K + b over the partly keyed cells: least squares per space.
  const soft = keyingCells()
    .filter((c) => c.src[3] === 255)
    .map((cell) => {
      const [x, y] = cellPoint(cell, Number(quadrant));
      return { c: cell.src.slice(0, 3).map((v) => v / 255), m: pixel(image, x, y)[0] / 255 };
    })
    .filter((s) => s.m > 0.02 && s.m < 0.98);
  for (const [name, f] of Object.entries(spaces)) {
    const k = f(key);
    const pts = soft.map((s) => [f(s.c).reduce((sum, v, i) => sum + (v - k[i]) ** 2, 0), s.m]);
    const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    const slope = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
    const b = my - slope * mx;
    const res = pts.map(([d2, m]) => Math.abs(d2 * slope + b - m) * 255).sort((a, c) => a - c);
    console.log(`${name.padEnd(12)} K=${(1 / slope).toFixed(4)} b=${b.toFixed(4)} p50 ${res[Math.floor(res.length / 2)].toFixed(2)} p95 ${res[Math.floor(res.length * 0.95)].toFixed(2)}`);
  }
  process.exit(0);
}
const results: [number, string][] = [];
for (const [name, f] of Object.entries(spaces)) {
  const k = f(key);
  const rows = samples.map((s) => ({ d: Math.hypot(...f(s.c).map((v, i) => v - k[i])), keyed: s.keyed })).sort((a, b) => a.d - b.d);
  // Threshold after index i: everything up to i keyed.
  let keptBelow = 0;
  let keyedAbove = rows.filter((r) => r.keyed).length;
  let best = keyedAbove;
  let at = 0;
  rows.forEach((r, i) => {
    if (r.keyed) keyedAbove--;
    else keptBelow++;
    if (keptBelow + keyedAbove < best) {
      best = keptBelow + keyedAbove;
      at = (r.d + (rows[i + 1]?.d ?? r.d)) / 2;
    }
  });
  results.push([best, `${name.padEnd(12)} misclassified ${best} at d=${at.toFixed(4)}`]);
}
for (const [, line] of results.sort((a, b) => a[0] - b[0])) console.log(line);
