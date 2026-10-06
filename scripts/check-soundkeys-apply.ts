// Runs Sound Keys' Apply on a project (the audio decoded with ffmpeg) and compares
// the generated Output keys with the keys already baked there by After Effects
// over the same work area; then checks they survive a save and reload.
//
//   node scripts/check-soundkeys-apply.ts <project.aep> <comp> <sound keys layer> <audio file>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompItem, Property, PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { Editor } from "../src/edit/editor.ts";
import { registerAudio, type AudioData } from "../src/media/audio.ts";
import { applySoundKeys } from "../src/media/soundKeysApply.ts";

const [path, compName, layerName, audioFile] = process.argv.slice(2);
const editor = Editor.fromBytes(new Uint8Array(readFileSync(path)));
const project = editor.project;
const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName)!;
const layer = comp.layers.find((l) => l.name === layerName)!;
const effectOf = (l: typeof layer) =>
  l.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade")!.children.find(
    (n): n is PropertyGroup => n.kind === "group" && n.matchName === "tc Sound Keys",
  )!;
const outputs = ["0021", "0033", "0045"];
const keysOf = (fx: PropertyGroup) =>
  outputs.map((id) => (fx.children.find((c): c is Property => c.kind === "property" && c.matchName === `tc Sound Keys-${id}`)!.keyframes ?? []).map((k) => [k.time, k.value as number] as const));
const before = keysOf(effectOf(layer));

const RATE = 44100;
const raw = join(tmpdir(), "sk-audio-stereo.f32");
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", audioFile, "-ac", "2", "-ar", String(RATE), "-f", "f32le", raw]);
const buf = readFileSync(raw);
const interleaved = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const planes = [0, 1].map((c) => Float32Array.from({ length: interleaved.length / 2 }, (_, i) => interleaved[i * 2 + c]));
const audio: AudioData = { sampleRate: RATE, numberOfChannels: 2, length: planes[0].length, getChannelData: (c) => planes[c] };
const audioIndex = effectOf(layer).children.find((c) => c.matchName === "tc Sound Keys-0001");
const audioLayer = comp.layers.find((l) => l.index === (audioIndex?.kind === "property" ? audioIndex.value : 0))!;
registerAudio(audioLayer.sourceId, audio);

const started = performance.now();
console.log(await applySoundKeys(editor, project, comp, layer, effectOf(layer)), `in ${((performance.now() - started) / 1000).toFixed(1)} s`);

const reloaded = parseProject(editor.save());
const comp2 = [...reloaded.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName)!;
const after = keysOf(effectOf(comp2.layers.find((l) => l.name === layerName)!));
const decreasing = after[2].filter((k, i) => i > 0 && k[1] < after[2][i - 1][1]).length;
console.log(`Output 3 after Apply: ${after[2].length} keys from ${after[2][0]?.[0].toFixed(2)} s to ${after[2].at(-1)?.[0].toFixed(2)} s, ${decreasing} decreasing steps`);
const from = comp.workAreaStart;
const to = from + comp.workAreaDuration;
outputs.forEach((id, o) => {
  const truth = new Map(before[o].filter(([t]) => t >= from && t <= to).map(([t, v]) => [Math.round(t * 600), v]));
  const mine = after[o].filter(([t]) => t >= from && t <= to);
  const outside = after[o].length - mine.length;
  const keptOutside = before[o].filter(([t]) => t < from || t > to).length;
  let sq = 0;
  let n = 0;
  let firstDelta = 0;
  const deltas: number[] = [];
  mine.forEach(([t, v], i) => {
    const ref = truth.get(Math.round(t * 600));
    if (ref === undefined) return;
    if (id === "0045") {
      if (i > 0) {
        const prevRef = truth.get(Math.round(mine[i - 1][0] * 600));
        if (prevRef !== undefined) deltas.push(v - mine[i - 1][1] - (ref - prevRef));
      } else firstDelta = v - ref;
      return;
    }
    sq += (v - ref) ** 2;
    n++;
  });
  if (process.env.SK_SHOW) {
    const show = mine.filter(([t]) => t > 65.77 && t < 66.0);
    console.log(`  t     ${show.map(([t]) => t.toFixed(2).slice(-5).padStart(6)).join("")}`);
    console.log(`  AE    ${show.map(([t]) => (truth.get(Math.round(t * 600)) ?? NaN).toFixed(1).padStart(6)).join("")}`);
    console.log(`  ours  ${show.map(([, v]) => v.toFixed(1).padStart(6)).join("")}`);
  }
  if (id === "0045") {
    const sorted = deltas.map(Math.abs).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const refs = mine.map(([t]) => truth.get(Math.round(t * 600))).filter((v): v is number => v !== undefined);
    const gainOurs = mine[mine.length - 1][1] - mine[0][1];
    const gainAe = refs.length > 1 ? refs[refs.length - 2] - refs[0] : NaN;
    console.log(`Output 3 (integrate): ${mine.length} keys in the work area; median per-key increment error ${median.toFixed(3)}; accumulated ${gainOurs.toFixed(1)} vs After Effects ${gainAe.toFixed(1)}; ${outside} keys outside (was ${keptOutside}); offset at start ${firstDelta.toFixed(1)}`);
  } else {
    console.log(`Output ${o + 1}: ${mine.length} keys in the work area, rms error vs After Effects ${Math.sqrt(sq / (n || 1)).toFixed(2)}; ${outside} keys outside (was ${keptOutside})`);
  }
});
