// Deletes an effect, or switches it off, on a fixture layer whose first effect draws something, saves the
// project, and has After Effects render a frame of it: After Effects must open each edited file and render the
// comp as this app does, with something on screen.
//
//   node scripts/check-effect-edits.ts
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CompItem, Layer, PropertyGroup } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";
import { aerender } from "./aerender.ts";
import { decodePng } from "./lib/png-decode.ts";
import { readTiff } from "./lib/tiff.ts";

const effectsOf = (layer: Layer): PropertyGroup[] => {
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
  return parade?.children.filter((n): n is PropertyGroup => n.kind === "group" && !!n.isEffect) ?? [];
};

const root = resolve("refs", "probe", "effect-edits");
rmSync(root, { recursive: true, force: true });
let failed = false;

for (const edit of ["delete", "switch off"] as const) {
  const editor = Editor.fromBytes(new Uint8Array(readFileSync(join("refs", "fixtures", "fxmisc.aep"))));
  const comp = [...editor.project.items.values()].find(
    (i): i is CompItem => i.kind === "comp" && i.layers.some((l) => effectsOf(l)[0]?.matchName === "ADBE AudSpect" && effectsOf(l).length >= 2),
  );
  if (!comp) throw new Error("fxmisc.aep has no Audio Spectrum layer with a second effect");
  const layer = comp.layers.find((l) => effectsOf(l)[0]?.matchName === "ADBE AudSpect" && effectsOf(l).length >= 2)!;
  const second = effectsOf(layer)[1];
  if (edit === "delete") editor.removeEffect(comp, layer, second);
  else editor.setEffectEnabled(comp, layer, second, false);

  const dir = join(root, edit.replace(" ", "-"));
  mkdirSync(dir, { recursive: true });
  const project = join(dir, "edited.aep");
  writeFileSync(project, editor.save());
  const result = await aerender([
    "-project", project,
    "-comp", comp.name,
    "-s", "0",
    "-e", "0",
    "-OMtemplate", process.env.AE_TIFF_TEMPLATE ?? "Secuencia TIFF con alfa",
    "-output", join(dir, "frame_[#####].tif"),
    "-sound", "OFF",
  ]);
  if (result.code !== 0 || !existsSync(join(dir, "frame_00000.tif"))) {
    console.log(`${edit} "${second.name}": aerender exit ${result.code}, no frame\n${result.output.split("\n").slice(-20).join("\n")}`);
    failed = true;
    continue;
  }

  execSync(`node scripts/render-frame.ts "${project}" "${comp.name}" 0 "${join(dir, "ours")}" --no-build`, { stdio: "ignore" });
  const ae = readTiff(new Uint8Array(readFileSync(join(dir, "frame_00000.tif"))));
  const ours = decodePng(new Uint8Array(readFileSync(join(dir, "ours_0.png"))));
  let differing = 0;
  let total = 0;
  let covered = 0;
  for (let i = 0; i < ae.data.length; i += 4) {
    let worst = 0;
    for (let c = 0; c < 4; c++) {
      const a = c === 3 ? ae.data[i + 3] : (ae.data[i + c] * ae.data[i + 3]) / 255;
      const b = c === 3 ? ours.rgba[i + 3] : (ours.rgba[i + c] * ours.rgba[i + 3]) / 255;
      total += Math.abs(a - b);
      worst = Math.max(worst, Math.abs(a - b));
    }
    if (worst > 3) differing++;
    if (ae.data[i + 3] > 0 && ae.data[i] + ae.data[i + 1] + ae.data[i + 2] > 0) covered++;
  }
  const pixels = ae.width * ae.height;
  const off = differing / pixels;
  console.log(
    `${comp.name} / ${layer.name}, ${edit} "${second.name}": After Effects opened and rendered it; ` +
      `${((covered / pixels) * 100).toFixed(1)} % of the frame drawn; ${(off * 100).toFixed(3)} % of pixels off by more than 3/255 from ours, mean error ${(total / (pixels * 4)).toFixed(3)}/255`,
  );
  if (ae.width !== ours.width || off > 0.01 || covered === 0) failed = true;
}
if (failed) process.exit(1);
console.log("EFFECT-EDITS-OPEN-IN-AE");
