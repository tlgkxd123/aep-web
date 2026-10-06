// Builds refs/fixtures/layerops.aep: the layerops base project
// (scripts/fixtures/build_layerops.py) edited by the browser editor's layer
// operations, so After Effects' renders check what the editor writes.
//
//   node scripts/build-layerops.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompItem, Item, Layer } from "../src/aep/model.ts";
import { sourcePointToComp } from "../src/aep/transform.ts";
import { Editor } from "../src/edit/editor.ts";
import { addLayer, arrangeLayer, deleteLayers, duplicateLayers } from "../src/edit/layers.ts";
import {
  anchorInComp,
  centerAnchorPoint,
  centerInView,
  fitToComp,
  flipLayers,
  moveLayers,
  nudgeLayers,
  panBehind,
  resetTransform,
  rotateByDrag,
  scaleByHandle,
  setParentKeepingTransform,
  transformProp,
  type Handle,
} from "../src/edit/transform-ops.ts";
import { ROOT } from "./lib/suites.ts";

type Vec2 = [number, number];
const FIXTURES = join(ROOT, "fixtures");
const editor = Editor.fromBytes(new Uint8Array(readFileSync(join(FIXTURES, "layerops.base.aep"))));
const items = [...editor.project.items.values()];
const item = (name: string): Item => {
  const found = items.find((i) => i.name === name);
  if (!found) throw new Error(`no item "${name}"`);
  return found;
};
const comp = (name: string) => item(name) as CompItem;
const byId = (c: CompItem, id: number): Layer => {
  const layer = c.layers.find((l) => l.id === id);
  if (!layer) throw new Error(`no layer #${id} in ${c.name}`);
  return layer;
};
let drags = 0;
const drag = () => `drag ${++drags}`;
const add = (c: CompItem, name: string, position?: Vec2) => addLayer(editor, c, { kind: "item", itemId: item(name).id }, { position });
/** Where a bounding-box handle of the layer sits in the comp. */
const handle = (c: CompItem, id: number, [hx, hy]: Handle): Vec2 => {
  const layer = byId(c, id);
  return sourcePointToComp(layer, c, [((hx + 1) / 2) * layer.width, ((hy + 1) / 2) * layer.height], 0);
};
/** Drags a handle by `delta` comp pixels, in two pointer moves of one drag. */
const dragHandle = (c: CompItem, id: number, h: Handle, delta: Vec2, proportional = false) => {
  const from = handle(c, id, h);
  const key = drag();
  scaleByHandle(editor, c, byId(c, id), h, from, [from[0] + delta[0] / 2, from[1] + delta[1] / 2], 0, { coalesce: key, proportional });
  scaleByHandle(editor, c, byId(c, id), h, from, [from[0] + delta[0], from[1] + delta[1]], 0, { coalesce: key, proportional });
  editor.commit();
};
/** Shift-drags the bottom-right handle so the layer shrinks to `factor` around its anchor. */
const shrink = (c: CompItem, id: number, factor: number) => {
  const corner = handle(c, id, [1, 1]);
  const anchor = anchorInComp(c, byId(c, id), 0);
  dragHandle(c, id, [1, 1], [(corner[0] - anchor[0]) * (factor - 1), (corner[1] - anchor[1]) * (factor - 1)], true);
};
/** Rotation-tool drag around the anchor by roughly `degrees`. */
const rotate = (c: CompItem, id: number, degrees: number, snap = false) => {
  const [cx, cy] = anchorInComp(c, byId(c, id), 0);
  const a = (degrees * Math.PI) / 180;
  rotateByDrag(editor, c, byId(c, id), [cx + 20, cy], [cx + 20 * Math.cos(a), cy + 20 * Math.sin(a)], 0, { snap, coalesce: drag() });
  editor.commit();
};

// New solid, null, shape and adjustment layers, and items dropped at a point.
{
  const c = comp("layerops_new");
  addLayer(editor, c, { kind: "solid", color: [0.22, 0.22, 0.28], width: c.width, height: c.height });
  const nul = addLayer(editor, c, { kind: "null" });
  const box = addLayer(editor, c, { kind: "solid", color: [1, 0.5, 0], width: 30, height: 30 });
  setParentKeepingTransform(editor, c, byId(c, box), nul, 0);
  rotate(c, nul, 31);
  addLayer(editor, c, { kind: "shape" });
  addLayer(editor, c, { kind: "adjustment" });
  add(c, "layerops_card", [40, 35]);
  const small = add(c, "layerops small", [120, 92]);
  shrink(c, small, 0.15);
}

// Fit to Comp / Width / Height on sources of other sizes and aspect ratios.
{
  const c = comp("layerops_fit");
  const card = add(c, "layerops_card", [30, 30]);
  rotate(c, card, 20);
  resetTransform(editor, c, [byId(c, card)], 0);
  fitToComp(editor, c, [byId(c, card)], "both", 0);
  const small = add(c, "layerops small", [20, 100]);
  fitToComp(editor, c, [byId(c, small)], "both", 0);
  dragHandle(c, small, [1, 1], [-60, -40]);
}
{
  const c = comp("layerops_fit_width");
  const small = add(c, "layerops small");
  fitToComp(editor, c, [byId(c, small)], "width", 0);
  const wide = add(c, "layerops wide", [10, 10]);
  fitToComp(editor, c, [byId(c, wide)], "width", 0);
}
{
  const c = comp("layerops_fit_height");
  const card = add(c, "layerops_card");
  fitToComp(editor, c, [byId(c, card)], "height", 0);
  const tall = add(c, "layerops tall", [150, 20]);
  fitToComp(editor, c, [byId(c, tall)], "height", 0);
}

