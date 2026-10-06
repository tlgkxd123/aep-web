// Lists a project's file footage and where the dev server's local footage
// resolver finds each file on this machine.
//
//   node scripts/footage-paths.ts <project.aep>
import { readFileSync } from "node:fs";
import { parseProject } from "../src/aep/parse.ts";
import { resolveFootage } from "../server/local-footage.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: node scripts/footage-paths.ts <project.aep>");
const bytes = readFileSync(path);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
for (const item of project.items.values()) {
  if (item.kind !== "footage" || item.mainSource.sourceType !== "FileSource") continue;
  const { file, sequence } = item.mainSource;
  const found = await resolveFootage(file);
  const range = sequence ? `  [sequence ${sequence.startFrame}-${sequence.endFrame}]` : "";
  console.log(`${found === file ? "found  " : found ? "relink " : "MISSING"} ${item.name}  ->  ${found ?? file}${range}`);
}
