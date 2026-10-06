// Prints the switches of every layer whose name matches a pattern.
//
//   node scripts/layer-flags.ts <project.aep> <layer name regex>
import { readFileSync } from "node:fs";
import { parseProject } from "../src/aep/parse.ts";

const [path, pattern] = process.argv.slice(2);
const bytes = readFileSync(path);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const re = new RegExp(pattern);
for (const item of project.items.values()) {
  if (item.kind !== "comp") continue;
  for (const l of item.layers) {
    if (!re.test(l.name)) continue;
    const { enabled, solo, guideLayer, adjustmentLayer, nullLayer, effectsActive, inPoint, outPoint } = l;
    console.log(`${item.name} > ${l.name}: ${JSON.stringify({ enabled, solo, guideLayer, adjustmentLayer, nullLayer, effectsActive, inPoint, outPoint })}`);
  }
}
