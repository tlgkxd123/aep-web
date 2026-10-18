// Shape groups added to shape layers as the shape tools and the Pen draw them, cloned from the groups After
// Effects 2025 saved in data/shape-template.json (scripts/export-shape-template.ts): a Rectangle, Ellipse,
// Star, Polygon or Path with a Stroke and a Fill, every property stored so all of them can be edited. The
// template holds them away from their defaults; they are set to the drawn shape and paint after cloning.
import type { CompItem, Layer, Property, PropertyGroup, PropertyNode, PropertyValue, Shape } from "../aep/model.ts";
import { findChild, findList, type Chunk } from "../aep/riff.ts";
import type { Transaction } from "./chunks.ts";
import type { Editor } from "./editor.ts";
import { clone, setName, UNNAMED } from "./effects.ts";
import { addLayer, autoName, type Placement } from "./layers.ts";
import { chunksFromBytes, layerTimebase, namedList, setTimebase, tdmnName } from "./layer-templates.ts";
import { renameGroupChunk } from "./masks.ts";
import template from "./data/shape-template.json" with { type: "json" };

export type ShapeKind = "rect" | "ellipse" | "star" | "polygon" | "path";

export interface ShapePaint {
  /** RGB 0-1, or null for no fill. */
  fill: [number, number, number] | null;
  /** RGB 0-1, or null for no stroke. */
  stroke: [number, number, number] | null;
  strokeWidth: number;
}

export interface NewShape {
  kind: ShapeKind;
  /** The shape's centre in layer pixels (the group's Position); ignored for paths, whose vertices are in layer pixels. */
  center?: [number, number];
  /** Rectangle and ellipse size. */
  size?: [number, number];
  /** Rectangle corner roundness in pixels. */
  roundness?: number;
  /** Star and polygon: points, radii and rotation (degrees). */
  points?: number;
  outerRadius?: number;
  innerRadius?: number;
  rotation?: number;
  path?: Shape;
  paint: ShapePaint;
  /** "Rectangle 1" and so on by default. */
  name?: string;
}

const ROOT = "ADBE Root Vectors Group";
const GROUP = "ADBE Vector Group";
const BASE_NAMES: Record<ShapeKind, string> = { rect: "Rectangle", ellipse: "Ellipse", star: "Polystar", polygon: "Polystar", path: "Shape" };
const SHAPE_ITEMS: Record<ShapeKind, string> = {
  rect: "ADBE Vector Shape - Rect",
  ellipse: "ADBE Vector Shape - Ellipse",
  star: "ADBE Vector Shape - Star",
  polygon: "ADBE Vector Shape - Star",
  path: "ADBE Vector Shape - Group",
};
const STROKE = "ADBE Vector Graphic - Stroke";
const FILL = "ADBE Vector Graphic - Fill";

const decodeBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** A fresh copy of the template group for `kind`: [tdmn, LIST:tdgp]. */
function templateGroup(kind: ShapeKind): [Chunk, Chunk] {
  // The Polygon group stores every star property (a Star leaves its Type out), so stars are made from it too.
  const source = kind === "star" ? "polygon" : kind;
  const [tdmn, tdgp] = chunksFromBytes((template.groups as Record<string, string[]>)[source].map(decodeBase64));
  if (!tdmn || tdgp?.listType !== "tdgp") throw new Error(`the shape template has no ${kind} group`);
  return [tdmn, tdgp];
}

/** [tdmn, lists...] runs of a tdgp, by the match name each tdmn names. */
function runs(tdgp: Chunk): { name: string; chunks: Chunk[] }[] {
  const out: { name: string; chunks: Chunk[] }[] = [];
  for (const c of tdgp.children ?? []) {
    if (c.type === "tdmn") out.push({ name: tdmnName(c), chunks: [c] });
    else out.at(-1)?.chunks.push(c);
  }
  return out;
}

