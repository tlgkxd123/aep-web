// Tests whether a channel suite frame applies one curve to each channel on its own: reads the curve from row 0's
// greys, applies it (interpolated) to every opaque cell's channels and prints the worst misses; with --fit <name>,
// also prints the named candidate's error against the greys.
//
//   node scripts/check-channel-curve.ts <comp> <frame> [--fit name] [--k value]
import { cardCells, refPixel } from "./check-channel-probe.ts";

const [comp, frameArg] = process.argv.slice(2);
const px = refPixel(comp, Number(frameArg));
const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const cells = cardCells("a");
const greys = cells.filter((c) => c.j === 0).map((c) => [c.rgba[0] / 255, px(c.i * 10 + 5, 5)[0] / 255]);
const curve = (x: number) => {
  for (let i = 1; i < greys.length; i++)
    if (x <= greys[i][0]) {
      const [x0, y0] = greys[i - 1];
      const [x1, y1] = greys[i];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  return greys[greys.length - 1][1];
};
let worst = 0;
const misses: string[] = [];
for (const cell of cells) {
  if (cell.j === 0 || cell.rgba[3] !== 255) continue;
  const out = px(cell.i * 10 + 5, cell.j * 10 + 5);
  for (let c = 0; c < 3; c++) {
    const e = Math.abs(curve(cell.rgba[c] / 255) * 255 - out[c]);
    if (e > worst) worst = e;
    if (e > 3 && misses.length < 8) misses.push(`(${cell.rgba.slice(0, 3).join(",")}) -> (${out.slice(0, 3).join(",")}) channel ${c}`);
  }
}
console.log(`per-channel curve from the greys: worst ${worst.toFixed(1)}  ${misses.join("; ")}`);

const k = Number(arg("--k") ?? 1);
const candidates: Record<string, (x: number) => number> = {
  sqrt: (x) => x / Math.sqrt(1 + k * x * x),
  rational: (x) => x / (1 + k * x * x),
  tanh: (x) => Math.tanh(k * x) / k,
  reinhard: (x) => x / (1 + k * x),
  power: (x) => x / Math.pow(1 + Math.pow(x, k), 1 / k),
};
if (process.argv.includes("--implied")) {
  // For effects that scale a pixel's channels together: the grey level whose curve gives each cell's scale (from its
  // largest channel), least-squares fitted as a weighted sum of the cell's channels.
  const inverse = (ratio: number) => {
    let lo = 0;
    let hi = 1;
    for (let n = 0; n < 40; n++) {
      const mid = (lo + hi) / 2;
      if (curve(mid) / mid > ratio) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  const rows: number[][] = [];
  const ys: number[] = [];
  for (const cell of cells) {
    if (cell.j === 0 || cell.rgba[3] !== 255) continue;
    const out = px(cell.i * 10 + 5, cell.j * 10 + 5);
    const c = [0, 1, 2].reduce((m, i) => (cell.rgba[i] > cell.rgba[m] ? i : m), 0);
    if (cell.rgba[c] < 100) continue;
    rows.push(cell.rgba.slice(0, 3).map((v) => v / 255));
    ys.push(inverse(out[c] / cell.rgba[c]));
  }
  const ata = [0, 1, 2].map((i) => [0, 1, 2].map((j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
  const aty = [0, 1, 2].map((i) => rows.reduce((s, r, n) => s + r[i] * ys[n], 0));
  for (let i = 0; i < 3; i++)
    for (let m = i + 1; m < 3; m++) {
      const f = ata[m][i] / ata[i][i];
      for (let j = i; j < 3; j++) ata[m][j] -= f * ata[i][j];
      aty[m] -= f * aty[i];
    }
  const w = [0, 0, 0];
  for (let i = 2; i >= 0; i--) w[i] = (aty[i] - [0, 1, 2].slice(i + 1).reduce((s, j) => s + ata[i][j] * w[j], 0)) / ata[i][i];
  for (let n = 0; n < Math.min(12, rows.length); n++) console.log(`  ${rows[n].map((v) => (v * 255).toFixed(0)).join(",")} level ${ys[n].toFixed(3)}`);
  const worstL = Math.max(...rows.map((r, n) => Math.abs(r[0] * w[0] + r[1] * w[1] + r[2] * w[2] - ys[n])));
  console.log(`implied level = ${w.map((v) => v.toFixed(4)).join(" r + ")} b-weights, worst ${worstL.toFixed(4)} over ${rows.length}`);
}
const name = arg("--fit");
if (name) {
  const f = candidates[name];
  const errors = greys.map(([x, y]) => ((f(x) - y) * 255).toFixed(1));
  console.log(`${name} k=${k}: ${errors.join(" ")}`);
}
