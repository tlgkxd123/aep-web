// Keyframes of one effect parameter in a comp and its value at each frame (pre-expression).
//
//   node scripts/dg-keys.ts <project.aep> <comp> <param match name> [frames=8] [fps=24]
import { readFileSync } from "node:fs";
import { valueAtTime } from "../src/aep/evaluate.ts";
import type { PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";

const [file, compName, matchName, framesArg = "8", fpsArg = "24"] = process.argv.slice(2);
const bytes = readFileSync(file);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
for (const item of project.items.values()) {
  if (item.kind !== "comp" || item.name !== compName) continue;
  for (const layer of item.layers) {
    const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
    for (const fx of parade?.children ?? []) {
      if (fx.kind !== "group") continue;
      const prop = fx.children.find((n) => n.matchName === matchName);
      if (prop?.kind !== "property") continue;
      console.log(JSON.stringify(prop.keyframes, null, 0).slice(0, 2000));
      for (let f = 0; f < Number(framesArg); f++) console.log(`frame ${f}: ${JSON.stringify(valueAtTime(prop, f / Number(fpsArg), layer))}`);
    }
  }
}
