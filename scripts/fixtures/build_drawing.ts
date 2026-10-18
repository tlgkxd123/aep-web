// Builds refs/fixtures/drawing.aep and drawing.manifest.json: masks and shapes drawn by the browser editor
// (src/edit/masks.ts, src/edit/shapes.ts, path values through the Editor) the way the Composition viewer's
// tools and the Timeline write them, on a project the editor starts. After Effects' renders of the saved
// file (node scripts/render-refs.ts --suite drawing) check that it opens and draws what the editor writes,
// as the app draws it (node scripts/pixel-report.ts --suite drawing).
//
//   node scripts/fixtures/build_drawing.ts
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompItem, Layer, Property, PropertyGroup, PropertyNode, PropertyValue } from "../../src/aep/model.ts";
import type { Editor } from "../../src/edit/editor.ts";
import { addLayer } from "../../src/edit/layers.ts";
import {
  addMasks,
  deleteMasks,
  duplicateMasks,
  ellipseShape,
  layerMasks,
  MaskMode,
  rectShape,
  setMaskInverted,
  setMaskMode,
  starShape,
} from "../../src/edit/masks.ts";
import { DEFAULT_COMP_SETTINGS, newComposition, newProject } from "../../src/edit/project.ts";
import { addShapeLayer, addShapes, type ShapePaint } from "../../src/edit/shapes.ts";
import { setPropertyValue, toggleStopwatch } from "../../src/edit/stored-property.ts";
import { ROOT } from "../lib/suites.ts";

const W = 320;
const H = 240;
const FPS = 30;
const PAINT: ShapePaint = { fill: [0.95, 0.55, 0.1], stroke: [0.1, 0.3, 0.9], strokeWidth: 6 };

const editor = newProject();
const comps: { comp: string; frames: number[]; fps: number }[] = [];

function comp(name: string, frames = [0]): CompItem {
  // After Effects mattes its reference frames with the comp's background colour: black keeps them premultiplied.
  const c = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name, width: W, height: H, frameRate: FPS, duration: 2, bgColor: [0, 0, 0] });
  comps.push({ comp: name, frames, fps: FPS });
  return c;
}
const solid = (c: CompItem, color: [number, number, number] = [0.2, 0.75, 0.45]) => addLayer(editor, c, { kind: "solid", name: "Plate", color, width: 280, height: 200 });
const layerOf = (c: CompItem, id: number): Layer => c.layers.find((l) => l.id === id)!;

function search(nodes: readonly PropertyNode[], matchName: string): Property | undefined {
  for (const n of nodes) {
    if (n.kind === "property" && n.matchName === matchName) return n;
    const found = n.kind === "group" ? search(n.children, matchName) : undefined;
    if (found) return found;
  }
  return undefined;
}
function find(nodes: readonly PropertyNode[], matchName: string): Property {
  const found = search(nodes, matchName);
  if (!found) throw new Error(`no ${matchName}`);
  return found;
}
const set = (ed: Editor, c: CompItem, id: number, owner: (l: Layer) => readonly PropertyNode[], matchName: string, value: PropertyValue, time = 0) =>
  setPropertyValue(ed, c, layerOf(c, id), find(owner(layerOf(c, id)), matchName), value, time);
const maskProps = (index: number) => (l: Layer) => layerMasks(l)[index].children;
const groupProps = (index: number) => (l: Layer) => {
  const root = l.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Root Vectors Group")!;
  return (root.children.filter((n) => n.kind === "group")[index] as PropertyGroup).children;
};

// Mask modes over one plate: Add, then Subtract, Intersect and Difference.
{
  const c = comp("drawing_mask_modes");
  const id = solid(c);
  addMasks(editor, c, id, [
    { shape: rectShape(20, 20, 260, 180) },
    { shape: ellipseShape(140, 100, 60, 50), mode: MaskMode.SUBTRACT },
    { shape: starShape(140, 100, 5, 110, 50), mode: MaskMode.INTERSECT },
    { shape: rectShape(0, 0, 90, 70), mode: MaskMode.DIFFERENCE },
  ]);
}

// Feather, opacity and expansion written as the Timeline writes them; one inverted mask.
{
  const c = comp("drawing_mask_feather");
  const id = solid(c, [0.85, 0.3, 0.35]);
  addMasks(editor, c, id, [{ shape: ellipseShape(90, 100, 60, 60) }, { shape: rectShape(170, 40, 260, 160, 20) }]);
  set(editor, c, id, maskProps(0), "ADBE Mask Feather", [16, 16]);
  set(editor, c, id, maskProps(0), "ADBE Mask Offset", 8);
  set(editor, c, id, maskProps(1), "ADBE Mask Opacity", 60);
  set(editor, c, id, maskProps(1), "ADBE Mask Feather", [4, 10]);
}

