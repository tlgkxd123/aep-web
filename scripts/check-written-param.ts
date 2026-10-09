// Checks with After Effects that an effect parameter it left out of the file, once written by
// the editor, opens and takes effect: moves CC Vignette's Center on fxextra_vignette_pin,
// renders the original and the edited project with aerender, and reports where the vignette's
// bright centre went.
//
//   node scripts/check-written-param.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Property } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";
import { setPropertyValue } from "../src/edit/stored-property.ts";
import { aerender } from "./aerender.ts";
import { readTiff } from "./lib/tiff.ts";

const COMP = "fxextra_vignette_pin";
const out = resolve("refs/probe/written-param");
mkdirSync(out, { recursive: true });
const editor = Editor.fromBytes(new Uint8Array(readFileSync("refs/fixtures/fxextra.aep")));
const comp = [...editor.project.items.values()].find((i) => i.kind === "comp" && i.name === COMP);
if (comp?.kind !== "comp") throw new Error(`no comp ${COMP}`);
const vignetteOf = (l: (typeof comp.layers)[number]) => {
  const parade = l.properties.find((n) => n.kind === "group" && n.matchName === "ADBE Effect Parade");
  const effect = parade?.kind === "group" ? parade.children.find((n) => n.kind === "group" && n.matchName === "CS Vignette") : undefined;
  return effect?.kind === "group" ? effect : undefined;
};
const param = (l: (typeof comp.layers)[number], matchName: string) => vignetteOf(l)?.children.find((n) => n.matchName === matchName) as Property | undefined;
// A layer whose Center After Effects left out (on a grey source, so any vignette shows where it is centred).
const layer = comp.layers.find((l) => param(l, "CS Vignette-0003")?.synthesized)!;
const center = layer && param(layer, "CS Vignette-0003");
if (!center?.synthesized) throw new Error("Center is stored in this fixture; pick another left-out parameter");
console.log(`Center was left out at ${JSON.stringify(center.value)} on a ${layer.width}x${layer.height} layer`);
const target = [layer.width * 0.2, layer.height * 0.25];
setPropertyValue(editor, comp, layer, center, target, 0);
const edited = join(out, "edited.aep");
writeFileSync(edited, editor.save());
console.log(`wrote Center = ${JSON.stringify(target)} into ${edited}`);

async function render(project: string, name: string) {
  const dir = join(out, name);
  mkdirSync(dir, { recursive: true });
  const result = await aerender(["-project", project, "-comp", COMP, "-s", "0", "-e", "0", "-OMtemplate", "Secuencia TIFF con alfa", "-output", join(dir, "frame_[#####].tif"), "-sound", "OFF"], 180_000);
  if (result.code !== 0) throw new Error(`aerender failed for ${name}:\n${result.output.slice(-2000)}`);
  return readTiff(new Uint8Array(readFileSync(join(dir, "frame_00000.tif"))));
}

/** Brightness-weighted centroid of the frame's brightest tenth (a white vignette is brightest at its centre). */
function brightCentre(img: { width: number; height: number; data: Uint8Array }): [number, number] {
  const lum = (i: number) => img.data[i * 4] + img.data[i * 4 + 1] + img.data[i * 4 + 2];
  const all = Array.from({ length: img.width * img.height }, (_, i) => lum(i)).sort((a, b) => a - b);
  const cut = all[Math.floor(all.length * 0.9)];
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    if (lum(i) < cut) continue;
    sx += i % img.width;
    sy += Math.floor(i / img.width);
    n++;
  }
  return [sx / n, sy / n];
}

// Control: the same layer's stored Amount changed instead, which After Effects certainly reads.
const control = Editor.fromBytes(new Uint8Array(readFileSync("refs/fixtures/fxextra.aep")));
const controlComp = [...control.project.items.values()].find((i) => i.kind === "comp" && i.name === COMP);
if (controlComp?.kind === "comp") {
  const controlLayer = controlComp.layers.find((l) => l.id === layer.id)!;
  const amount = param(controlLayer, "CS Vignette-0001")!;
  console.log(`control: Amount ${JSON.stringify(amount.value)} (stored: ${!amount.synthesized}) -> ${(amount.value as number) + 200}`);
  setPropertyValue(control, controlComp, controlLayer, amount, (amount.value as number) + 200, 0);
  writeFileSync(join(out, "control.aep"), control.save());
}

const original = await render(resolve("refs/fixtures/fxextra.aep"), "original");
const controlled = await render(join(out, "control.aep"), "control");
let controlDiffering = 0;
for (let i = 0; i < original.data.length; i += 4) if (Math.abs(original.data[i] - controlled.data[i]) > 3) controlDiffering++;
console.log(`control render: ${controlDiffering} pixels changed`);
const changed = await render(edited, "edited");
let differing = 0;
for (let i = 0; i < original.data.length; i += 4) if (Math.abs(original.data[i] - changed.data[i]) > 3) differing++;
console.log(`After Effects opened the edited project; ${differing} of ${original.width * original.height} pixels changed`);
console.log(`bright centre: original ${brightCentre(original).map((v) => v.toFixed(1))}, edited ${brightCentre(changed).map((v) => v.toFixed(1))}`);
