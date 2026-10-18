// Fits a homography from comp points to card points to a distort2 frame (After Effects' reference, or ours with
// --ours, written by `pixel-report.ts --dump`), read from the card's red (column) and green (row) ramps at opaque
// pixels with opaque neighbours, and prints where it puts the card's corners and its rms residual.
//
//   node scripts/check-distort2-homography.ts <comp> <frame> [--ours]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg] = process.argv.slice(2);
const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, Number(frameArg)))));
let data = ref.data;
if (process.argv.includes("--ours")) {
  const file = readdirSync(join(ROOT, "ours")).find((f) => f.startsWith(`${comp}_f${frameArg}_`) && f.endsWith(".rgba"));
  if (!file) throw new Error("no dump");
  data = new Uint8Array(readFileSync(join(ROOT, "ours", file)));
}
const { width, height } = ref;
const points: [number, number, number, number][] = [];
for (let y = 1; y < height - 1; y++) {
  for (let x = 1; x < width - 1; x++) {
    const i = (y * width + x) * 4;
    if (![i, i - 4, i + 4, i - width * 4, i + width * 4].every((j) => data[j + 3] === 255)) continue;
    points.push([x + 0.5, y + 0.5, (data[i] * 120) / 255, (data[i + 1] * 90) / 255]);
  }
}

function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[pivot][c])) pivot = r;
    [a[c], a[pivot]] = [a[pivot], a[c]];
    [b[c], b[pivot]] = [b[pivot], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / a[c][c];
      for (let k = c; k < n; k++) a[r][k] -= f * a[c][k];
      b[r] -= f * b[c];
    }
  }
  const out = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= a[r][k] * out[k];
    out[r] = s / a[r][r];
  }
  return out;
}

// Source = (h0 x + h1 y + h2, h3 x + h4 y + h5) / (h6 x + h7 y + 1), refined by Gauss-Newton from the linear fit.
let h = (() => {
  const ata = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const atb = new Array(8).fill(0);
  for (const [x, y, u, v] of points) {
    for (const [row, t] of [
      [[x, y, 1, 0, 0, 0, -u * x, -u * y], u],
      [[0, 0, 0, x, y, 1, -v * x, -v * y], v],
    ] as [number[], number][]) {
      for (let r = 0; r < 8; r++) {
        atb[r] += row[r] * t;
        for (let c = 0; c < 8; c++) ata[r][c] += row[r] * row[c];
      }
    }
  }
  return solve(ata, atb);
})();
const apply = (g: number[], x: number, y: number) => {
  const w = g[6] * x + g[7] * y + 1;
  return [(g[0] * x + g[1] * y + g[2]) / w, (g[3] * x + g[4] * y + g[5]) / w];
};
for (let iteration = 0; iteration < 5; iteration++) {
  const ata = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const atb = new Array(8).fill(0);
  for (const [x, y, u, v] of points) {
    const w = h[6] * x + h[7] * y + 1;
    const [pu, pv] = apply(h, x, y);
    const ju = [x / w, y / w, 1 / w, 0, 0, 0, (-pu * x) / w, (-pu * y) / w];
    const jv = [0, 0, 0, x / w, y / w, 1 / w, (-pv * x) / w, (-pv * y) / w];
    for (const [j, e] of [
      [ju, u - pu],
      [jv, v - pv],
    ] as [number[], number][]) {
      for (let r = 0; r < 8; r++) {
        atb[r] += j[r] * e;
        for (let c = 0; c < 8; c++) ata[r][c] += j[r] * j[c];
      }
    }
  }
  const step = solve(ata, atb);
  h = h.map((v, k) => v + step[k]);
}
let rms = 0;
for (const [x, y, u, v] of points) {
  const [pu, pv] = apply(h, x, y);
  rms += (u - pu) ** 2 + (v - pv) ** 2;
}
console.log(`points ${points.length}, rms ${Math.sqrt(rms / points.length).toFixed(3)}`);
function invert(u: number, v: number): number[] {
  let [x, y] = [80, 60];
  for (let k = 0; k < 50; k++) {
    const [pu, pv] = apply(h, x, y);
    const [ax, ay] = apply(h, x + 1e-3, y);
    const [bx, by] = apply(h, x, y + 1e-3);
    const j = [(ax - pu) / 1e-3, (bx - pu) / 1e-3, (ay - pv) / 1e-3, (by - pv) / 1e-3];
    const det = j[0] * j[3] - j[1] * j[2];
    const [eu, ev] = [u - pu, v - pv];
    x += (j[3] * eu - j[1] * ev) / det;
    y += (-j[2] * eu + j[0] * ev) / det;
  }
  return [x - 20, y - 15];
}
for (const [u, v] of [
  [0, 0],
  [120, 0],
  [0, 90],
  [120, 90],
]) {
  const [x, y] = invert(u, v);
  console.log(`card (${u}, ${v}) -> layer (${x.toFixed(3)}, ${y.toFixed(3)})`);
}
