// Prints the raw chunks of every Curves (ADBE CurvesCustom) curve parameter in a project.
//
//   node scripts/curves-blob.ts <project.aep>
import { readFileSync } from "node:fs";
import type { PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { chunkLabel, type Chunk } from "../src/aep/riff.ts";

const bytes = readFileSync(process.argv[2]);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const print = (c: Chunk, depth: number) => {
  const hex = c.children ? "" : ` ${c.data.length}b ${Buffer.from(c.data).toString("hex")}`;
  console.log(`${"  ".repeat(depth)}${chunkLabel(c)}${hex}`);
  for (const child of c.children ?? []) print(child, depth + 1);
};
function findArb(chunk: Chunk | undefined): Uint8Array | undefined {
  if (!chunk) return undefined;
  if (chunk.type === "LIST" && chunk.listType === "aRbs") return chunk.children?.find((c) => c.type === "aRbp")?.data;
  for (const child of chunk.children ?? []) {
    const hit = findArb(child);
    if (hit) return hit;
  }
  return undefined;
}

for (const item of project.items.values()) {
  if (item.kind !== "comp") continue;
  for (const layer of item.layers) {
    const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
    for (const fx of parade?.children ?? []) {
      if (fx.kind !== "group" || fx.matchName !== "ADBE CurvesCustom") continue;
      const curve = fx.children.find((c) => c.matchName === "ADBE CurvesCustom-0001");
      console.log(`== ${item.name} > ${layer.name} (enabled ${fx.enabled})`);
      const blob = curve?.kind === "property" ? curve.value : null;
      if (process.argv.includes("--summary")) {
        const data = blob instanceof Uint8Array ? blob : findArb(fx.chunk);
        if (!data) { console.log("  no aRbp"); continue; }
        ["RGB", "Red", "Green", "Blue", "Alpha"].forEach((channel, i) => {
          const table = data.subarray(4 + i * 256, 4 + i * 256 + 256);
          if (!table.every((v, j) => v === j)) console.log(`  ${channel} [0,64,128,192,255] -> ${[0, 64, 128, 192, 255].map((k) => table[k]).join(",")}`);
        });
      } else if (process.argv.includes("--effect") && fx.chunk) print(fx.chunk, 1);
      else if (curve?.kind === "property" && curve.chunk) print(curve.chunk, 1);
      if (process.argv.includes("--first")) process.exit(0);
    }
  }
}
