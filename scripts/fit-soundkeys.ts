// Calibrates the Sound Keys model against keyframes After Effects baked with the
// plugin (the user's project): decodes the audio with ffmpeg, computes spectra at
// the key times, and searches the display's frequency axis, analysis window and
// level scale for the best fit of Outputs whose falloff keeps no memory.
//
//   node scripts/fit-soundkeys.ts <project.aep> <comp> <sound keys layer name> <audio file>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompItem, Property, PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { fft } from "../src/render/effects/audioSpectrumAnalysis.ts";

const [path, compName, layerName, audioFile] = process.argv.slice(2);
const bytes = readFileSync(path);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName)!;
const layer = comp.layers.find((l) => l.name === layerName)!;
const fx = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade")!.children.find(
  (n): n is PropertyGroup => n.kind === "group" && n.matchName === "tc Sound Keys",
)!;
const param = (id: number) => fx.children.find((c): c is Property => c.kind === "property" && c.matchName === `tc Sound Keys-${String(id).padStart(4, "0")}`)!;
const source = project.items.get(layer.sourceId) as { width: number; height: number };
const W = source.width;
const H = source.height;

const RATE = 44100;
const raw = join(tmpdir(), "sk-audio.f32");
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", audioFile, "-ac", "1", "-ar", String(RATE), "-f", "f32le", raw]);
const buf = readFileSync(raw);
const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

interface Range { out: number; x0: number; x1: number; yTop: number; yBottom: number; max: number; keys: [number, number][] }
const ranges: Range[] = [];
for (const [corner1, corner2, falloff, max, output] of [[14, 15, 16, 20, 21], [26, 27, 28, 32, 33]]) {
  const a = param(corner1).value as number[];
  const b = param(corner2).value as number[];
  const prop = param(output);
  console.log(`range ${output}: falloff ${param(falloff).value} corners ${a} ${b} max ${param(max).value}`);
  ranges.push({
    out: output, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]), yTop: Math.min(a[1], b[1]), yBottom: Math.max(a[1], b[1]),
    max: param(max).value as number, keys: prop.keyframes.map((k) => [k.time, k.value as number]),
  });
}

// Spectra at the key times (all outputs share key times) inside the span last applied with this audio.
const [from, to] = (process.env.SK_SPAN ?? `${comp.workAreaStart},${comp.workAreaStart + comp.workAreaDuration}`).split(",").map(Number);
const step = Number(process.env.SK_STEP ?? 1);
const times = ranges[0].keys.filter((_, i) => i % step === 0).map((k) => k[0]).filter((t) => t > from + 0.5 && t < to - 0.1);
const keyAt = (r: Range, t: number) => r.keys.find((k) => Math.abs(k[0] - t) < 1e-6)?.[1];

