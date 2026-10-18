// Fits Light Sweep's edge light on generate2_light_sweep_edge2 (grey 0.1 inside a hexagon with a rectangular
// hole, white light added, no band in frames 0-5). The model: E = Edge Intensity / 50 x (1 - the alpha averaged
// over a kernel of size w T, at s T pixels towards the light u = (sin dir, -cos dir)) x alpha, added premultiplied.
//
//   node scripts/check-generate2-edgefit.ts [--frames 0,1] [--s a,b] [--w a,b] [--kernel box|rotbox|disc] [--png]
//   node scripts/check-generate2-edgefit.ts --profile <frame> [--s a] [--w b] [--kernel k]
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng } from "./lib/png.ts";
import { ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const W = 160;
const H = 120;
const SS = 4;
const HEXAGON = [[40, 30], [95, 18], [135, 50], [120, 100], [60, 105], [25, 70]];
const HOLE = [[65, 52], [65, 72], [95, 72], [95, 52]];
const FRAMES = [
  { dir: 0, edge: 50, t: 1 },
  { dir: 45, edge: 50, t: 2 },
  { dir: 90, edge: 25, t: 4 },
  { dir: -30, edge: 50, t: 8 },
  { dir: 160, edge: 40, t: 3 },
  { dir: 0, edge: 50, t: 6 },
];

const argv = process.argv;
const list = (name: string, fallback: number[]) => (argv.includes(name) ? argv[argv.indexOf(name) + 1].split(",").map(Number) : fallback);
const word = (name: string, fallback: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const kernel = word("--kernel", "box");
/** Degrees added to the light's direction. */
const ROT = Number(word("--rot", "0"));
/** The rotated box's width across the light over its length along it. */
const ASPECT = Number(word("--aspect", "1"));

function insidePolygon(x: number, y: number, poly: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const covered = (x: number, y: number) => insidePolygon(x, y, HEXAGON) && !(x > 65 && x < 95 && y > 52 && y < 72);

// Supersampled coverage and its summed-area table (with a margin for the shifted kernels).
const M = 40;
const GW = (W + 2 * M) * SS;
const GH = (H + 2 * M) * SS;
const grid = new Uint8Array(GW * GH);
const sat = new Float64Array((GW + 1) * (GH + 1));
for (let gy = 0; gy < GH; gy++) {
  let row = 0;
  for (let gx = 0; gx < GW; gx++) {
    const v = covered((gx + 0.5) / SS - M, (gy + 0.5) / SS - M) ? 1 : 0;
    grid[gy * GW + gx] = v;
    row += v;
    sat[(gy + 1) * (GW + 1) + gx + 1] = sat[gy * (GW + 1) + gx + 1] + row;
  }
}
function boxMean(x0: number, y0: number, x1: number, y1: number): number {
  const c = (v: number, n: number) => Math.max(0, Math.min(n, Math.round((v + M) * SS)));
  const [gx0, gx1, gy0, gy1] = [c(x0, GW), c(x1, GW), c(y0, GH), c(y1, GH)];
  const area = (gx1 - gx0) * (gy1 - gy0);
  if (area <= 0) return 0;
  return (sat[gy1 * (GW + 1) + gx1] - sat[gy0 * (GW + 1) + gx1] - sat[gy1 * (GW + 1) + gx0] + sat[gy0 * (GW + 1) + gx0]) / area;
}
const sampleGrid = (x: number, y: number) => {
  const gx = Math.floor((x + M) * SS);
  const gy = Math.floor((y + M) * SS);
  return gx < 0 || gy < 0 || gx >= GW || gy >= GH ? 0 : grid[gy * GW + gx];
};
/** The mean coverage of a kernel of size `size` centred on (cx, cy), u the light direction. */
function kernelMean(cx: number, cy: number, size: number, u: number[]): number {
  const half = size / 2;
  if (kernel === "box") return boxMean(cx - half, cy - half, cx + half, cy + half);
  let sum = 0;
  let n = 0;
  const steps = Math.max(4, Math.round(size * 2));
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      const a = ((i + 0.5) / steps - 0.5) * size;
      const b = ((j + 0.5) / steps - 0.5) * size * ASPECT;
      if (kernel === "disc" && a * a + b * b > half * half) continue;
      const [x, y] = kernel === "rotbox" ? [cx + a * u[0] - b * u[1], cy + a * u[1] + b * u[0]] : [cx + a, cy + b];
      sum += sampleGrid(x, y);
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** The edge light before the alpha, at pixel (x, y) of a frame. */
function lightAt(x: number, y: number, f: number, s: number, w: number): number {
  const { dir, edge, t } = FRAMES[f];
  const th = ((dir + ROT) * Math.PI) / 180;
  const u = [Math.sin(th), -Math.cos(th)];
  const b = kernelMean(x + 0.5 + s * t * u[0], y + 0.5 + s * t * u[1], w * t, u);
  return (edge / 50) * Math.max(0, 1 - b);
}
const greenOf = (a: number, light: number) => Math.round((Math.min(a, 0.1 * a + light * a * a) + (41 / 255) * (1 - a)) * 255);
const loadRef = (f: number) => readTiff(new Uint8Array(readFileSync(join(ROOT, "frames", "generate2_light_sweep_edge2", `frame_${String(f).padStart(5, "0")}.tif`))));

if (argv.includes("--profile")) {
  const f = Number(word("--profile", "0"));
  const [s] = list("--s", [1]);
  const [w] = list("--w", [2]);
  const ref = loadRef(f);
  const { dir, edge } = FRAMES[f];
  const th = (dir * Math.PI) / 180;
  const u = [Math.sin(th), -Math.cos(th)];
  for (const [name, poly] of [["hex", HEXAGON], ["hole", HOLE]] as const) {
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i];
      const p1 = poly[(i + 1) % poly.length];
      const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
      const inward = [-(p1[1] - p0[1]) / len, (p1[0] - p0[0]) / len];
      const facing = -(inward[0] * u[0] + inward[1] * u[1]);
      const m = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      const cells: string[] = [];
      for (let k = 0; k < 16; k += 1) {
        const x = Math.floor(m[0] + inward[0] * (k + 0.5));
        const y = Math.floor(m[1] + inward[1] * (k + 0.5));
        const measured = (ref.data[(y * W + x) * 4 + 1] - 26) / 255 / (edge / 50);
        const model = lightAt(x, y, f, s, w) / (edge / 50);
        cells.push(`${measured.toFixed(2)}/${model.toFixed(2)}`);
      }
      console.log(`${name}${i} facing ${facing.toFixed(2)}  ${cells.join(" ")}`);
    }
  }
  process.exit(0);
}

const frames = list("--frames", [0, 1, 2, 3, 4, 5]);
const refs = frames.map(loadRef);
const results: { key: string; rms: number; worst: number; per: string }[] = [];
// With --png, the error of the (single) model per frame, red where ours is brighter, stacked into one image.
const errorMaps = argv.includes("--png") ? new Uint8Array(W * H * frames.length * 4).fill(255) : null;
for (const s of list("--s", [0.75, 1, 1.25])) {
  for (const w of list("--w", [1.5, 2, 2.5])) {
    let sq = 0;
    let count = 0;
    let worst = 0;
    const per: string[] = [];
    for (const [fi, f] of frames.entries()) {
      let fsq = 0;
      let fn = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const a = boxMean(x, y, x + 1, y + 1);
          if (a <= 0) continue;
          const g = greenOf(a, lightAt(x, y, f, s, w));
          const e = g - refs[fi].data[(y * W + x) * 4 + 1];
          if (errorMaps) {
            const o = ((fi * H + y) * W + x) * 4;
            errorMaps.set([Math.min(255, Math.max(0, 128 + 4 * e)), Math.min(255, Math.max(0, 128 - 4 * e)), g], o);
          }
          fsq += e * e;
          fn++;
          worst = Math.max(worst, Math.abs(e));
        }
      }
      sq += fsq;
      count += fn;
      per.push(`f${f} ${Math.sqrt(fsq / fn).toFixed(1)}`);
    }
    results.push({ key: `${kernel} s ${s} w ${w}`, rms: Math.sqrt(sq / count), worst, per: per.join(" ") });
  }
}
for (const r of results.sort((a, b) => a.rms - b.rms).slice(0, 8)) console.log(`${r.key}: rms ${r.rms.toFixed(2)} worst ${r.worst} | ${r.per}`);
if (errorMaps) {
  const Z = 4;
  const big = new Uint8Array(W * Z * H * frames.length * Z * 4);
  for (let y = 0; y < H * frames.length * Z; y++) {
    for (let x = 0; x < W * Z; x++) {
      const s = (Math.floor(y / Z) * W + Math.floor(x / Z)) * 4;
      big.set(errorMaps.subarray(s, s + 4), (y * W * Z + x) * 4);
    }
  }
  const path = join(tmpdir(), "g2sheets", "edgefit.png");
  writeFileSync(path, encodePng(W * Z, H * frames.length * Z, big));
  console.log(path);
}
