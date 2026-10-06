// Locates Audio Spectrum's analysis window frame by frame: for each reference
// frame of a straight, Side A, digital case it scans where the window starts
// (milliseconds after the analysed time) and prints the best fit with the
// range of starts that fit within 0.1 px of it.
//
//   node scripts/fit-audspect-window.ts fxmisc_as_gate_170 [--from=-400 --to=200 --step=0.5] [--frames=10,11]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { layerTimeAt, valueAtTime } from "../src/aep/evaluate.ts";
import type { CompItem, Property, PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { decodeWav } from "../src/media/audio.ts";
import { analyse, windowLength } from "../src/render/effects/audioSpectrumAnalysis.ts";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const name = process.argv[2];
const [from, to, step] = ["from", "to", "step"].map((n, i) => Number(arg(n, ["-400", "200", "0.5"][i])));
const bytes = readFileSync("refs/fixtures/fxmisc.aep");
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const manifest = JSON.parse(readFileSync("refs/fixtures/fxmisc.manifest.json", "utf8")) as { comps: { comp: string; frames: number[]; fps: number }[] };
const entry = manifest.comps.find((c) => c.comp === name)!;
const frames = arg("frames", "") ? arg("frames", "").split(",").map(Number) : entry.frames;
const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === name)!;
const layer = comp.layers.find((l) => l.properties.some((n) => n.kind === "group" && n.matchName === "ADBE Effect Parade" && n.children.some((c) => c.matchName === "ADBE AudSpect")))!;
const fx = (layer.properties.find((n) => n.kind === "group" && n.matchName === "ADBE Effect Parade") as PropertyGroup).children.find((c) => c.matchName === "ADBE AudSpect") as PropertyGroup;

for (const frame of frames) {
  const ref = framePath(name, frame);
  if (!existsSync(ref)) continue;
  const time = frame / entry.fps;
  const p = (i: number) => valueAtTime(fx.children.find((c) => c.matchName === `ADBE AudSpect-${String(i).padStart(4, "0")}`) as Property, time, layer) as number & number[];
  const audioLayer = comp.layers.find((l) => l.index === p(1))!;
  const item = project.items.get(audioLayer.sourceId)!;
  if (item.kind !== "footage" || item.mainSource.sourceType !== "FileSource") throw new Error("the audio layer must be a file");
  const audio = decodeWav(new Uint8Array(readFileSync(join("refs/fixtures/fxmisc_audio", item.mainSource.fileName))))!;
  const mono = audio.getChannelData(0);
  const rate = audio.sampleRate;
  const settings = { startFrequency: p(6), endFrequency: p(7), bands: p(8), durationMs: p(10) };
  const length = windowLength(rate, settings.durationMs);
  const analysed = layerTimeAt(audioLayer, time) + p(11) / 1000;
  const [sx, sy] = p(2);
  const [ex] = p(3);
  const t = readTiff(new Uint8Array(readFileSync(ref)));
  const radius = p(12) / 2;
  const xs = Array.from({ length: settings.bands }, (_, k) => sx + ((ex - sx) * k) / (settings.bands - 1));
  const measured: [number, number][] = [];
  for (let x = Math.ceil(sx); x <= Math.floor(ex); x++) {
    let extent = 0;
    for (let d = 0; d <= sy; d++) if (t.data[((sy - d) * t.width + x) * 4 + 3] >= 128) extent = d;
    measured.push([x, extent]);
  }
  const results: [number, number][] = [];
  for (let offset = from; offset <= to + 1e-9; offset += step) {
    const first = Math.round((analysed + offset / 1000) * rate);
    const samples = new Float32Array(length);
    for (let n = 0; n < length; n++) samples[n] = mono[first + n] ?? 0;
    const heights = analyse(samples, rate, settings).map((m) => m * p(9) * 0.535);
    let e = 0;
    for (const [x, m] of measured) {
      let best = 0;
      for (let k = 0; k < xs.length; k++) {
        const dx = x - xs[k];
        if (Math.abs(dx) <= radius) best = Math.max(best, heights[k] + Math.sqrt(radius * radius - dx * dx));
      }
      e += Math.abs(best - m);
    }
    results.push([offset, e / measured.length]);
  }
  const best = results.reduce((a, b) => (b[1] < a[1] ? b : a));
  const near = results.filter((r) => r[1] <= best[1] + 0.1).map((r) => r[0]);
  const peak = Math.max(...measured.map((m) => m[1]));
  console.log(
    `frame ${String(frame).padStart(3)} t=${time.toFixed(4)}  best start ${best[0].toFixed(1).padStart(7)} ms (${(best[0] / settings.durationMs).toFixed(3)} D)  error ${best[1].toFixed(2)} px  fits ${Math.min(...near).toFixed(1)}..${Math.max(...near).toFixed(1)}  peak ${peak}`,
  );
}
