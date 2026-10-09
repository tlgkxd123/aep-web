// Compares Particular frames with their After Effects references as statistics, since particle positions
// cannot match: pixels drawn over the background, total brightness above it, particles (connected blobs)
// with their area and peak, and how far from the comp centre they spread. Writes side-by-side sheets
// (reference | ours) to refs/probe/particular/.
//
//   node scripts/particular-stats.ts [--no-render] [--no-build] [--only comp@frame,...]
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePng } from "./lib/png.ts";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2);
const CASES = [
  ["fxextra_particular_white", 24],
  ["fxextra_particular_white", 96],
  ["fxextra_particular_real", 24],
  ["fxextra_particular_real", 96],
  ["fxextra_particular_blob", 12],
] as const;
const onlyArg = args.indexOf("--only");
const only = onlyArg >= 0 ? new Set(args[onlyArg + 1].split(",")) : undefined;
const cases = CASES.filter(([c, f]) => !only || only.has(`${c}@${f}`));
// These comps are kept out of the fxextra suite; they render from a refs root of their own.
const temp = join(ROOT, "probe", "particular", "root");
if (!args.includes("--no-render")) {
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(join(temp, "fixtures"), { recursive: true });
  copyFileSync(join(ROOT, "fixtures", "fxextra.aep"), join(temp, "fixtures", "fxextra.aep"));
  const comps = [...new Set(cases.map(([c]) => c))].map((comp) => ({ comp, frames: cases.filter(([c]) => c === comp).map(([, f]) => f) }));
  writeFileSync(join(temp, "fixtures", "particular.manifest.json"), JSON.stringify({ project: "fxextra.aep", comps }));
  for (const [comp, frame] of cases) {
    mkdirSync(join(temp, "frames", comp), { recursive: true });
    copyFileSync(framePath(comp, frame), join(temp, "frames", comp, `frame_${String(frame).padStart(5, "0")}.tif`));
  }
  const run = ["scripts/pixel-report.ts", "--suite", "particular", "--dump"];
  if (args.includes("--no-build")) run.push("--no-build");
  try {
    execFileSync(process.execPath, run, { encoding: "utf8", env: { ...process.env, AEP_REFS: temp } });
  } catch {
    // The pixel report fails these frames; only the dumps are needed.
  }
}

const BG = [31, 41, 77];
const DRAWN = 3;
const BLOB = 10;

interface Stats {
  drawn: number;
  energy: number;
  blobs: number;
  areas: number[];
  peaks: number[];
  radii: number[];
}

/** Brightness above the background per pixel: the largest premultiplied channel excess. */
function excess(data: Uint8Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const a = data[p * 4 + 3] / 255;
    let v = 0;
    for (let c = 0; c < 3; c++) v = Math.max(v, data[p * 4 + c] * a - BG[c]);
    out[p] = v;
  }
  return out;
}

function stats(v: Float32Array, width: number, height: number): Stats {
  const s: Stats = { drawn: 0, energy: 0, blobs: 0, areas: [], peaks: [], radii: [] };
  const seen = new Uint8Array(width * height);
  for (let p = 0; p < v.length; p++) {
    if (v[p] > DRAWN) s.drawn++;
    s.energy += Math.max(0, v[p]);
  }
  const stack: number[] = [];
  for (let p = 0; p < v.length; p++) {
    if (seen[p] || v[p] <= BLOB) continue;
    let area = 0;
    let peak = 0;
    let sx = 0;
    let sy = 0;
    stack.push(p);
    seen[p] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      const x = q % width;
      const y = (q - x) / width;
      area++;
      peak = Math.max(peak, v[q]);
      sx += x;
      sy += y;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const n = ny * width + nx;
        if (!seen[n] && v[n] > BLOB) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    s.blobs++;
    s.areas.push(area);
    s.peaks.push(peak);
    s.radii.push(Math.hypot(sx / area - width / 2, sy / area - height / 2));
  }
  return s;
}

const quantiles = (xs: number[]) => {
  if (!xs.length) return "-";
  const sorted = [...xs].sort((a, b) => a - b);
  const q = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  return [0.1, 0.5, 0.9, 1].map((f) => q(f).toFixed(0)).join("/");
};

mkdirSync(join(ROOT, "probe", "particular"), { recursive: true });
for (const [comp, frame] of cases) {
  const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
  const dump = readdirSync(join(temp, "ours")).find((f) => f.startsWith(`${comp}_f${frame}_`));
  if (!dump) {
    console.log(`${comp}@${frame}: no render dumped`);
    continue;
  }
  const ours = new Uint8Array(readFileSync(join(temp, "ours", dump)));
  const { width, height } = ref;
  const a = stats(excess(ref.data, width, height), width, height);
  const b = stats(excess(ours, width, height), width, height);
  console.log(`${comp}@${frame}`);
  console.log(`  drawn px      ref ${a.drawn}  ours ${b.drawn}`);
  console.log(`  energy        ref ${a.energy.toFixed(0)}  ours ${b.energy.toFixed(0)}  (ratio ${(b.energy / Math.max(1, a.energy)).toFixed(2)})`);
  console.log(`  particles     ref ${a.blobs}  ours ${b.blobs}`);
  console.log(`  area p10/50/90/max   ref ${quantiles(a.areas)}  ours ${quantiles(b.areas)}`);
  console.log(`  peak p10/50/90/max   ref ${quantiles(a.peaks)}  ours ${quantiles(b.peaks)}`);
  console.log(`  radius p10/50/90/max ref ${quantiles(a.radii)}  ours ${quantiles(b.radii)}`);
  // Area at a given peak: wider halos show as more area for the same peak brightness.
  const bins = [10, 20, 40, 80, 160, 256];
  const byPeak = (s: Stats) =>
    bins
      .slice(0, -1)
      .map((lo, k) => {
        const areas = s.areas.filter((_, i) => s.peaks[i] >= lo && s.peaks[i] < bins[k + 1]);
        return `${lo}-${bins[k + 1]}: ${areas.length ? quantiles(areas).split("/")[1] : "-"} (${areas.length})`;
      })
      .join("  ");
  console.log(`  median area by peak  ref ${byPeak(a)}`);
  console.log(`                       ours ${byPeak(b)}`);
  // Sheet: reference | ours, cropped around the centre to at most 640x360, brightened x2.
  const cw = Math.min(width, 640);
  const ch = Math.min(height, 360);
  const x0 = (width - cw) >> 1;
  const y0 = (height - ch) >> 1;
  const sheet = new Uint8Array(cw * 2 * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = ((y0 + y) * width + x0 + x) * 4;
      for (const [k, d] of [[0, ref.data], [1, ours]] as const) {
        const o = (y * cw * 2 + k * cw + x) * 4;
        for (let c = 0; c < 3; c++) sheet[o + c] = Math.min(255, ((d[i + c] * d[i + 3]) / 255) * 2);
        sheet[o + 3] = 255;
      }
    }
  }
  writeFileSync(join(ROOT, "probe", "particular", `${comp}_f${frame}.png`), encodePng(cw * 2, ch, sheet));
}
