// Lists compositions whose audio-enabled layers reach footage with audio (directly or through precomps).
//
//   node scripts/export/list-audio-comps.ts <project.aep>
import { readFileSync } from "node:fs";
import type { CompItem, Project } from "../../src/aep/model.ts";
import { parseProject } from "../../src/aep/parse.ts";

const bytes = readFileSync(process.argv[2]);
const project: Project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const describe = (comp: CompItem, depth: number): string[] =>
  comp.layers.flatMap((l) => {
    if (!l.audioEnabled || depth > 8) return [];
    const s = project.items.get(l.sourceId);
    const at = `start=${l.startTime.toFixed(3)} in=${l.inPoint.toFixed(3)} out=${l.outPoint.toFixed(3)} stretch=${l.stretch}`;
    if (s?.kind === "footage" && s.hasAudio && s.mainSource.sourceType === "FileSource") return [`${"  ".repeat(depth)}${l.name} ${at} ${s.mainSource.file}`];
    if (s?.kind === "comp") {
      const inner = describe(s, depth + 1);
      return inner.length ? [`${"  ".repeat(depth)}${l.name} (precomp) ${at}`, ...inner] : [];
    }
    return [];
  });
for (const item of project.items.values()) {
  if (item.kind !== "comp") continue;
  const lines = describe(item, 1);
  if (lines.length) console.log(`${item.name} ${item.width}x${item.height} ${item.frameRate}fps ${item.duration.toFixed(2)}s work ${item.workAreaStart}+${item.workAreaDuration}\n${lines.join("\n")}`);
}
