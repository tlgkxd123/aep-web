// Fits where Audio Spectrum's analysis window sits relative to the current time
// (and the height scale) to the fxmisc_as_* references with straight horizontal
// paths. The visible extent of column x is modelled as the furthest round cap
// of the overlapping bands: max_k h_k + sqrt(R² − (x − x_k)²), R = Thickness / 2.
//
//   node scripts/fit-audspect-place.ts [--cases=bass,lobe]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { layerTimeAt, valueAtTime } from "../src/aep/evaluate.ts";
import type { CompItem, Property, PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { decodeWav, type AudioData } from "../src/media/audio.ts";
import { analyse as analyseWindow, windowLength, windowStart } from "../src/render/effects/audioSpectrumAnalysis.ts";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const monoCache = new Map<AudioData, Float32Array>();
function monoOf(audio: AudioData): Float32Array {
  let mono = monoCache.get(audio);
  if (!mono) {
    mono = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) audio.getChannelData(c).forEach((v, i) => (mono![i] += v / audio.numberOfChannels));
    monoCache.set(audio, mono);
  }
  return mono;
}

// How channels combine: mean of the samples, one channel, or per-channel magnitudes (mean, rms, max).
const channels = process.argv.find((a) => a.startsWith("--channels="))?.slice(11) ?? "mean";

function analyse(audio: AudioData, time: number, settings: Case["settings"], placement: number): Float32Array {
  const length = windowLength(audio.sampleRate, settings.durationMs);
  const first = windowStart(time, audio.sampleRate, length, placement);
  const spectrum = (data: Float32Array) => {
    const samples = new Float32Array(length);
    for (let n = 0; n < length; n++) samples[n] = data[first + n] ?? 0;
    return analyseWindow(samples, audio.sampleRate, settings);
  };
  if (channels === "mean" || audio.numberOfChannels === 1) return spectrum(monoOf(audio));
  if (channels === "L" || channels === "R") return spectrum(audio.getChannelData(channels === "L" ? 0 : 1));
  const per = Array.from({ length: audio.numberOfChannels }, (_, c) => spectrum(audio.getChannelData(c)));
  return per[0].map((_, k) => {
    const v = per.map((s) => s[k]);
    if (channels === "max") return Math.max(...v);
    if (channels === "rms") return Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length);
    return v.reduce((a, b) => a + b, 0) / v.length;
  });
}

const bytes = readFileSync("refs/fixtures/fxmisc.aep");
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const manifest = JSON.parse(readFileSync("refs/fixtures/fxmisc.manifest.json", "utf8")) as { comps: { comp: string; frames: number[]; fps: number }[] };
const only = process.argv.find((a) => a.startsWith("--cases="))?.slice(8).split(",");

interface Case {
  name: string;
  audio: AudioData;
  time: number;
  settings: { startFrequency: number; endFrequency: number; bands: number; durationMs: number };
  xs: number[];
  maxHeight: number;
  radius: number;
  /** Measured extent per column (index = column - x0), NaN where unusable. */
  measured: Map<number, number>;
  limit: number;
}

const cases: Case[] = [];
const audioCache = new Map<string, AudioData>();
for (const { comp: name, frames, fps } of manifest.comps) {
  if (!name.startsWith("fxmisc_as_")) continue;
  const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === name);
  if (!comp) continue;
  for (const layer of comp.layers) {
    const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
    const fx = parade?.children.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE AudSpect");
    if (!fx) continue;
    for (const frame of frames) {
      if (only && !only.some((o) => `${name}@${frame}`.includes(o))) continue;
      const ref = framePath(name, frame);
      if (!existsSync(ref)) continue;
      const time = frame / fps;
      const p = (i: number) => valueAtTime(fx.children.find((c) => c.matchName === `ADBE AudSpect-${String(i).padStart(4, "0")}`) as Property, time, layer) as number & number[];
      if (p(20) !== 1 || p(4) || p(5) || p(21) === 3) continue;
      const [sx, sy] = p(2);
      const [ex, ey] = p(3);
      if (sy !== ey) continue;
      const audioLayer = comp.layers.find((l) => l.index === p(1))!;
      const item = project.items.get(audioLayer.sourceId)!;
      if (item.kind !== "footage" || item.mainSource.sourceType !== "FileSource") continue;
      const wav = join("refs/fixtures/fxmisc_audio", item.mainSource.fileName);
      if (!audioCache.has(wav)) audioCache.set(wav, decodeWav(new Uint8Array(readFileSync(wav)))!);
      const t = readTiff(new Uint8Array(readFileSync(ref)));
      const down = p(21) === 2;
      const limit = down ? t.height - 1 - sy : sy;
      const measured = new Map<number, number>();
      for (let x = Math.ceil(sx); x <= Math.floor(ex); x++) {
        let extent = 0;
        for (let d = 0; d <= limit; d++) {
          const y = down ? sy + d : sy - d;
          if (t.data[(y * t.width + x) * 4 + 3] >= 128) extent = d;
        }
        measured.set(x, extent);
      }
      const bands = p(8);
      cases.push({
        name: `${name}@${frame}`,
        audio: audioCache.get(wav)!,
        time: layerTimeAt(audioLayer, time) + p(11) / 1000,
        settings: { startFrequency: p(6), endFrequency: p(7), bands, durationMs: p(10) },
        xs: Array.from({ length: bands }, (_, k) => sx + ((ex - sx) * k) / (bands - 1)),
        maxHeight: p(9),
        radius: p(12) / 2,
        measured,
        limit,
      });
    }
  }
}
console.log(`cases: ${cases.map((c) => c.name).join(", ")}`);

