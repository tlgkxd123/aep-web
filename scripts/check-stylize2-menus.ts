// Prints the popup menus of the effects in refs/fixtures/stylize2.aep, with the raw value of each entry.
// Usage: node scripts/check-stylize2-menus.ts [match name ...]
import { readFileSync } from "node:fs";
import { parseProject } from "../src/aep/parse.ts";
import type { PropertyGroup, PropertyNode } from "../src/aep/model.ts";

const wanted = new Set(process.argv.slice(2));
const project = parseProject(new Uint8Array(readFileSync("refs/fixtures/stylize2.aep")));
const seen = new Set<string>();

function visit(node: PropertyNode): void {
  if (node.kind !== "group") return;
  const group = node as PropertyGroup;
  if (group.matchName.startsWith("ADBE ") || group.matchName.startsWith("CC ") || group.matchName.startsWith("CS ")) {
    for (const child of group.children) {
      if (child.kind !== "property" || !child.options?.length) continue;
      const key = child.matchName;
      if (seen.has(key) || (wanted.size && !wanted.has(group.matchName))) continue;
      seen.add(key);
      console.log(`${key} ${child.name}: ${child.options.map((o, i) => `${i + 1}=${o}`).join(" | ")}`);
    }
  }
  for (const child of group.children) visit(child);
}

for (const item of project.items.values()) {
  if (item.kind !== "comp") continue;
  for (const layer of item.layers) for (const node of layer.properties) visit(node);
}
