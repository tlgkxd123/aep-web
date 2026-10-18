// Lists the parameters of an effect as the parser reads them from a project (by default the donor project
// After Effects saved with every effect at its factory defaults, refs/fixtures/donors/ae2025-effects.aep): index,
// name, control type (SDK PF_ParamType), popup options, stored value and keyframe count, nested by group.
//
//   node scripts/effect-params.ts <match name> [project.aep] [comp]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PropertyGroup, PropertyNode } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { ROOT } from "./lib/suites.ts";

const [matchName, path = join(ROOT, "fixtures", "donors", "ae2025-effects.aep"), compName] = process.argv.slice(2);
if (!matchName) throw new Error("usage: node scripts/effect-params.ts <match name> [project.aep] [comp]");
if (!existsSync(path)) throw new Error(`${path} does not exist (node scripts/ae-donors.ts writes the donor project)`);
const bytes = readFileSync(path);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));

let found: PropertyGroup | undefined;
let where = "";
for (const item of project.items.values()) {
  if (item.kind !== "comp" || (compName && item.name !== compName)) continue;
  for (const layer of item.layers) {
    const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
    found = parade?.children.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === matchName);
    if (found) {
      where = `comp "${item.name}", layer ${layer.index} "${layer.name}" (${layer.width}x${layer.height})`;
      break;
    }
  }
  if (found) break;
}
if (!found) throw new Error(`no layer applies "${matchName}" in ${path}`);
console.log(`${found.effectName ?? found.name} (${matchName}) in ${where}`);
const walk = (nodes: PropertyNode[], depth: number) => {
  for (const n of nodes) {
    const id = n.matchName.startsWith(`${matchName}-`) ? n.matchName.slice(matchName.length + 1) : n.matchName;
    const indent = "  ".repeat(depth);
    if (n.kind === "group") {
      console.log(`${indent}[${id}] ${n.name}`);
      walk(n.children, depth + 1);
      continue;
    }
    const value = JSON.stringify(n.value) ?? "null";
    const options = n.options?.length ? ` {${n.options.map((o, i) => `${i + 1}:${o}`).join(", ")}}` : "";
    const range = n.min !== undefined || n.max !== undefined ? ` [${n.min ?? ""}..${n.max ?? ""}]` : "";
    const keys = n.keyframes.length ? ` (${n.keyframes.length} keys)` : "";
    console.log(`${indent}${id} ${n.name} ct=${n.controlType ?? "-"}${range} = ${value.length > 100 ? value.slice(0, 100) + "..." : value}${keys}${options}`);
  }
};
walk(found.children, 1);
