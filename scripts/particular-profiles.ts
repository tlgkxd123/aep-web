// Radial profiles of isolated particles in a Particular reference frame (and in our render dumped by
// particular-stats.ts): brightness above the background at distances 0..R from each blob's peak,
// for blobs with no other blob within 2R. Grouped by peak brightness.
//
//   node scripts/particular-profiles.ts <comp> <frame> [R=16]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [comp, frameArg, rArg = "16"] = process.argv.slice(2);
const frame = Number(frameArg);
const R = Number(rArg);
const BG = [31, 41, 77];

function excess(data: Uint8Array, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    const a = data[p * 4 + 3] / 255;
    let v = 0;
    for (let c = 0; c < 3; c++) v = Math.max(v, data[p * 4 + c] * a - BG[c]);
    out[p] = v;
  }
  return out;
}

function profiles(label: string, v: Float32Array, width: number, height: number) {
  if (process.argv.includes("--center")) {
    const cx = width >> 1;
    const cy = height >> 1;
    const row = Array.from({ length: R + 1 }, (_, d) => v[cy * width + cx + d]);
    console.log(`${label} from the centre: ${row.map((m) => m.toFixed(0).padStart(4)).join("")}`);
    return;
  }
  // Local maxima above 10 that are the brightest within R.
  const peaks: [number, number, number][] = [];
  for (let y = R; y < height - R; y++) {
    for (let x = R; x < width - R; x++) {
      const c = v[y * width + x];
      if (c <= 10) continue;
      let best = true;
      for (let dy = -R; dy <= R && best; dy++) for (let dx = -R; dx <= R && best; dx++) if ((dx || dy) && v[(y + dy) * width + x + dx] > c) best = false;
      if (best) peaks.push([x, y, c]);
    }
  }
  const isolated = peaks.filter(([x, y]) => !peaks.some(([x2, y2]) => (x2 !== x || y2 !== y) && Math.hypot(x2 - x, y2 - y) < 2 * R));
  const groups = new Map<string, number[][]>();
  // Along the rows and along the columns through each peak: motion blur stretches one way.
  const axisX = new Array(R + 1).fill(0);
  const axisY = new Array(R + 1).fill(0);
  for (const [x, y] of isolated) {
    for (let d = 0; d <= R; d++) {
      axisX[d] += (v[y * width + x + d] + v[y * width + x - d]) / 2 / isolated.length;
      axisY[d] += (v[(y + d) * width + x] + v[(y - d) * width + x]) / 2 / isolated.length;
    }
  }
  console.log(`  along x: ${axisX.map((m) => m.toFixed(0).padStart(4)).join("")}`);
  console.log(`  along y: ${axisY.map((m) => m.toFixed(0).padStart(4)).join("")}`);
  for (const [x, y, c] of isolated) {
    const ring = new Array(R + 1).fill(0);
    const count = new Array(R + 1).fill(0);
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const d = Math.round(Math.hypot(dx, dy));
        if (d > R) continue;
        ring[d] += v[(y + dy) * width + x + dx];
        count[d]++;
      }
    }
    const key = c < 40 ? "peak <40" : c < 100 ? "peak 40-100" : c < 180 ? "peak 100-180" : "peak 180+";
    const list = groups.get(key) ?? [];
    list.push(ring.map((s, i) => s / count[i]));
    groups.set(key, list);
  }
  console.log(`${label}: ${isolated.length} isolated of ${peaks.length}`);
  for (const key of ["peak <40", "peak 40-100", "peak 100-180", "peak 180+"]) {
    const list = groups.get(key);
    if (!list) continue;
    const mean = list[0].map((_, i) => list.reduce((s, p) => s + p[i], 0) / list.length);
    console.log(`  ${key.padEnd(13)} n=${String(list.length).padStart(3)}: ${mean.map((m) => m.toFixed(0).padStart(4)).join("")}`);
  }
}

const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
profiles("ref ", excess(ref.data, ref.width * ref.height), ref.width, ref.height);
const dir = join(ROOT, "probe", "particular", "root", "ours");
const dump = readdirSync(dir).find((f) => f.startsWith(`${comp}_f${frame}_`));
if (dump) profiles("ours", excess(new Uint8Array(readFileSync(join(dir, dump))), ref.width * ref.height), ref.width, ref.height);
