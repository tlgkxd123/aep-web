// Lists every Sound Keys instance (parameters, keyframe counts) and the expressions that read it.
//
//   node scripts/soundkeys-usage.ts <project.aep>
import { readFileSync } from "node:fs";
import type { PropertyNode } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";

const bytes = readFileSync(process.argv[2]);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const walk = (nodes: PropertyNode[], visit: (n: PropertyNode, path: string) => void, path = "") => {
  for (const n of nodes) {
    visit(n, `${path}/${n.name}`);
    if (n.kind === "group") walk(n.children, visit, `${path}/${n.name}`);
  }
};
for (const item of project.items.values()) {
  if (item.kind !== "comp") continue;
  for (const layer of item.layers) {
    walk(layer.properties, (n, path) => {
      if (n.kind === "group" && n.matchName === "tc Sound Keys") {
        console.log(`== ${item.name} > ${layer.name} (layer ${layer.index}) enabled=${n.enabled}`);
        walk(n.children, (p, sub) => {
          if (p.kind !== "property") return console.log(`   [${p.matchName}] ${sub}`);
          const value = p.value instanceof Uint8Array ? `<${p.value.length} bytes>` : JSON.stringify(p.value);
          console.log(`   ${p.matchName} ${sub} = ${value}${p.keyframes.length ? ` (${p.keyframes.length} keys)` : ""}${p.expression ? ` expr: ${p.expression}` : ""}`);
        });
      }
      if (n.kind === "property" && n.expression && /Sound Keys|Output/i.test(n.expression)) {
        console.log(`EXPR ${item.name} > ${layer.name} ${path}: ${n.expression.replace(/\s+/g, " ").slice(0, 300)}`);
      }
    });
  }
}
