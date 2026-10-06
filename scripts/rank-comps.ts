// Ranks corpus compositions by a rough render cost (pixels x drawable layers,
// shape items and masks, nested comps counted recursively) to pick profiling targets.
//   node scripts/rank-comps.ts [--samples DIR] [--top 20]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { CompItem, Project, PropertyNode } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { SAMPLES } from "./lib/paths.ts";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const dir = resolve(opt("--samples") ?? SAMPLES);
const top = Number(opt("--top") ?? 20);

function* walk(d: string): Generator<string> {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) yield* walk(f);
    else if (n.endsWith(".aep")) yield f;
  }
}

function countItems(nodes: PropertyNode[], matchName: RegExp): number {
  let n = 0;
  for (const node of nodes) {
    if (matchName.test(node.matchName)) n++;
    if (node.kind === "group") n += countItems(node.children, matchName);
  }
  return n;
}

function cost(project: Project, comp: CompItem, depth = 0): { layers: number; shapes: number; masks: number; cost: number } {
  let layers = 0;
  let shapes = 0;
  let masks = 0;
  let total = 0;
  for (const layer of comp.layers) {
    if (!layer.enabled || layer.nullLayer || layer.guideLayer) continue;
    if (layer.layerType !== "AVLayer" && layer.layerType !== "ShapeLayer") continue;
    layers++;
    const s = layer.layerType === "ShapeLayer" ? countItems(layer.properties, /^ADBE Vector (Shape|Graphic)/) : 0;
    const m = countItems(layer.properties, /^ADBE Mask Atom$/);
    shapes += s;
    masks += m;
    total += comp.width * comp.height * (1 + s * 0.5 + m * 2);
    const source = layer.sourceId ? project.items.get(layer.sourceId) : undefined;
    if (source?.kind === "comp" && depth < 8) total += cost(project, source, depth + 1).cost;
  }
  return { layers, shapes, masks, cost: total };
}

const rows: { file: string; comp: string; size: string; frames: number; layers: number; shapes: number; masks: number; cost: number }[] = [];
for (const file of walk(dir)) {
  let project: Project;
  try {
    project = parseProject(new Uint8Array(readFileSync(file)));
  } catch {
    continue;
  }
  for (const item of project.items.values()) {
    if (item.kind !== "comp") continue;
    const c = cost(project, item);
    rows.push({
      file: relative(dir, file),
      comp: item.name,
      size: `${item.width}x${item.height}`,
      frames: Math.round(item.workAreaDuration * item.frameRate),
      ...c,
    });
  }
}
rows.sort((a, b) => b.cost - a.cost);
for (const r of rows.slice(0, top)) {
  console.log(
    `${(r.cost / 1e6).toFixed(1).padStart(8)} Mpx  ${r.size.padEnd(10)} ${String(r.frames).padStart(5)}f  L${r.layers} S${r.shapes} M${r.masks}  ${r.file} :: ${r.comp}`,
  );
}
