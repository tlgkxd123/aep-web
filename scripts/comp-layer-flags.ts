// Prints a comp's layers with their switches (adjustment, 3D, blend mode, track matte, size).
//
//   node scripts/comp-layer-flags.ts <project.aep> <comp name>
import { readFileSync } from "node:fs";
import type { CompItem } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";

const [file, compName] = process.argv.slice(2);
const bytes = readFileSync(file);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
for (const comp of project.items.values()) {
  if (comp.kind !== "comp" || comp.name !== compName) continue;
  console.log(`${comp.name} ${(comp as CompItem).width}x${(comp as CompItem).height}`);
  for (const l of (comp as CompItem).layers) {
    const flags = [
      l.adjustmentLayer && "adjustment",
      l.threeDLayer && "3D",
      l.blendingMode && `blend=${l.blendingMode}`,
      l.trackMatteType && `matte=${l.trackMatteType}`,
      !l.enabled && "off",
    ].filter(Boolean);
    const source = project.items.get(l.sourceId);
    console.log(`  ${l.index}. ${l.name} [${l.layerType} ${source?.kind ?? ""} ${l.width}x${l.height}] ${flags.join(" ")}`);
  }
}
