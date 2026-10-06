// Builds private probes of the user's Particular setup for After Effects references:
// "Real Particles" layer 1 switched on, once as saved (World Transform Y Rotation 90)
// and once with the World Transform zeroed. Writes refs/probe-pp*.aep and their
// manifests (refs/fixtures/private-pp*.manifest.json); neither is committed.
//
//   node scripts/probe-particular.ts [project.aep]
//   node scripts/render-refs.ts --suite private-pp90 && node scripts/pixel-report.ts --suite private-pp90
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CompItem, Property, PropertyGroup } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";
import { renameItem } from "../src/edit/project.ts";

const source = process.argv[2] ?? "C:/Users/schxm/projects/_user/bass-supreme.aep";
const FRAMES = [100, 200, 300];

for (const [tag, world] of [["pp90", undefined], ["pp0", [0, 0, 0, 0, 0, 0]]] as const) {
  const editor = Editor.fromBytes(new Uint8Array(readFileSync(source)));
  const comp = [...editor.project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === "Real Particles")!;
  const layer = comp.layers.find((l) => l.index === 1)!;
  editor.setLayerSwitch(comp, layer, "enabled", true);
  if (world) {
    const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade")!;
    const fx = parade.children.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "tc Particular")!;
    ["0290", "0291", "0292", "0293", "0294", "0295"].forEach((id, k) => {
      const prop = fx.children.find((c): c is Property => c.kind === "property" && c.matchName === `tc Particular-${id}`)!;
      // Parameters at their default are not stored (and cannot be edited).
      if (prop.value !== world[k]) editor.setValue(comp, layer, prop, world[k], 0);
    });
  }
  const name = `probe_${tag}`;
  renameItem(editor, comp, name);
  const out = resolve(`refs/probe-${tag}.aep`);
  writeFileSync(out, editor.save());
  writeFileSync(
    `refs/fixtures/private-${tag}.manifest.json`,
    JSON.stringify({ project: `../probe-${tag}.aep`, comps: [{ comp: name, frames: FRAMES, fps: 50 }] }, null, 1) + "\n",
  );
  console.log(`wrote ${out}`);
}
