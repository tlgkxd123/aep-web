// Lists the layers of comps that use Audio Spectrum: their effect stacks, masks
// (mode, vertex count, first vertices) and timing, and the audio layers they listen to.
//
//   node scripts/audspect-layers.ts <project.aep> [comp,comp]
import { readFileSync } from "node:fs";
import { valueAtTime } from "../src/aep/evaluate.ts";
import { isShapeValue, type CompItem, type PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";

const bytes = readFileSync(process.argv[2]);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const only = process.argv[3]?.split(",");
const group = (nodes: { kind: string; matchName: string }[], name: string) =>
  nodes.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === name);
for (const item of project.items.values()) {
  if (item.kind !== "comp" || (only && !only.includes(item.name))) continue;
  const uses = item.layers.some((l) => group(l.properties, "ADBE Effect Parade")?.children.some((e) => e.matchName === "ADBE AudSpect"));
  if (!uses && !only) continue;
  const comp = item as CompItem;
  console.log(`== ${comp.name} ${comp.width}x${comp.height} ${comp.frameRate} fps, ${comp.duration}s`);
  for (const layer of comp.layers) {
    const source = project.items.get(layer.sourceId);
    const sourceText = source ? `${source.kind}:${source.name}` + (source.kind === "footage" && source.mainSource.sourceType === "FileSource" ? `(${source.mainSource.fileName})` : "") : layer.layerType;
    const fx = group(layer.properties, "ADBE Effect Parade")?.children.map((e) => (e.kind === "group" ? `${e.matchName}${e.enabled ? "" : "(off)"}` : "")) ?? [];
    console.log(
      `#${layer.index} ${layer.name} [${sourceText}] start=${layer.startTime.toFixed(3)} in=${layer.inPoint.toFixed(3)} out=${layer.outPoint.toFixed(3)} stretch=${layer.stretch} blend=${layer.blendingMode} enabled=${layer.enabled} audio=${layer.audioEnabled} 3d=${layer.threeDLayer} fx=[${fx.join(", ")}]`,
    );
    for (const mask of group(layer.properties, "ADBE Mask Parade")?.children ?? []) {
      if (mask.kind !== "group") continue;
      const shapeProp = mask.children.find((c) => c.matchName === "ADBE Mask Shape");
      const shape = shapeProp?.kind === "property" ? valueAtTime(shapeProp, 0, layer) : null;
      const keys = shapeProp?.kind === "property" ? shapeProp.keyframes.length : 0;
      const text = isShapeValue(shape)
        ? `${shape.vertices.length} vertices closed=${shape.closed} first=${shape.vertices.slice(0, 3).map((v) => v.map((c) => c.toFixed(1)).join(",")).join(" ")} out0=${shape.outTangents[0]?.map((c) => c.toFixed(1))}`
        : "?";
      console.log(`    mask "${mask.name}" mode=${mask.mask?.maskMode} keys=${keys} ${text}`);
    }
  }
}
