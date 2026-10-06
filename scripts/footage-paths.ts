// Lists a project's file footage and whether each file exists on this machine.
//
//   node scripts/footage-paths.ts <project.aep>
import { existsSync, readFileSync } from "node:fs";
import { parseProject } from "../src/aep/parse.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: node scripts/footage-paths.ts <project.aep>");
const bytes = readFileSync(path);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
for (const item of project.items.values()) {
  if (item.kind !== "footage" || item.mainSource.sourceType !== "FileSource") continue;
  const file = item.mainSource.file;
  console.log(`${existsSync(file) ? "found  " : "MISSING"} ${item.name}  ->  ${file}`);
}
