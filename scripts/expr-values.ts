// Evaluates every expression of a comp whose text matches a pattern, at given comp times.
//
//   node scripts/expr-values.ts <project.aep> <comp> <pattern> <t1,t2,...>
import { readFileSync } from "node:fs";
import { currentValue, setExpressionScope } from "../src/aep/evaluate.ts";
import type { CompItem, Property, PropertyNode } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import "../src/expressions/install.ts";

const [path, compName, pattern, times] = process.argv.slice(2);
const bytes = readFileSync(path);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const warnings = new Set<string>();
setExpressionScope({ project, warn: (m) => warnings.add(m) });
const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName)!;
const re = new RegExp(pattern, "i");
const visit = (nodes: PropertyNode[], path: string, layer: CompItem["layers"][number]) => {
  for (const n of nodes) {
    if (n.kind === "group") visit(n.children, `${path}/${n.name}`, layer);
    else if (n.expression && re.test(n.expression)) {
      const values = times.split(",").map((t) => {
        const v = currentValue(n as Property, Number(t), layer, nodes);
        return Array.isArray(v) ? `[${v.map((x) => (typeof x === "number" ? x.toFixed(2) : x)).join(",")}]` : typeof v === "number" ? v.toFixed(3) : JSON.stringify(v);
      });
      console.log(`${layer.name}${path}/${n.name}: ${values.join(" | ")}`);
    }
  }
};
for (const layer of comp.layers) visit(layer.properties, "", layer);
for (const w of warnings) console.log("WARN", w);
