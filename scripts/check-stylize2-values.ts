// Prints the stored values of one effect's parameters on each layer of a stylize2 comp, at full precision.
//
//   node scripts/check-stylize2-values.ts <comp> <match name>
import { readFileSync } from "node:fs";
import { parseProject } from "../src/aep/parse.ts";
import type { PropertyGroup, PropertyNode } from "../src/aep/model.ts";

const [compName, matchName] = process.argv.slice(2);
const project = parseProject(new Uint8Array(readFileSync("refs/fixtures/stylize2.aep")));

function find(nodes: PropertyNode[]): PropertyGroup | undefined {
  for (const node of nodes) {
    if (node.kind !== "group") continue;
    if (node.matchName === matchName) return node;
    const inner = find(node.children);
    if (inner) return inner;
  }
  return undefined;
}

for (const item of project.items.values()) {
  if (item.kind !== "comp" || item.name !== compName) continue;
  for (const layer of item.layers) {
    const effect = find(layer.properties);
    if (!effect) continue;
    const values = effect.children.map((c) => (c.kind === "property" ? `${c.matchName.slice(-2)} ${c.name}=${JSON.stringify(c.keyframes.length ? c.keyframes.map((k) => k.value) : c.value)}` : ""));
    console.log(`${layer.name}: ${values.join(" ")}`);
  }
}
