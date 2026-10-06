// Times the expression engine on every expression of refs/fixtures/expr.aep:
// compile time per expression, and evaluation time per property with a fresh
// result cache (as on each rendered frame).
//
//   node scripts/expr-bench.ts [project.aep]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currentValue, setExpressionScope } from "../src/aep/evaluate.ts";
import type { CompItem, Layer, Property, PropertyNode } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { compileExpression } from "../src/expressions/compile.ts";
import "../src/expressions/install.ts";
import { ROOT } from "./lib/suites.ts";

const file = process.argv[2] ?? join(ROOT, "fixtures", "expr.aep");
const project = parseProject(new Uint8Array(readFileSync(file)));
const targets: { layer: Layer; prop: Property; siblings: PropertyNode[]; comp: CompItem }[] = [];
for (const item of project.items.values()) {
  if (item.kind !== "comp") continue;
  for (const layer of item.layers) {
    const walk = (nodes: PropertyNode[]) => {
      for (const n of nodes) {
        if (n.kind === "group") walk(n.children);
        else if (n.expression && n.expressionEnabled) targets.push({ layer, prop: n, siblings: nodes, comp: item });
      }
    };
    walk(layer.properties);
  }
}

let start = performance.now();
const COMPILE_ROUNDS = 20;
for (let r = 0; r < COMPILE_ROUNDS; r++) for (const t of targets) compileExpression(t.prop.expression);
const compileUs = ((performance.now() - start) * 1000) / (COMPILE_ROUNDS * targets.length);

const ROUNDS = 200;
let warnings = 0;
start = performance.now();
for (let r = 0; r < ROUNDS; r++) {
  setExpressionScope({ project, warn: () => warnings++ });
  const time = (r % 24) / 24;
  for (const t of targets) currentValue(t.prop, time, t.layer, t.siblings);
}
const evalUs = ((performance.now() - start) * 1000) / (ROUNDS * targets.length);
setExpressionScope(undefined);

console.log(`${targets.length} expressions in ${file}`);
console.log(`compile: ${compileUs.toFixed(1)} us per expression`);
console.log(`evaluate: ${evalUs.toFixed(1)} us per property per frame (fresh cache each frame, including referenced properties; ${warnings} warnings)`);
