// Black-box probing of the keying fixtures: prints, for the opaque palette cells of one quadrant of a keying comp,
// a quantity of the source colour (a distance to a key, a luma...) next to After Effects' output, sorted by it.
//
//   node scripts/check-keying-probe.ts <comp> <frame> <quadrant> <quantity> [key r,g,b (0-255)] [--all]
//
// Quantities: rgb (Euclidean distance to the key / sqrt 3), hue, chroma, luma, max (largest channel difference).
import { linearKeyDistance, luma, MatchColors } from "../src/render/effects/keyingMath.ts";
import { cellPoint, frame, keyingCells, pixel } from "./check-keying-cells.ts";

const [comp, n, quadrant, quantity, keyArg] = process.argv.slice(2);
const key = (keyArg ?? "0,0,0").split(",").map((v) => Number(v) / 255);
const image = frame(comp, Number(n));
const measure: Record<string, (s: number[]) => number> = {
  rgb: (s) => linearKeyDistance(s, key, MatchColors.RGB),
  hue: (s) => linearKeyDistance(s, key, MatchColors.HUE),
  chroma: (s) => linearKeyDistance(s, key, MatchColors.CHROMA),
  luma: (s) => luma(s),
  max: (s) => Math.max(...s.map((v, i) => Math.abs(v - key[i]))),
};
const rows = keyingCells()
  .filter((c) => c.src[3] === 255)
  .map((cell) => {
    const s = cell.src.slice(0, 3).map((v) => v / 255);
    const [x, y] = cellPoint(cell, Number(quadrant));
    return { cell, q: measure[quantity](s), out: pixel(image, x, y) };
  })
  .sort((a, b) => a.q - b.q);
if (process.argv.includes("--fit")) {
  // m = (q^2 - T^2) / K is linear in q^2: least squares over the partly keyed opaque cells (q in 0-255 units).
  const pts = rows.filter((r) => r.out[3] === 255 && r.out[0] > 3 && r.out[0] < 252).map((r) => [(r.q * 255) ** 2, r.out[0] / 255]);
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const slope = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const ramp = 1 / slope;
  const T2 = mx - my * ramp;
  const errors = pts.map(([q2, m]) => Math.abs(((q2 - T2) / ramp - m) * 255)).sort((a, b) => a - b);
  console.log(`fit: T=${Math.sqrt(T2).toFixed(3)} K=${ramp.toFixed(1)} n=${pts.length} p95 ${errors[Math.floor(errors.length * 0.95)].toFixed(2)} worst ${errors[errors.length - 1].toFixed(2)}/255`);
  process.exit(0);
}
const all = process.argv.includes("--all");
let last = "";
for (const r of rows) {
  const line = `${r.q.toFixed(4)} ${r.cell.src.slice(0, 3).join(",").padEnd(12)} -> ${r.out.map((v) => Math.round(v)).join(",")}`;
  const sig = r.out.map((v) => Math.round(v)).join(",");
  if (!all && sig === last && (sig.endsWith(",0") || sig.endsWith(",255"))) continue;
  last = sig;
  console.log(line);
}