/** The group chunks for `shape`, named, with its Stroke or Fill left out when it has none. */
function groupChunks(shape: NewShape, name: string, timebase: number): [Chunk, Chunk] {
  const [tdmn, tdgp] = templateGroup(shape.kind);
  const tdsn = findChild(tdgp, "tdsn");
  if (tdsn) setName(tdsn, name);
  const contents = namedList(tdgp, "ADBE Vectors Group");
  if (!contents?.children) throw new Error("the shape template group has no contents");
  const first = contents.children.findIndex((c) => c.type === "tdmn");
  const head = contents.children.slice(0, first < 0 ? contents.children.length : first);
  const kept = runs(contents).filter((r) => !(r.name === STROKE && !shape.paint.stroke) && !(r.name === FILL && !shape.paint.fill));
  for (const run of kept) {
    const item = run.chunks.find((c) => c.listType === "tdgp");
    const itemName = findChild(item, "tdsn");
    if (itemName) setName(itemName, UNNAMED);
  }
  contents.children = [...head, ...kept.flatMap((r) => r.chunks)];
  setTimebase(tdgp, timebase);
  return [tdmn, tdgp];
}

/** Groups a shape layer's Contents group comes before. */
const AFTER_CONTENTS = new Set(["ADBE Mask Parade", "ADBE Effect Parade", "ADBE Essential Properties", ...template.contentsBefore]);

/** The layer's Contents group (its tdgp), written empty first when the layer was saved without one. */
function contentsOf(tx: Transaction, layer: Layer): Chunk {
  if (layer.layerType !== "ShapeLayer") throw new Error(`"${layer.name}" is not a shape layer`);
  const root = findList(layer.chunk, "tdgp");
  const existing = namedList(root, ROOT);
  if (existing?.children) return existing;
  if (!root?.children) throw new Error(`"${layer.name}" has no property groups`);
  const [tdmn, contents] = chunksFromBytes(template.contents.map(decodeBase64));
  let at = root.children.findIndex((c) => c.type === "tdmn" && (AFTER_CONTENTS.has(tdmnName(c)) || tdmnName(c) === "ADBE Group End"));
  if (at < 0) at = root.children.length;
  tx.setChildren(root, [...root.children.slice(0, at), tdmn, contents, ...root.children.slice(at)]);
  return contents;
}

const groupsOf = (layer: Layer): PropertyGroup[] => {
  const root = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === ROOT);
  return (root?.children ?? []).filter((n): n is PropertyGroup => n.kind === "group");
};

const childNamed = (nodes: readonly PropertyNode[], matchName: string) => nodes.find((n) => n.matchName === matchName);
const propIn = (group: PropertyGroup | undefined, matchName: string): Property | undefined => {
  const node = group && childNamed(group.children, matchName);
  return node?.kind === "property" ? node : undefined;
};
const groupIn = (group: PropertyGroup | undefined, matchName: string): PropertyGroup | undefined => {
  const node = group && childNamed(group.children, matchName);
  return node?.kind === "group" ? node : undefined;
};

