// Fits a model of Audio Spectrum's analysis (window, band frequencies, band
// integration, height scale) to the bar heights in the fxmisc_as_* After Effects
// references, which use synthetic test tones.
//
//   node scripts/fit-audspect.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { valueAtTime } from "../src/aep/evaluate.ts";
import type { CompItem, Property, PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { decodeWav, type AudioData } from "../src/media/audio.ts";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const bytes = readFileSync("refs/fixtures/fxmisc.aep");
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const manifest = JSON.parse(readFileSync("refs/fixtures/fxmisc.manifest.json", "utf8")) as { comps: { comp: string; frames: number[]; fps: number }[] };

interface Case {
  name: string;
  audio: AudioData;
  time: number;
  start: number[];
  end: number[];
  f0: number;
  f1: number;
  bands: number;
  maxHeight: number;
  durationMs: number;
  offsetMs: number;
  thickness: number;
  measured: number[];
}

const audioCache = new Map<string, AudioData>();
const cases: Case[] = [];
for (const { comp: name, frames, fps } of manifest.comps) {
  if (!name.startsWith("fxmisc_as_")) continue;
  const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === name)!;
  for (const layer of comp.layers) {
    const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
    const fx = parade?.children.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE AudSpect");
    if (!fx) continue;
    for (const frame of frames) {
      const time = frame / fps;
      const p = (i: number) => {
        const prop = fx.children.find((c) => c.matchName === `ADBE AudSpect-${String(i).padStart(4, "0")}`) as Property;
        return valueAtTime(prop, time, layer) as number & number[];
      };
      const audioLayer = comp.layers.find((l) => l.index === p(1));
      const item = audioLayer && project.items.get(audioLayer.sourceId);
      if (!item || item.kind !== "footage" || item.mainSource.sourceType !== "FileSource") continue;
      const wav = join("refs/fixtures/fxmisc_audio", item.mainSource.fileName);
      if (!audioCache.has(wav)) audioCache.set(wav, decodeWav(new Uint8Array(readFileSync(wav)))!);
      const ref = framePath(name, frame);
      if (!existsSync(ref)) continue;
      if (p(20) !== 1 || p(5)) continue; // digital, straight path only
      const t = readTiff(new Uint8Array(readFileSync(ref)));
      const [sx, sy] = p(2);
      const [ex] = p(3);
      const bands = p(8);
      const measured: number[] = [];
      for (let k = 0; k < bands; k++) {
        const x = Math.round(sx + ((ex - sx) * k) / (bands - 1));
        let top = sy;
        for (let y = 0; y < t.height; y++) if (t.data[(y * t.width + x) * 4 + 3] >= 128) { top = y; break; }
        measured.push(Math.max(0, sy - top));
      }
      cases.push({
        name: `${name}@${frame}`,
        audio: audioCache.get(wav)!,
        time: time - (audioLayer!.startTime ?? 0),
        start: p(2), end: p(3), f0: p(6), f1: p(7), bands, maxHeight: p(9), durationMs: p(10), offsetMs: p(11), thickness: p(12),
        measured,
      });
    }
  }
}
const only = process.argv.find((a) => a.startsWith("--cases="))?.slice(8).split(",");
if (only) cases.splice(0, cases.length, ...cases.filter((c) => only.some((o) => c.name.includes(o))));
console.log(`cases: ${cases.map((c) => c.name).join(", ")}`);

type Window = "hann" | "rect" | "blackman" | "hamming";
const windowFn = (kind: Window, n: number, N: number) =>
  kind === "rect" ? 1
  : kind === "hann" ? 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1))
  : kind === "hamming" ? 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (N - 1))
  : 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1)) + 0.08 * Math.cos((4 * Math.PI * n) / (N - 1));

interface Model { window: Window; place: number; spacing: "inclusive" | "exclusive" | "centred"; integrate: number }

/** Magnitude (amplitude units) of the windowed signal at frequency f, normalized so a full-scale sine at f reads its amplitude. */
function magnitude(c: Case, m: Model, f: number, mono: Float32Array): number {
  const rate = c.audio.sampleRate;
  const N = Math.max(8, Math.round((c.durationMs / 1000) * rate));
  const centre = (c.time + c.offsetMs / 1000) * rate;
  const first = Math.round(centre - N * m.place);
  let re = 0;
  let im = 0;
  let wsum = 0;
  for (let n = 0; n < N; n++) {
    const i = first + n;
    const s = i >= 0 && i < mono.length ? mono[i] : 0;
    const w = windowFn(m.window, n, N);
    const a = (2 * Math.PI * f * i) / rate;
    re += s * w * Math.cos(a);
    im -= s * w * Math.sin(a);
    wsum += w;
  }
  return (2 * Math.hypot(re, im)) / wsum;
}

function bandFrequency(c: Case, m: Model, k: number): number {
  const span = c.f1 - c.f0;
  if (m.spacing === "inclusive") return c.f0 + (span * k) / (c.bands - 1);
  if (m.spacing === "exclusive") return c.f0 + (span * k) / c.bands;
  return c.f0 + (span * (k + 0.5)) / c.bands;
}

const monoCache = new Map<AudioData, Float32Array>();
const mono = (a: AudioData) => {
  let m = monoCache.get(a);
  if (!m) {
    m = new Float32Array(a.length);
    for (let ch = 0; ch < a.numberOfChannels; ch++) {
      const d = a.getChannelData(ch);
      for (let i = 0; i < a.length; i++) m[i] += d[i] / a.numberOfChannels;
    }
    monoCache.set(a, m);
  }
  return m;
};

function predict(c: Case, m: Model): number[] {
  const width = (c.f1 - c.f0) / Math.max(1, c.bands - 1);
  return Array.from({ length: c.bands }, (_, k) => {
    const f = bandFrequency(c, m, k);
    if (!m.integrate) return magnitude(c, m, f, mono(c.audio));
    let best = 0;
    for (let s = -m.integrate; s <= m.integrate; s++) best = Math.max(best, magnitude(c, m, f + (s / m.integrate) * width * 0.5, mono(c.audio)));
    return best;
  });
}

const results: { model: Model; scale: number; error: number; perCase: string }[] = [];
for (const window of ["hann", "rect", "blackman", "hamming"] as Window[])
  for (const place of [0, 0.5, 1])
    for (const spacing of ["inclusive", "exclusive", "centred"] as const)
      for (const integrate of [0, 3]) {
        const model = { window, place, spacing, integrate };
        const preds = cases.map((c) => predict(c, model).map((v) => v * c.maxHeight));
        // Least-squares scale over all bands.
        let num = 0;
        let den = 0;
        cases.forEach((c, i) => preds[i].forEach((p, k) => ((num += p * c.measured[k]), (den += p * p))));
        const scale = den ? num / den : 0;
        let total = 0;
        let count = 0;
        const perCase = cases.map((c, i) => {
          let e = 0;
          preds[i].forEach((p, k) => (e += Math.abs(p * scale - c.measured[k])));
          total += e;
          count += c.bands;
          return `${c.name.replace("fxmisc_as_", "")}=${(e / c.bands).toFixed(2)}`;
        });
        results.push({ model, scale, error: total / count, perCase: perCase.join(" ") });
      }
results.sort((a, b) => a.error - b.error);
for (const r of results.slice(0, 8)) console.log(`${r.error.toFixed(3)} px  scale ${r.scale.toFixed(3)}  ${JSON.stringify(r.model)}  ${r.perCase}`);