// The chirp-z analysis against a direct DFT.
{
  const c = cases[0];
  const mono = monoOf(c.audio);
  const fast = analyse(c.audio, c.time, c.settings, 0.5);
  const N = Math.round((c.settings.durationMs / 1000) * c.audio.sampleRate);
  const first = Math.round(c.time * c.audio.sampleRate - N * 0.5);
  let worst = 0;
  for (const k of [0, Math.floor(c.settings.bands / 3), c.settings.bands - 1]) {
    const f = c.settings.startFrequency + (k * (c.settings.endFrequency - c.settings.startFrequency)) / c.settings.bands;
    let re = 0, im = 0, ws = 0;
    for (let n = 0; n < N; n++) {
      const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (N - 1));
      const i = first + n;
      const s = i >= 0 && i < mono.length ? mono[i] : 0;
      re += s * w * Math.cos((2 * Math.PI * f * n) / c.audio.sampleRate);
      im -= s * w * Math.sin((2 * Math.PI * f * n) / c.audio.sampleRate);
      ws += w;
    }
    worst = Math.max(worst, Math.abs((2 * Math.hypot(re, im)) / ws - fast[k]));
  }
  console.log(`chirp-z vs direct DFT: max difference ${worst.toExponential(2)}`);
}

function extents(c: Case, heights: Float32Array): Map<number, number> {
  const out = new Map<number, number>();
  for (const x of c.measured.keys()) {
    let best = 0;
    for (let k = 0; k < c.xs.length; k++) {
      const dx = x - c.xs[k];
      if (Math.abs(dx) > c.radius) continue;
      best = Math.max(best, heights[k] + Math.sqrt(c.radius * c.radius - dx * dx));
    }
    out.set(x, best);
  }
  return out;
}

const results: { placement: number; scale: number; error: number; perCase: string }[] = [];
const range = (process.argv.find((a) => a.startsWith("--range="))?.slice(8) ?? "-3,2,0.05").split(",").map(Number);
for (let placement = range[0]; placement <= range[1] + 1e-9; placement += range[2]) {
  const mags = cases.map((c) => analyse(c.audio, c.time, c.settings, placement));
  let best = { scale: 0, error: Infinity, perCase: "" };
  for (let scale = 0.45; scale <= 0.6001; scale += 0.005) {
    let total = 0;
    let count = 0;
    const perCase = cases.map((c, i) => {
      const heights = mags[i].map((m) => m * c.maxHeight * scale);
      const model = extents(c, heights);
      let e = 0;
      let n = 0;
      for (const [x, measured] of c.measured) {
        const predicted = model.get(x)!;
        if (measured >= c.limit - 3 || predicted >= c.limit - 3) continue;
        e += Math.abs(predicted - measured);
        n++;
      }
      total += e;
      count += n;
      return `${c.name.replace("fxmisc_as_", "")}=${(e / Math.max(1, n)).toFixed(2)}/${n}`;
    });
    if (total / count < best.error) best = { scale, error: total / count, perCase: perCase.join(" ") };
  }
  results.push({ placement, ...best });
}
results.sort((a, b) => a.error - b.error);
for (const r of results.slice(0, 10)) console.log(`${r.error.toFixed(3)} px  placement ${r.placement.toFixed(2)}  scale ${r.scale.toFixed(3)}  ${r.perCase}`);