/** The values a drawn shape's group takes, by the group (by match name path) and property. */
function shapeValues(shape: NewShape): [string[], string, PropertyValue][] {
  const item = SHAPE_ITEMS[shape.kind];
  const shapeAt = ["ADBE Vectors Group", item];
  const center = shape.kind === "path" ? [0, 0] : (shape.center ?? [0, 0]);
  const out: [string[], string, PropertyValue][] = [
    [[], "ADBE Vector Blend Mode", 1],
    [shapeAt, "ADBE Vector Shape Direction", 1],
    [["ADBE Vector Transform Group"], "ADBE Vector Anchor", [0, 0]],
    [["ADBE Vector Transform Group"], "ADBE Vector Position", center],
    [["ADBE Vector Transform Group"], "ADBE Vector Scale", [100, 100]],
    [["ADBE Vector Transform Group"], "ADBE Vector Skew", 0],
    [["ADBE Vector Transform Group"], "ADBE Vector Skew Axis", 0],
    [["ADBE Vector Transform Group"], "ADBE Vector Rotation", 0],
    [["ADBE Vector Transform Group"], "ADBE Vector Group Opacity", 100],
  ];
  const size = shape.size ?? [100, 100];
  if (shape.kind === "rect") {
    out.push([shapeAt, "ADBE Vector Rect Size", size], [shapeAt, "ADBE Vector Rect Position", [0, 0]], [shapeAt, "ADBE Vector Rect Roundness", shape.roundness ?? 0]);
  } else if (shape.kind === "ellipse") {
    out.push([shapeAt, "ADBE Vector Ellipse Size", size], [shapeAt, "ADBE Vector Ellipse Position", [0, 0]]);
  } else if (shape.kind === "star" || shape.kind === "polygon") {
    const outer = shape.outerRadius ?? 50;
    out.push(
      [shapeAt, "ADBE Vector Star Type", shape.kind === "star" ? 1 : 2],
      [shapeAt, "ADBE Vector Star Points", shape.points ?? 5],
      [shapeAt, "ADBE Vector Star Position", [0, 0]],
      [shapeAt, "ADBE Vector Star Rotation", shape.rotation ?? 0],
      [shapeAt, "ADBE Vector Star Inner Radius", shape.innerRadius ?? outer / 2],
      [shapeAt, "ADBE Vector Star Outer Radius", outer],
      [shapeAt, "ADBE Vector Star Inner Roundess", 0],
      [shapeAt, "ADBE Vector Star Outer Roundess", 0],
    );
  } else if (shape.path) {
    out.push([[...shapeAt], "ADBE Vector Shape", shape.path]);
  }
  const { stroke, fill, strokeWidth } = shape.paint;
  if (stroke) {
    const at = ["ADBE Vectors Group", STROKE];
    out.push(
      [at, "ADBE Vector Blend Mode", 1],
      [at, "ADBE Vector Composite Order", 1],
      [at, "ADBE Vector Stroke Color", [...stroke, 1]],
      [at, "ADBE Vector Stroke Opacity", 100],
      [at, "ADBE Vector Stroke Width", strokeWidth],
      [at, "ADBE Vector Stroke Line Cap", 1],
      [at, "ADBE Vector Stroke Line Join", 1],
      [at, "ADBE Vector Stroke Miter Limit", 4],
    );
  }
  if (fill) {
    const at = ["ADBE Vectors Group", FILL];
    out.push([at, "ADBE Vector Blend Mode", 1], [at, "ADBE Vector Composite Order", 1], [at, "ADBE Vector Fill Rule", 1], [at, "ADBE Vector Fill Color", [...fill, 1]], [at, "ADBE Vector Fill Opacity", 100]);
  }
  return out;
}

/** Where a path item sits in a group's contents (a Path item stores its Path one level down). */
function resolveGroup(group: PropertyGroup, path: string[]): PropertyGroup | undefined {
  let at: PropertyGroup | undefined = group;
  for (const name of path) at = groupIn(at, name);
  return at;
}

/** Adds shapes at the top of a shape layer's contents, as one undoable step or one step of an enclosing `editor.perform`. */
export function addShapes(editor: Editor, comp: CompItem, layerId: number, shapes: NewShape[]): void {
  if (!shapes.length) return;
  editor.perform(shapes.length > 1 ? "New Shapes" : "New Shape", [comp], () => {
    for (const shape of shapes) {
      const layer = comp.layers.find((l) => l.id === layerId);
      if (!layer) throw new Error(`layer ${layerId} is not in "${comp.name}"`);
      const name = shape.name ?? autoName(BASE_NAMES[shape.kind], groupsOf(layer).map((g) => g.name));
      const [tdmn, tdgp] = groupChunks(shape, name, layerTimebase(comp, layer));
      editor.perform("", [comp], (tx) => {
        const contents = contentsOf(tx, layer);
        const children = contents.children!;
        let at = children.findIndex((c) => c.type === "tdmn");
        if (at < 0) at = children.length;
        tx.setChildren(contents, [...children.slice(0, at), tdmn, tdgp, ...children.slice(at)]);
      });
      const current = comp.layers.find((l) => l.id === layerId)!;
      const group = groupsOf(current).find((g) => g.chunk === tdgp);
      const entries = shapeValues(shape).map(([path, matchName, value]) => {
        const prop = group && propIn(resolveGroup(group, path), matchName);
        if (!prop || prop.synthesized) throw new Error(`the new shape has no stored ${matchName}`);
        return { prop, value };
      });
      editor.setValues(comp, current, entries, 0);
    }
  });
}

