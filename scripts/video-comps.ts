// Lists a project's compositions that use movie footage, with the movies' names, sizes and rates.
//
//   node scripts/video-comps.ts <project.aep>
import { readFileSync } from "node:fs";
import type { FootageItem } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";

const bytes = readFileSync(process.argv[2]);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
for (const item of project.items.values()) {
  if (item.kind !== "comp") continue;
  const movies = item.layers.flatMap((layer) => {
    const source = layer.sourceId ? project.items.get(layer.sourceId) : undefined;
    if (source?.kind !== "footage" || source.mainSource.sourceType !== "FileSource" || source.mainSource.isStill) return [];
    const f = source as FootageItem;
    if (!/\.(mp4|mov|m4v|webm)$/i.test(f.mainSource.sourceType === "FileSource" ? f.mainSource.fileName : "")) return [];
    return [`${layer.name} [${f.width}x${f.height} ${f.frameRate}fps, in ${layer.inPoint.toFixed(2)}-${layer.outPoint.toFixed(2)}${layer.timeRemapEnabled ? ", remapped" : ""}${layer.stretch !== 1 ? `, stretch ${layer.stretch}` : ""}]`];
  });
  if (movies.length) console.log(`${item.name} (${item.width}x${item.height} ${item.frameRate}fps, ${item.duration.toFixed(1)}s): ${movies.join("; ")}`);
}
