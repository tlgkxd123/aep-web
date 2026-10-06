// Prints every effect instance of a project with its enabled state and parameter values.
//
//   node scripts/effect-values.ts <project.aep> [compName]
import { readFileSync } from "node:fs";
import type { PropertyNode } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";

const [path, onlyComp] = process.argv.slice(2);
const bytes = readFileSync(path);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 80);
for (const item of project.items.values()) {
  if (item.kind !== "comp" || (onlyComp && item.name !== onlyComp)) continue;
  for (const layer of item.layers) {
    const parade = layer.properties.find((n) => n.matchName === "ADBE Effect Parade");
    if (parade?.kind !== "group") continue;
    for (const fx of parade.children) {
      if (fx.kind !== "group") continue;
      console.log(`${item.name} > ${layer.name} > ${fx.name} (${fx.matchName}) enabled=${fx.enabled}`);
      const walk = (nodes: PropertyNode[], indent: string) => {
        for (const n of nodes) {
          if (n.kind === "group") walk(n.children, indent + "  ");
          else console.log(`${indent}${n.matchName} ${n.name} = ${show(n.value)}${n.keyframes.length ? ` (${n.keyframes.length} keys)` : ""}`);
        }
      };
      walk(fx.children, "    ");
    }
  }
}