// Mask commands: mode and inversion switched, a duplicate moved, one deleted.
{
  const c = comp("drawing_mask_commands");
  const id = solid(c, [0.3, 0.45, 0.9]);
  addMasks(editor, c, id, [{ shape: ellipseShape(80, 100, 50, 50) }, { shape: rectShape(150, 30, 250, 170) }, { shape: rectShape(0, 0, 40, 40) }]);
  setMaskMode(editor, c, layerOf(c, id), [layerMasks(layerOf(c, id))[1]], MaskMode.LIGHTEN);
  setMaskInverted(editor, c, layerOf(c, id), [layerMasks(layerOf(c, id))[0]], true);
  duplicateMasks(editor, c, layerOf(c, id), [layerMasks(layerOf(c, id))[0]]);
  set(editor, c, id, maskProps(1), "ADBE Mask Shape", ellipseShape(200, 140, 30, 30));
  setMaskInverted(editor, c, layerOf(c, id), [layerMasks(layerOf(c, id))[1]], false);
  deleteMasks(editor, c, layerOf(c, id), [layerMasks(layerOf(c, id))[3]]);
}

// A mask path animated from a rectangle to a star (same vertex count) over a second.
{
  const c = comp("drawing_mask_animated", [0, 15, 30]);
  const id = solid(c, [0.9, 0.8, 0.2]);
  const from = starShape(140, 100, 5, 90, 90);
  addMasks(editor, c, id, [{ shape: from }]);
  toggleStopwatch(editor, c, layerOf(c, id), find(maskProps(0)(layerOf(c, id)), "ADBE Mask Shape"), 0);
  set(editor, c, id, maskProps(0), "ADBE Mask Shape", starShape(140, 100, 5, 95, 35, 36), 1);
}

// Shape layers as the tools draw them: every kind, with and without fill or stroke.
{
  const c = comp("drawing_shapes");
  addShapeLayer(editor, c, { kind: "rect", size: [110, 70], roundness: 12, paint: PAINT }, [80, 60]);
  addShapeLayer(editor, c, { kind: "ellipse", size: [90, 90], paint: { ...PAINT, stroke: null } }, [230, 60]);
  addShapeLayer(editor, c, { kind: "star", points: 5, outerRadius: 50, innerRadius: 22, rotation: 10, paint: PAINT }, [80, 175]);
  const id = addShapeLayer(editor, c, { kind: "polygon", points: 6, outerRadius: 45, paint: { ...PAINT, fill: null, strokeWidth: 4 } }, [230, 175]);
  addShapes(editor, c, id, [{ kind: "path", path: { closed: false, vertices: [[-60, 20], [0, -30], [60, 20]], inTangents: [[0, 0], [-25, 0], [0, 0]], outTangents: [[0, 0], [25, 0], [0, 0]] }, paint: { fill: null, stroke: [1, 1, 1], strokeWidth: 3 } }]);
}

// Shape properties edited after drawing (the Timeline): stroke, fill opacity, group transform, rect size, an animated path.
{
  const c = comp("drawing_shape_edits", [0, 30]);
  const id = addShapeLayer(editor, c, { kind: "rect", size: [120, 80], paint: PAINT }, [W / 2, H / 2]);
  set(editor, c, id, groupProps(0), "ADBE Vector Stroke Width", 12);
  set(editor, c, id, groupProps(0), "ADBE Vector Fill Opacity", 50);
  set(editor, c, id, groupProps(0), "ADBE Vector Rotation", 20);
  set(editor, c, id, groupProps(0), "ADBE Vector Rect Size", [150, 60]);
  addShapes(editor, c, id, [{ kind: "path", path: rectShape(-140, -100, -80, -40), paint: { ...PAINT, stroke: null, fill: [0.9, 0.9, 0.9] } }]);
  toggleStopwatch(editor, c, layerOf(c, id), find(groupProps(0)(layerOf(c, id)), "ADBE Vector Shape"), 0);
  set(editor, c, id, groupProps(0), "ADBE Vector Shape", rectShape(80, 40, 150, 110), 1);
}

const out = join(ROOT, "fixtures");
writeFileSync(join(out, "drawing.aep"), editor.save());
const known = {
  "drawing_mask_feather@0": "the renderer's mask feather approximation (core suite mask_feather@0): AE's feather falls off slightly faster inside the edge than a Gaussian",
};
writeFileSync(join(out, "drawing.manifest.json"), JSON.stringify({ project: "drawing.aep", comps, known }, null, 1) + "\n");
console.log(`wrote ${join(out, "drawing.aep")}: ${comps.length} comps`);
