// Prints the Trapcode Particular settings Particle Match derives from a trained
// model, and with --aep writes a project with the layers it creates (comp
// "pmatch_particular", no camera) for rendering in After Effects. --swing drives the
// model's clock with a synthetic bass pulse (twice a second) instead of silence, so
// Physics Time Factor is keyframed.
//
//   node scripts/pmatch-particular.ts [model.pmwm] [--size 1920x1080] [--fps 30] [--duration 10] [--swing] [--aep out.aep]
import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_COMP_SETTINGS, newComposition, newProject } from "../src/edit/project.ts";
import { BANDS, FEATURE_RATE, FEATURES, type AudioFeatures } from "../src/extra/pmatch/audio.ts";
import { decodeModel } from "../src/extra/pmatch/model.ts";
import { createParticularLayers, PARTICULAR_PARAM, particularSettings } from "../src/extra/pmatch/particular.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args.splice(at, 2)[1] : fallback;
};
const flag = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 && !!args.splice(at, 1).length;
};
const [width, height] = option("--size", "1920x1080").split("x").map(Number);
const frameRate = Number(option("--fps", "30"));
const duration = Number(option("--duration", "10"));
const aep = option("--aep", "");
const swing = flag("--swing");
const path = args[0] ?? "dist-tools/pmatch/model.pmwm";

/** Kicks in the two lowest bands twice a second: a sharp fast envelope and a smoother slow one. */
function pulse(seconds: number): AudioFeatures {
  const frames = Math.ceil(seconds * FEATURE_RATE);
  const data = new Float32Array(frames * FEATURES);
  for (let k = 0; k < frames; k++) {
    const phase = ((k / FEATURE_RATE) * 2) % 1;
    const fast = 3 * Math.exp(-phase * 12) - 1;
    const slow = 1.5 * Math.exp(-phase * 3) - 0.5;
    for (let b = 0; b < 2; b++) {
      data[k * FEATURES + b] = fast;
      data[k * FEATURES + BANDS + b] = slow;
    }
  }
  return { rate: FEATURE_RATE, frames, dims: FEATURES, data };
}

const model = decodeModel(new Uint8Array(readFileSync(path)));
const settings = particularSettings(model, { width, height, frameRate, duration, zoom: width / 0.72 }, swing ? pulse(duration) : null);
const names = new Map(Object.entries(PARTICULAR_PARAM).map(([name, n]) => [n as number, name]));
const factor = Array.isArray(settings.timeFactor)
  ? `${settings.timeFactor.length} keyframes, ${Math.min(...settings.timeFactor.map((k) => k.value))}..${Math.max(...settings.timeFactor.map((k) => k.value))}`
  : settings.timeFactor;
console.log(`${path}: ${model.weights.length} prototypes, mirror ${settings.mirror ? settings.mirror.map((v) => v.toFixed(1)).join(", ") : "none"}, time factor ${factor}`);
for (const layer of settings.layers) {
  console.log(`\n${layer.name}: ${(layer.share * 100).toFixed(1)} % of births, colour ${layer.color.map((v) => v.toFixed(3)).join(" ")}`);
  for (const [n, value] of layer.numbers) console.log(`  ${(names.get(n) ?? String(n)).padEnd(20)} ${value}`);
  const curve = (points: [number, number][]) => points.filter((_, k) => k % 4 === 0).map(([u, v]) => `${u.toFixed(2)}:${v.toFixed(2)}`).join(" ");
  console.log(`  size over life       ${curve(layer.sizeOverLife)}`);
  console.log(`  opacity over life    ${curve(layer.opacityOverLife)}`);
}

if (aep) {
  const editor = newProject();
  const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: "pmatch_particular", width, height, frameRate, duration });
  const ids = await createParticularLayers(editor, comp, settings);
  writeFileSync(aep, editor.save());
  console.log(`\n${ids.length} layers in "${comp.name}" -> ${aep}`);
}
