// Prints Audio Spectrum's band heights (our analysis, straight-line scale) next to
// the reference's ray length per angle around the Start Point, for a polar case.
//
//   node scripts/audspect-polar.ts fxmisc_as_polar@12 [--step=2]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { layerTimeAt, valueAtTime } from "../src/aep/evaluate.ts";
import type { CompItem, Property, PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { decodeWav } from "../src/media/audio.ts";
import { analyse, WINDOW_PLACEMENT, windowLength, windowStart } from "../src/render/effects/audioSpectrumAnalysis.ts";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const [name, frameText] = process.argv[2].split("@");
const frame = Number(frameText);
const step = Number(process.argv.find((a) => a.startsWith("--step="))?.slice(7) ?? 2);
const bytes = readFileSync("refs/fixtures/fxmisc.aep");
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const manifest = JSON.parse(readFileSync("refs/fixtures/fxmisc.manifest.json", "utf8")) as { comps: { comp: string; fps: number }[] };
const fps = manifest.comps.find((c) => c.comp === name)!.fps;
const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === name)!;
const time = frame / fps;
for (const layer of comp.layers) {
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
  const fx = parade?.children.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE AudSpect");
  if (!fx) continue;
  const p = (i: number) => valueAtTime(fx.children.find((c) => c.matchName === `ADBE AudSpect-${String(i).padStart(4, "0")}`) as Property, time, layer) as number & number[];
  const audioLayer = comp.layers.find((l) => l.index === p(1))!;
  const item = project.items.get(audioLayer.sourceId)!;
  if (item.kind !== "footage" || item.mainSource.sourceType !== "FileSource") continue;
  const audio = decodeWav(new Uint8Array(readFileSync(join("refs/fixtures/fxmisc_audio", item.mainSource.fileName))))!;
  const mono = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) audio.getChannelData(c).forEach((v, i) => (mono[i] += v / audio.numberOfChannels));
  const settings = { startFrequency: p(6), endFrequency: p(7), bands: p(8), durationMs: p(10) };
  const length = windowLength(audio.sampleRate, settings.durationMs);
  const first = windowStart(layerTimeAt(audioLayer, time) + p(11) / 1000, audio.sampleRate, length, WINDOW_PLACEMENT);
  const samples = new Float32Array(length);
  for (let n = 0; n < length; n++) samples[n] = mono[first + n] ?? 0;
  const mags = analyse(samples, audio.sampleRate, settings);
  const heights = [...mags].map((m) => m * p(9) * 0.535);
  console.log(`start ${p(2)} end ${p(3)} max ${p(9)} thickness ${p(12)} side ${p(21)}`);
  console.log("heights:", heights.map((h, k) => `${k}:${h.toFixed(1)}`).join(" "));
  const t = readTiff(new Uint8Array(readFileSync(framePath(name, frame))));
  const [cx, cy] = p(2);
  const rays: string[] = [];
  for (let deg = 0; deg < 360; deg += step) {
    const a = (deg * Math.PI) / 180;
    let reach = 0;
    for (let r = 0; r < 400; r += 0.5) {
      const x = Math.round(cx + r * Math.cos(a));
      const y = Math.round(cy - r * Math.sin(a));
      if (x < 0 || y < 0 || x >= t.width || y >= t.height) break;
      if (t.data[(y * t.width + x) * 4 + 3] >= 128) reach = r;
    }
    rays.push(`${deg}:${reach.toFixed(1)}`);
  }
  console.log("reference reach by angle (degrees counter-clockwise from +x on screen):");
  console.log(rays.join(" "));
}
