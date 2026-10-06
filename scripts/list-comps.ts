// Prints every composition of a project with size, frame rate, duration, work area and layer kinds.
//   node scripts/list-comps.ts <file.aep>
import { readFileSync } from "node:fs";
import { parseProject } from "../src/aep/parse.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: node scripts/list-comps.ts <file.aep>");
const project = parseProject(new Uint8Array(readFileSync(file)));
for (const item of project.items.values()) {
  if (item.kind !== "comp") continue;
  const kinds = item.layers.map((l) => l.layerType.replace("Layer", "")).join(",");
  console.log(
    `${item.name.padEnd(30)} ${item.width}x${item.height} ${item.frameRate}fps dur ${item.duration.toFixed(3)} work ${item.workAreaStart.toFixed(3)}+${item.workAreaDuration.toFixed(3)} res ${item.resolutionFactor.join("/")} bg ${item.bgColor.map((c) => c.toFixed(2)).join(",")} [${kinds}]`,
  );
}
