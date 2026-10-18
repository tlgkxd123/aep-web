// Compares Sound Keys' live Outputs with keyframes After Effects baked with the plugin: decodes the Audio Layer's
// file with ffmpeg, works out every Output live at the baked key times and between them, and reports the error in
// percent of each Output's baked range, over the span last applied (the work area, or SK_SPAN="from,to"). The live
// grid follows the baked keys' spacing.
//
//   node scripts/soundkeys-live-vs-baked.ts <project.aep> <comp> <sound keys layer> <audio file>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompItem, Property, PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { valueAtTime } from "../src/aep/evaluate.ts";
import { appliedSettings, keyGrid } from "../src/media/soundKeys.ts";
import { createAnalysis, outputsOf } from "../src/media/soundKeysLive.ts";

const [path, compName, layerName, audioFile] = process.argv.slice(2);
const bytes = readFileSync(path);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName)!;
const layer = comp.layers.find((l) => l.name === layerName)!;
const effect = layer.properties
  .find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade")!
  .children.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "tc Sound Keys")!;

const RATE = 44100;
const raw = join(tmpdir(), "sk-live-audio.f32");
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", audioFile, "-ac", "1", "-ar", String(RATE), "-f", "f32le", raw]);
const buf = readFileSync(raw);
const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const read = (first: number, length: number) => Float32Array.from({ length }, (_, i) => samples[first + i] ?? 0);

const settings = appliedSettings(project, comp, layer, effect);
const outputs = settings.ranges.map((r) => effect.children.find((c): c is Property => c.kind === "property" && c.matchName === `tc Sound Keys-${String(r.output).padStart(4, "0")}`)!);
// The span last applied (earlier applies may have used other settings).
const [from, to] = (process.env.SK_SPAN ?? `${comp.workAreaStart},${comp.workAreaStart + comp.workAreaDuration}`).split(",").map(Number);
const keys = outputs[0].keyframes.filter((k) => k.time > from + 0.5 && k.time < to - 0.1);
if (keys.length < 2) throw new Error("the Outputs hold no baked keys");
const spacing = (keys[keys.length - 1].time - keys[0].time) / (keys.length - 1);
settings.keysPerSecond = Math.round(1 / spacing);
const audioLayer = comp.layers.find((l) => l.index === settings.audioLayer)!;
const grid = keyGrid(audioLayer, comp.duration, settings.keysPerSecond);
console.log(`${keys.length} baked keys from ${keys[0].time.toFixed(3)} s, ${settings.keysPerSecond} per second; live grid ${grid.count} keys from ${grid.from.toFixed(3)} s`);
const analysis = createAnalysis(settings, grid, RATE, read);

const started = performance.now();
const times = keys.map((k) => k.time).filter((_, i) => i % 3 === 0);
const between = times.slice(0, -1).map((t) => t + spacing / 2);
const report = (label: string, at: number[]) => {
  const live = at.map((t) => outputsOf(analysis, settings, t));
  settings.ranges.forEach((range, r) => {
    const baked = at.map((t) => valueAtTime(outputs[r], t, layer) as number);
    const span = Math.max(...baked) - Math.min(...baked) || 1;
    const errors = baked.map((b, i) => (Math.abs(live[i][r] - b) / span) * 100);
    errors.sort((a, b) => a - b);
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    console.log(
      `${label} ${outputs[r].name} (falloff ${range.falloff}, ${range.falloffTime} s): mean ${mean.toFixed(1)}%, median ${errors[errors.length >> 1].toFixed(1)}%, p95 ${errors[Math.floor(errors.length * 0.95)].toFixed(1)}% of ${span.toFixed(1)}`,
    );
  });
};
if (process.env.SK_AT) {
  for (const t of process.env.SK_AT.split(",").map(Number)) {
    console.log(`t=${t}: live ${outputsOf(analysis, settings, t).map((v) => v.toFixed(1)).join(" ")} baked ${outputs.map((p) => (valueAtTime(p, t, layer) as number).toFixed(1)).join(" ")}`);
  }
}
report("at keys", times);
report("between", between);
console.log(`${((performance.now() - started) / (times.length + between.length)).toFixed(2)} ms per read`);
