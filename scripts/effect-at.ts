// Prints an effect's parameter values at given comp times (keyframes and expressions shown).
//
//   node scripts/effect-at.ts <project.aep> <comp> <layer index> <effect match name> <t1,t2,...>
import { readFileSync } from "node:fs";
import { currentValue } from "../src/aep/evaluate.ts";
import type { CompItem, PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";

const [path, compName, index, matchName, times] = process.argv.slice(2);
const bytes = readFileSync(path);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName)!;
const layer = comp.layers.find((l) => l.index === Number(index))!;
const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
const fx = parade?.children.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === matchName);
if (!fx) throw new Error(`no ${matchName} on ${layer.name}`);
console.log(`${comp.name} > ${layer.name} > ${fx.name}`);
for (const p of fx.children) {
  if (p.kind !== "property") continue;
  const keys = p.keyframes.length ? ` keys=${p.keyframes.map((k) => `${k.time.toFixed(2)}s:${JSON.stringify(k.value)}`).join(" ")}` : "";
  const expr = p.expressionEnabled ? ` expr=${JSON.stringify(p.expression).slice(0, 120)}` : "";
  const values = times.split(",").map((t) => JSON.stringify(currentValue(p, Number(t), layer, fx.children))).join(" | ");
  console.log(`  ${p.matchName} ${p.name}: ${values}${keys}${expr}`);
}
