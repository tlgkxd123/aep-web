// Prints what a comp renders at a time, nested comps included: each active layer with its source, masks and
// effects, and whether its values change from that frame to the next (keyframes) or an expression drives them.
//
//   node scripts/comp-tree.ts <project.aep> <comp name> [time=0]
import { readFileSync } from "node:fs";
import { layerTimeAt } from "../src/aep/evaluate.ts";
import type { CompItem, Layer, PropertyGroup, PropertyNode } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { valuesKey } from "../src/render/contentCache.ts";

const [file, compName, timeArg = "0"] = process.argv.slice(2);
const bytes = readFileSync(file);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const root = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === compName);
if (!root) throw new Error(`no comp named ${compName}`);

const group = (layer: Layer, matchName: string) => layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === matchName);
const hasExpression = (nodes: readonly PropertyNode[]): boolean =>
  nodes.some((n) => (n.kind === "group" ? hasExpression(n.children) : n.expressionEnabled && !!n.expression));

function state(nodes: readonly PropertyNode[], layer: Layer, time: number, step: number): string {
  if (hasExpression(nodes)) return "expr";
  return valuesKey(nodes, time, layer) === valuesKey(nodes, time + step, layer) ? "static" : "animated";
}

function walk(comp: CompItem, time: number, indent: string): void {
  const step = comp.frameDuration || 1 / (comp.frameRate || 24);
  for (const layer of comp.layers) {
    if (!layer.enabled || layer.nullLayer || layer.guideLayer) continue;
    if (time < Math.min(layer.inPoint, layer.outPoint) || time >= Math.max(layer.inPoint, layer.outPoint)) continue;
    const source = project.items.get(layer.sourceId);
    const kind = source?.kind === "comp" ? "precomp" : source?.kind === "footage" ? source.mainSource.sourceType === "SolidSource" ? "solid" : `footage(${source.name})` : layer.layerType;
    const transform = group(layer, "ADBE Transform Group");
    const masks = group(layer, "ADBE Mask Parade")?.children.filter((m) => m.kind === "group" && m.enabled) ?? [];
    const effects = (group(layer, "ADBE Effect Parade")?.children ?? []).filter((e): e is PropertyGroup => e.kind === "group" && e.enabled);
    const parts = [
      `${indent}${layer.index} "${layer.name}" ${kind}${layer.adjustmentLayer ? " adjustment" : ""}${layer.threeDLayer ? " 3D" : ""}${layer.trackMatteType ? ` matte=${layer.trackMatteType}` : ""}${layer.timeRemapEnabled ? " time-remap" : ""}`,
      `transform ${transform ? state([transform], layer, time, step) : "-"}`,
    ];
    if (masks.length) parts.push(`${masks.length} masks ${state(masks, layer, time, step)}`);
    for (const e of effects) parts.push(`${e.effectName ?? e.matchName} ${state(e.children, layer, time, step)}`);
    console.log(parts.join(" | "));
    if (source?.kind === "comp") walk(source, layerTimeAt(layer, time), indent + "    ");
  }
}

console.log(`${root.name} at ${timeArg} s`);
walk(root, Number(timeArg), "  ");
