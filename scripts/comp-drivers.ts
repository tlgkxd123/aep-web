// Lists what animates a composition's layers (recursively into precomps): expressions, keyframed
// properties and effects, to find what can make two renders of the same frame differ.
//
//   node scripts/comp-drivers.ts <project.aep> <comp name> [depth=2]
import { readFileSync } from "node:fs";
import type { CompItem, PropertyNode } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";

const [file, compName, depthArg = "2"] = process.argv.slice(2);
const bytes = readFileSync(file);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const visit = (comp: CompItem, depth: number, indent: string) => {
  for (const layer of comp.layers) {
    const notes: string[] = [];
    const walk = (nodes: readonly PropertyNode[], path: string) => {
      for (const n of nodes) {
        if (n.kind === "group") {
          if (n.isEffect) notes.push(`fx ${n.matchName}${n.enabled ? "" : " (off)"}`);
          walk(n.children, `${path}${n.name}/`);
        } else {
          if (n.expression && n.expressionEnabled) notes.push(`expr ${path}${n.name}: ${n.expression.replace(/\s+/g, " ").slice(0, 120)}`);
          else if (n.keyframes.length > 1) notes.push(`keys ${path}${n.name} (${n.keyframes.length})`);
        }
      }
    };
    walk(layer.properties, "");
    const source = layer.sourceId ? project.items.get(layer.sourceId) : undefined;
    console.log(`${indent}${layer.index}. ${layer.name} [${source?.kind ?? layer.layerType}] ${layer.inPoint.toFixed(2)}-${layer.outPoint.toFixed(2)}${layer.enabled ? "" : " (off)"}`);
    for (const n of notes.slice(0, 12)) console.log(`${indent}    ${n}`);
    if (source?.kind === "comp" && depth > 0) visit(source, depth - 1, `${indent}  `);
  }
};
const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName);
if (!comp) throw new Error(`no comp ${compName}`);
visit(comp, Number(depthArg), "");
