// Lists every instance of an effect in a project with its parameters: index, name, value at
// time 0, keyframe count and expression.
//
//   node scripts/effect-instances.ts <project.aep> <effect match name> [comp name] [parameter name regex]
import { readFileSync } from "node:fs";
import type { CompItem, PropertyNode } from "../src/aep/model.ts";
import { valueAtTime } from "../src/aep/evaluate.ts";
import { parseProject } from "../src/aep/parse.ts";

const [file, matchName, compFilter, nameFilter] = process.argv.slice(2);
const names = nameFilter ? new RegExp(nameFilter, "i") : undefined;
const bytes = readFileSync(file);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const show = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : x))?.slice(0, 80);
for (const comp of project.items.values()) {
  if (comp.kind !== "comp" || (compFilter && comp.name !== compFilter)) continue;
  for (const layer of (comp as CompItem).layers) {
    const find = (nodes: readonly PropertyNode[]) => {
      for (const n of nodes) {
        if (n.kind !== "group") continue;
        if (n.isEffect && n.matchName === matchName) {
          console.log(`${comp.name} / ${layer.index}. ${layer.name}${n.enabled ? "" : " (off)"}`);
          n.children.forEach((p, i) => {
            if (names && !names.test(p.name)) return;
            if (p.kind === "group") return console.log(`  [${i}] ${p.matchName} "${p.name}" (group)`);
            const keys = p.keyframes.length > 1 ? ` keys=${p.keyframes.length}` : "";
            const expr = p.expression && p.expressionEnabled ? ` expr=${p.expression.replace(/\s+/g, " ").slice(0, 100)}` : "";
            console.log(`  [${i}] ${p.matchName} "${p.name}" = ${show(valueAtTime(p, 0, layer))}${keys}${expr}`);
          });
        } else find(n.children);
      }
    };
    find(layer.properties);
  }
}
