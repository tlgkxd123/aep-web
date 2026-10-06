// Lists the comps and layers of a project: node scripts/list-layers.ts <file.aep> [comp filter]
import { readFileSync } from "node:fs";
import { projectFromRifx } from "../src/aep/parse.ts";
import { readRifx } from "../src/aep/riff.ts";

const [file, filter = ""] = process.argv.slice(2);
const project = projectFromRifx(readRifx(new Uint8Array(readFileSync(file))));
for (const item of project.items.values()) {
  if (item.kind !== "comp" || !item.name.includes(filter)) continue;
  console.log(`${item.id} ${item.name} ${item.width}x${item.height} ${item.frameRate}fps ${item.duration}s`);
  for (const l of item.layers) {
    const source = project.items.get(l.sourceId);
    console.log(`  ${l.index} #${l.id} ${l.layerType} "${l.name}" src=${source?.kind ?? "-"} ${l.width}x${l.height} parent=${l.parentId} null=${l.nullLayer}`);
  }
}