/** A new shape layer holding `shape`, its anchor at the shape's centre, placed at `position` in the comp; returns its id. */
export function addShapeLayer(editor: Editor, comp: CompItem, shape: NewShape, position: [number, number], place: Omit<Placement, "position"> = {}): number {
  let id = 0;
  editor.perform(shape.kind === "path" ? "New Shape Layer" : `New ${BASE_NAMES[shape.kind]} Layer`, [comp], () => {
    id = addLayer(editor, comp, { kind: "shape" }, { ...place, position });
    addShapes(editor, comp, id, [{ ...shape, center: [0, 0] }]);
  });
  return id;
}

/** Renames a shape group. */
export function renameShapeGroup(editor: Editor, comp: CompItem, group: PropertyGroup, name: string): void {
  const text = name.trim();
  if (!text || !group.chunk) throw new Error("A shape group needs a name");
  editor.perform("Rename group", [comp], (tx) => renameGroupChunk(tx, group.chunk!, text));
}

/** Deletes shape groups or items from their contents. */
export function deleteShapeItems(editor: Editor, comp: CompItem, layer: Layer, items: PropertyGroup[]): void {
  if (!items.length) return;
  editor.perform(items.length > 1 ? "Delete shapes" : "Delete shape", [comp], (tx) => {
    for (const item of items) {
      const parent = findParentList(findList(layer.chunk, "tdgp"), item.chunk);
      if (!parent?.children || !item.chunk) throw new Error(`"${item.name}" is not in "${layer.name}"`);
      const at = parent.children.indexOf(item.chunk);
      tx.setChildren(parent, [...parent.children.slice(0, at - 1), ...parent.children.slice(at + 1)]);
    }
  });
}

/** Duplicates shape groups or items above themselves. */
export function duplicateShapeItems(editor: Editor, comp: CompItem, layer: Layer, items: PropertyGroup[]): void {
  if (!items.length) return;
  editor.perform(items.length > 1 ? "Duplicate shapes" : "Duplicate shape", [comp], (tx) => {
    for (const item of items) {
      const parent = findParentList(findList(layer.chunk, "tdgp"), item.chunk);
      if (!parent?.children || !item.chunk) throw new Error(`"${item.name}" is not in "${layer.name}"`);
      const at = parent.children.indexOf(item.chunk);
      const copy = [clone(parent.children[at - 1]), clone(item.chunk)];
      const siblings = runs(parent).filter((r) => r.name === GROUP).map((r) => containerName(r.chunks[1]));
      const tdsn = findChild(copy[1], "tdsn");
      if (tdsn && item.matchName === GROUP) setName(tdsn, autoName(item.name, siblings));
      tx.setChildren(parent, [...parent.children.slice(0, at - 1), ...copy, ...parent.children.slice(at - 1)]);
    }
  });
}

function containerName(tdgp: Chunk | undefined): string {
  const utf8 = findChild(findChild(tdgp, "tdsn"), "Utf8");
  return utf8 ? new TextDecoder().decode(utf8.data) : "";
}

function findParentList(root: Chunk | undefined, child: Chunk | undefined): Chunk | undefined {
  if (!root || !child) return undefined;
  if (root.children?.includes(child)) return root;
  for (const c of root.children ?? []) {
    const found = findParentList(c, child);
    if (found) return found;
  }
  return undefined;
}