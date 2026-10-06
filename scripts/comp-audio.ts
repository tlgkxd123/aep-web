// Lists the layers of a composition with their audio switch, timing and source file.
//
//   node scripts/comp-audio.ts <project.aep> <comp name>
import { existsSync, readFileSync } from "node:fs";
import type { CompItem } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";

const [path, name] = process.argv.slice(2);
const bytes = readFileSync(path);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
for (const comp of [...project.items.values()].filter((i): i is CompItem => i.kind === "comp" && i.name === name)) {
  console.log(`${comp.name} (id ${comp.id}, ${comp.duration.toFixed(2)} s)`);
  for (const l of comp.layers) {
    const s = project.items.get(l.sourceId);
    const file = s?.kind === "footage" && s.mainSource.sourceType === "FileSource" ? s.mainSource.file : "";
    const where = file ? (existsSync(file) ? "exists" : "MISSING") : "";
    console.log(
      `  ${l.index} ${l.name} audio=${l.audioEnabled} start=${l.startTime.toFixed(2)} in=${l.inPoint.toFixed(2)} out=${l.outPoint.toFixed(2)} source=${s?.name ?? "-"}${s?.kind === "footage" ? ` hasAudio=${s.hasAudio}` : ""} ${file} ${where}`,
    );
  }
}
