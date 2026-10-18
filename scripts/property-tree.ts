// Prints the property tree of a project's layers: which properties are stored, left out (synth) or keyframed.
//   node scripts/property-tree.ts <file.aep> [layer name filter]
import { readFileSync } from "node:fs";
import type { PropertyNode } from "../src/aep/model.ts";
import { projectFromRifx } from "../src/aep/parse.ts";
import { readRifx } from "../src/aep/riff.ts";

const [file, filter = ""] = process.argv.slice(2);
const project = projectFromRifx(readRifx(new Uint8Array(readFileSync(file))));

const tree = (nodes: readonly PropertyNode[], depth: number): string[] =>
  nodes.flatMap((n) => {
    const head = `${"  ".repeat(depth)}${n.matchName}${n.name && n.name !== n.matchName ? ` "${n.name}"` : ""}`;
    if (n.kind === "group") return [`${head}${n.synthesized ? " (synth)" : ""}`, ...tree(n.children, depth + 1)];
    const value = n.value === null ? "" : typeof n.value === "object" && !Array.isArray(n.value) ? " = {…}" : ` = ${JSON.stringify(n.value)}`;
    return [`${head}${n.synthesized ? " (synth)" : ""}${n.keyframes.length ? ` [${n.keyframes.length} keys]` : value}`];
  });

for (const item of project.items.values()) {
  if (item.kind !== "comp") continue;
  for (const layer of item.layers) {
    if (!layer.name.includes(filter)) continue;
    console.log(`${item.name} > ${layer.name} (${layer.layerType})`);
    console.log(tree(layer.properties, 1).join("\n"));
  }
}
