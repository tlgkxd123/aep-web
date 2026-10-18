// Lists the parameters of the first Particular instance of a comp: index, name, control type, popup options and
// the stored value, as the parser reads them.
//
//   node scripts/particular-params.ts <project.aep> <comp> [name filter]
import { readFileSync } from "node:fs";
import type { CompItem, PropertyGroup, PropertyNode } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";

const [path, compName, filter = ""] = process.argv.slice(2);
const bytes = readFileSync(path);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName)!;
for (const layer of comp.layers) {
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
  const fx = parade?.children.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "tc Particular");
  if (!fx) continue;
  console.log(`layer ${layer.index} "${layer.name}"`);
  const walk = (nodes: PropertyNode[], depth: number) => {
    for (const n of nodes) {
      const id = n.matchName.replace("tc Particular-", "");
      if (n.kind === "group") {
        console.log(`${"  ".repeat(depth)}[${id}] ${n.name}`);
        walk(n.children, depth + 1);
        continue;
      }
      if (filter && !n.name.toLowerCase().includes(filter.toLowerCase())) continue;
      const value = JSON.stringify(n.value);
      const options = n.options?.length ? ` {${n.options.map((o, i) => `${i + 1}:${o}`).join(", ")}}` : "";
      const keys = n.keyframes.length ? ` (${n.keyframes.length} keys)` : "";
      console.log(`${"  ".repeat(depth)}${id} ${n.name} ct=${n.controlType ?? "-"} = ${value && value.length > 80 ? value.slice(0, 80) + "..." : value}${keys}${options}`);
    }
  };
  walk(fx.children, 1);
  break;
}
