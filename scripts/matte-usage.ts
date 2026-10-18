// Lists every track matte of a project: the matted layer, its matte layer and how they relate in the stack.
//
//   node scripts/matte-usage.ts <project.aep>
import { readFileSync } from "node:fs";
import type { CompItem } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { matteLayerOf } from "../src/render/composition.ts";

const bytes = readFileSync(process.argv[2]);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
for (const item of project.items.values()) {
  if (item.kind !== "comp") continue;
  const comp = item as CompItem;
  for (const l of comp.layers) {
    if (l.trackMatteType === 5012) continue;
    const m = matteLayerOf(l, comp);
    const flags = m
      ? [
          `matte=${m.index}.${m.name}`,
          `offset=${m.index - l.index}`,
          m.enabled ? "matte-visible" : "matte-off",
          m.trackMatteType !== 5012 && `matte-has-matte=${m.trackMatteType}`,
          m.threeDLayer !== l.threeDLayer && `3D:${l.threeDLayer}/${m.threeDLayer}`,
          m.adjustmentLayer && "matte-adjustment",
          m.parentId && "matte-parented",
          (m.inPoint !== l.inPoint || m.outPoint !== l.outPoint) && `span ${l.inPoint.toFixed(2)}-${l.outPoint.toFixed(2)} vs ${m.inPoint.toFixed(2)}-${m.outPoint.toFixed(2)}`,
          m.layerType,
          project.items.get(m.sourceId)?.kind,
        ]
      : ["NO MATTE LAYER"];
    console.log(`${comp.name} | ${l.index}.${l.name} type=${l.trackMatteType} id=${l.trackMatteLayerId} | ${flags.filter(Boolean).join(" ")}`);
  }
}