function spectra(n: number, align: number): Float32Array[] {
  const window = Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  return times.map((t) => {
    const start = Math.round(t * RATE - align * n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = (samples[start + i] ?? 0) * window[i];
    fft(re, im, -1);
    const mag = new Float32Array(n / 2);
    for (let k = 0; k < n / 2; k++) mag[k] = Math.hypot(re[k], im[k]) / n;
    return mag;
  });
}

/** Correlation of an output's unclipped keys with the band level under a frequency axis. */
function score(mags: Float32Array[], n: number, freqAt: (x: number) => number, level: (m: number) => number, r: Range) {
  const xs: number[] = [];
  const ys: number[] = [];
  mags.forEach((mag, i) => {
    const v = keyAt(r, times[i]);
    if (v === undefined || v <= 0.02 * r.max || v >= 0.98 * r.max) return;
    let sum = 0;
    let count = 0;
    for (let x = Math.ceil(r.x0); x <= r.x1; x++) {
      const bin = (freqAt(x) * n) / RATE;
      const k = Math.floor(bin);
      if (k < 0 || k + 1 >= mag.length) continue;
      sum += level(mag[k] + (mag[k + 1] - mag[k]) * (bin - k));
      count++;
    }
    if (!count) return;
    xs.push(sum / count);
    ys.push(v);
  });
  const m = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / m;
  const my = ys.reduce((s, v) => s + v, 0) / m;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < m; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxy / sxx;
  return { r2: (sxy * sxy) / (sxx * syy), slope, intercept: my - slope * mx, m };
}

if (process.env.SK_AXIS) {
  // SK_AXIS="n,align": joint search of the log axis (fmin at left margin, fmax at right margin).
  const [n, align] = process.env.SK_AXIS.split(",").map(Number);
  const mags = spectra(n, align);
  const lines: string[] = [];
  for (const margin of [0, 0.05, 0.1]) {
    for (const fmin of [1, 2, 5, 10, 15, 20, 25, 30, 40]) {
      for (const fmax of [1000, 2000, 5000, 10000, 15000, 20000, 22050, 30000, 44100]) {
        const left = margin * W;
        const right = (1 - margin) * W;
        const freqAt = (x: number) => fmin * (fmax / fmin) ** ((x - left) / (right - left));
        const s = ranges.map((r) => score(mags, n, freqAt, (m) => m, r));
        lines.push(`${Math.min(...s.map((v) => v.r2)).toFixed(4)} margin ${margin} ${fmin}-${fmax} | ${s.map((v) => `r2 ${v.r2.toFixed(3)} slope ${v.slope.toFixed(1)} icpt ${v.intercept.toFixed(2)}`).join(" | ")}`);
      }
    }
  }
  lines.sort().reverse();
  for (const line of lines.slice(0, 15)) console.log(line);
  process.exit(0);
}

if (process.env.SK_EVAL) {
  // SK_EVAL="n,align,gain,base": display y of amplitude A is base·H − gain·H·A; outputs simulated with decay.
  const [n, align, gain, base] = process.env.SK_EVAL.split(",").map(Number);
  const mags = spectra(n, align);
  const left = 0.05 * W;
  const right = 0.95 * W;
  const freqAt = (x: number) => 15 * (22050 / 15) ** ((x - left) / (right - left));
  for (const r of ranges) {
    const raw = mags.map((mag) => {
      let sum = 0;
      let count = 0;
      for (let x = Math.ceil(r.x0); x <= r.x1; x++) {
        const bin = (freqAt(x) * n) / RATE;
        const k = Math.floor(bin);
        sum += mag[k] + (mag[k + 1] - mag[k]) * (bin - k);
        count++;
      }
      const y = base * H - gain * H * (sum / count);
      return Math.max(0, Math.min(1, (r.yBottom - y) / (r.yBottom - r.yTop)));
    });
    const truth = times.map((t) => keyAt(r, t)! / r.max);
    for (const tau of [0, 0.02, 0.05, 0.1, 0.2]) {
      let v = 0;
      const sim = raw.map((x, i) => {
        const dt = i ? times[i] - times[i - 1] : 0;
        v = x >= v || tau === 0 ? x : v * Math.exp(-dt / tau) + x * (1 - Math.exp(-dt / tau)) * 0;
        v = Math.max(v, x);
        return v;
      });
      const err = Math.sqrt(sim.reduce((s, x, i) => s + (x - truth[i]) ** 2, 0) / sim.length);
      console.log(`output ${r.out} decay ${tau}: rms ${(err * r.max).toFixed(2)} of ${r.max}`);
    }
    console.log(`  t     ${times.slice(600, 640).map((t) => t.toFixed(2).slice(-5)).join(" ")}`);
    console.log(`  truth ${truth.slice(600, 640).map((x) => (x * r.max).toFixed(1).padStart(5)).join(" ")}`);
    console.log(`  model ${raw.slice(600, 640).map((x) => (x * r.max).toFixed(1).padStart(5)).join(" ")}`);
  }
  process.exit(0);
}

const levels: [string, (m: number) => number][] = [
  ["linear", (m) => m],
  ["dB", (m) => 20 * Math.log10(m + 1e-9)],
  ["sqrt", (m) => Math.sqrt(m)],
];
const results: string[] = [];
for (const n of [1024, 2048, 4096, 8192]) {
  for (const align of [0, 0.5, 1]) {
    const mags = spectra(n, align);
    for (const [axis, lo, hi] of [
      ["log", 20, 20000], ["log", 20, 22050], ["log", 10, 22050], ["log", 30, 16000], ["log", 40, 20000], ["log", 20, 10000], ["log", 50, 22050],
      ["lin", 0, 22050], ["lin", 0, 11025], ["lin", 0, 5000], ["lin", 0, 2000], ["lin", 0, 1000],
    ] as const) {
      // The spectrum spans 5%..95% of the layer width.
      const left = 0.05 * W;
      const right = 0.95 * W;
      const freqAt = axis === "log"
        ? (x: number) => lo * (hi / lo) ** ((x - left) / (right - left))
        : (x: number) => lo + ((hi - lo) * (x - left)) / (right - left);
      for (const [name, level] of levels) {
        const s = ranges.map((r) => score(mags, n, freqAt, level, r));
        const r2 = s.map((v) => v.r2);
        results.push(`${Math.min(...r2).toFixed(4)} n=${n} align=${align} ${axis} ${lo}-${hi} ${name} | ${s.map((v) => `r2 ${v.r2.toFixed(3)} slope ${v.slope.toExponential(3)} icpt ${v.intercept.toFixed(2)} (${v.m})`).join(" | ")}`);
      }
    }
  }
}
results.sort().reverse();
console.log(`layer ${W}x${H}, ${times.length} key times`);
for (const line of results.slice(0, 25)) console.log(line);