// Selection-tool moves (one keyed), handle scaling, nudges and Rotation-tool drags.
{
  const c = comp("layerops_move");
  const card = add(c, "layerops_card");
  moveLayers(editor, c, [byId(c, card)], [10, 4], 0, { coalesce: "move" });
  moveLayers(editor, c, [byId(c, card)], [25, -12], 0, { coalesce: "move" });
  editor.commit();
  rotate(c, card, 50, true);
  const small = add(c, "layerops small", [30, 30]);
  shrink(c, small, 0.125);
  editor.toggleStopwatch(c, byId(c, small), transformProp(byId(c, small), "ADBE Position")!, 0);
  moveLayers(editor, c, [byId(c, small)], [60, 50], 0.5, { coalesce: "keyed" });
  moveLayers(editor, c, [byId(c, small)], [70, 60], 0.5, { coalesce: "keyed", constrain: true });
  editor.commit();
  const tall = add(c, "layerops tall", [130, 80]);
  dragHandle(c, tall, [-1, 0], [12, 30]);
  dragHandle(c, tall, [1, 1], [-8, -30], true);
  nudgeLayers(editor, c, [byId(c, tall)], [-10, 0], 0);
  nudgeLayers(editor, c, [byId(c, tall)], [0, -1], 0);
}

// Parented layers: moves, fits and rotations taken through a parent.
{
  const c = comp("layerops_parent");
  const pivot = addLayer(editor, c, { kind: "null" }, { position: [60, 50] });
  const card = add(c, "layerops_card", [60, 50]);
  setParentKeepingTransform(editor, c, byId(c, card), pivot, 0);
  rotate(c, pivot, 31);
  moveLayers(editor, c, [byId(c, card)], [12, 8], 0);
  const scaler = addLayer(editor, c, { kind: "null" }, { position: [130, 20] });
  shrink(c, scaler, 0.6);
  const tall = add(c, "layerops tall", [130, 60]);
  setParentKeepingTransform(editor, c, byId(c, tall), scaler, 0);
  fitToComp(editor, c, [byId(c, tall)], "height", 0);
  moveLayers(editor, c, [byId(c, tall)], [50, 0], 0);
  dragHandle(c, tall, [1, 0], [-10, 0]);
}

// Anchor points: Pan Behind with and without Alt, centred anchors, flips, Center In View.
{
  const c = comp("layerops_anchor");
  const card = add(c, "layerops_card", [50, 40]);
  panBehind(editor, c, byId(c, card), [-40, -30], 0, { coalesce: drag() });
  rotate(c, card, 24);
  const small = add(c, "layerops small", [120, 30]);
  shrink(c, small, 0.15);
  panBehind(editor, c, byId(c, small), [15, 5], 0, { anchorOnly: true });
  const flipped = add(c, "layerops_card", [10, 10]);
  panBehind(editor, c, byId(c, flipped), [-30, -20], 0, { anchorOnly: true });
  centerAnchorPoint(editor, c, [byId(c, flipped)], 0);
  centerInView(editor, c, [byId(c, flipped)], 0);
  flipLayers(editor, c, [byId(c, flipped)], "horizontal", 0);
  flipLayers(editor, c, [byId(c, flipped)], "vertical", 0);
  shrink(c, flipped, 0.8);
  arrangeLayer(editor, c, byId(c, flipped), "back");
}

// Duplicate, delete (an unparented child keeps its place) and reorder.
{
  const c = comp("layerops_stack");
  const card = add(c, "layerops_card", [50, 45]);
  const small = add(c, "layerops small", [60, 50]);
  shrink(c, small, 0.15);
  const wide = add(c, "layerops wide", [80, 100]);
  const [copy] = duplicateLayers(editor, c, [byId(c, small)]);
  moveLayers(editor, c, [byId(c, copy)], [50, 30], 0);
  const pivot = addLayer(editor, c, { kind: "null" }, { position: [100, 40] });
  setParentKeepingTransform(editor, c, byId(c, small), pivot, 0);
  rotate(c, pivot, 28);
  shrink(c, pivot, 0.7);
  deleteLayers(editor, c, [byId(c, pivot)], 0);
  const [card2] = duplicateLayers(editor, c, [byId(c, card)]);
  moveLayers(editor, c, [byId(c, card2)], [60, 10], 0);
  deleteLayers(editor, c, [byId(c, wide)], 0);
  arrangeLayer(editor, c, byId(c, card), "front");
  arrangeLayer(editor, c, byId(c, copy), "back");
  arrangeLayer(editor, c, byId(c, card2), "forward");
}

writeFileSync(join(FIXTURES, "layerops.aep"), editor.save());
const base = JSON.parse(readFileSync(join(FIXTURES, "layerops.base.json"), "utf8"));
writeFileSync(join(FIXTURES, "layerops.manifest.json"), JSON.stringify({ ...base, project: "layerops.aep" }, null, 1) + "\n");
console.log(`wrote layerops.aep: ${base.comps.length} comps`);
