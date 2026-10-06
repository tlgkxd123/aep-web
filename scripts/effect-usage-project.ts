// Counts the effects a project uses and whether the browser renderer registers them.
//
//   node scripts/effect-usage-project.ts <project.aep>
import { readFileSync } from "node:fs";
import type { PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { effectRenderer } from "../src/render/registry.ts";
import "../src/render/features.ts";

const bytes = readFileSync(process.argv[2]);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const usage = new Map<string, { name: string; count: number }>();
for (const item of project.items.values()) {
  if (item.kind !== "comp") continue;
  for (const layer of item.layers) {
    const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
    for (const fx of parade?.children ?? []) {
      if (fx.kind !== "group") continue;
      const entry = usage.get(fx.matchName) ?? { name: fx.effectName ?? fx.name, count: 0 };
      entry.count++;
      usage.set(fx.matchName, entry);
    }
  }
}
for (const [matchName, { name, count }] of [...usage].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`${String(count).padStart(4)}  ${effectRenderer(matchName) ? "ok     " : "MISSING"}  ${name} (${matchName})`);
}
