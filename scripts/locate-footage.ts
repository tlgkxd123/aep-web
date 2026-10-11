// Prints where the dev server would find each footage file of a project (scripts and benchmarks use the same
// relink search the app does).
//
//   node scripts/locate-footage.ts <project.aep> [name filter]
import { readFileSync } from "node:fs";
import { parseProject } from "../src/aep/parse.ts";
import { resolveFootage } from "../server/local-footage.ts";

const [file, filter] = process.argv.slice(2);
const bytes = readFileSync(file);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
for (const item of project.items.values()) {
  if (item.kind !== "footage" || item.mainSource.sourceType !== "FileSource") continue;
  if (filter && !item.name.toLowerCase().includes(filter.toLowerCase())) continue;
  console.log(`${item.name} -> ${(await resolveFootage(item.mainSource.file)) ?? "(not found)"}`);
}
