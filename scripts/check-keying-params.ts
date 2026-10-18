// Prints the parameters one effect has on each layer of a keying comp, as the renderer reads them at a time.
//
//   node scripts/check-keying-params.ts <comp> <match name> [time s]
import { readFileSync } from "node:fs";
import { parseProject } from "../src/aep/parse.ts";
import type { PropertyGroup, PropertyNode } from "../src/aep/model.ts";
import { params } from "../src/render/effects/stockUtil.ts";

const [compName, matchName, timeArg] = process.argv.slice(2);
const time = Number(timeArg ?? 0);
const project = parseProject(new Uint8Array(readFileSync("refs/fixtures/keying.aep")));

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
    const p = params(effect, layer, time);
    const values = effect.children.map((c, i) => `p${i + 1}(${c.matchName.slice(matchName.length + 1)})=${JSON.stringify(p.vec(i + 1, [Number.NaN]))}/${p.num(i + 1, Number.NaN)}`);
    console.log(`${layer.name}: ${values.join(" ")}`);
    if (process.env.KEYING_RAW) {
      const node = effect.children[Number(process.env.KEYING_RAW) - 1];
      console.log(JSON.stringify(node, (k, v) => (k === "children" && Array.isArray(v) && v.length > 8 ? `[${v.length} children]` : v)).slice(0, 1500));
    }
  }
}
