// The paths the Composition viewer shows and edits on the selected layer (its masks, and on a shape layer the
// Path items of its contents, through their groups' transforms) and the vertex operations the Selection,
// Pen, Add Vertex, Delete Vertex and Convert Vertex tools carry out on them. Paths here are in the space
// their property stores them in (layer pixels for masks, the enclosing group's contents for shape paths).
import { isShapeValue, type Layer, type Property, type PropertyGroup, type PropertyNode, type Shape } from "../aep/model.ts";
import { vectorGroupMatrix } from "../render/shapes.ts";
import { apply, invert, valueAt, type Matrix } from "./animate.ts";

export interface EditablePath {
  prop: Property;
  shape: Shape;
  /** The path's space to comp space. */
  toComp: Matrix;
  color: [number, number, number];
  locked: boolean;
  /** Mask or shape group the path belongs to, for the Timeline's names. */
  owner: PropertyGroup;
}

const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** Shape paths keep AE's yellow; masks show their own colour. */
const SHAPE_PATH_COLOR: [number, number, number] = [0.98, 0.85, 0.2];

/** The selected layer's paths at `time`, masks first. */
export function editablePaths(layer: Layer, layerToComp: Matrix, time: number): EditablePath[] {
  const out: EditablePath[] = [];
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Mask Parade");
  for (const mask of parade?.children ?? []) {
    if (mask.kind !== "group" || !mask.mask) continue;
    const prop = mask.children.find((c): c is Property => c.kind === "property" && c.matchName === "ADBE Mask Shape");
    const shape = prop && valueAt(prop, time, layer);
    if (prop && isShapeValue(shape)) out.push({ prop, shape, toComp: layerToComp, color: mask.mask.color, locked: mask.mask.locked, owner: mask });
  }
  const root = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Root Vectors Group");
  const visit = (items: readonly PropertyNode[], toComp: Matrix, owner: PropertyGroup | undefined) => {
    for (const item of items) {
      if (item.kind !== "group" || !item.enabled) continue;
      if (item.matchName === "ADBE Vector Group") {
        const transform = item.children.find((c): c is PropertyGroup => c.kind === "group" && c.matchName === "ADBE Vector Transform Group");
        const contents = item.children.find((c): c is PropertyGroup => c.kind === "group" && c.matchName === "ADBE Vectors Group");
        if (contents) visit(contents.children, mul(toComp, vectorGroupMatrix(layer, transform, time) as Matrix), item);
      } else if (item.matchName === "ADBE Vector Shape - Group") {
        const prop = item.children.find((c): c is Property => c.kind === "property" && c.matchName === "ADBE Vector Shape");
        const shape = prop && valueAt(prop, time, layer);
        if (prop && isShapeValue(shape)) out.push({ prop, shape, toComp, color: SHAPE_PATH_COLOR, locked: false, owner: owner ?? item });
      }
    }
  };
  if (root) visit(root.children, layerToComp, undefined);
  return out;
}

const copy = (shape: Shape): Shape => ({
  closed: shape.closed,
  vertices: shape.vertices.map((p) => [p[0], p[1]]),
  inTangents: shape.inTangents.map((p) => [p[0], p[1]]),
  outTangents: shape.outTangents.map((p) => [p[0], p[1]]),
});

/** `shape` with vertex `i` (and its handles) moved by `delta`. */
export function moveVertices(shape: Shape, indices: readonly number[], delta: readonly [number, number]): Shape {
  const next = copy(shape);
  for (const i of indices) {
    if (!next.vertices[i]) continue;
    next.vertices[i] = [next.vertices[i][0] + delta[0], next.vertices[i][1] + delta[1]];
  }
  return next;
}

/**
 * `shape` with one handle of vertex `i` set to `handle` (relative to the vertex). A smooth vertex (its
 * handles opposite each other) keeps its other handle opposite, at its own length, unless `breakSmooth`.
 */
export function moveHandle(shape: Shape, i: number, side: "in" | "out", handle: readonly [number, number], breakSmooth = false): Shape {
  const next = copy(shape);
  const own = side === "in" ? next.inTangents : next.outTangents;
  const other = side === "in" ? next.outTangents : next.inTangents;
  const before = own[i] ?? [0, 0];
  const opposite = other[i] ?? [0, 0];
  const smooth = isSmooth(before, opposite);
  own[i] = [handle[0], handle[1]];
  if (smooth && !breakSmooth) {
    const length = Math.hypot(opposite[0], opposite[1]);
    const len = Math.hypot(handle[0], handle[1]);
    if (len > 1e-9) other[i] = [(-handle[0] / len) * length, (-handle[1] / len) * length];
  }
  return next;
}

function isSmooth(a: readonly number[], b: readonly number[]): boolean {
  const la = Math.hypot(a[0], a[1]);
  const lb = Math.hypot(b[0], b[1]);
  if (la < 1e-9 || lb < 1e-9) return false;
  return (a[0] * b[0] + a[1] * b[1]) / (la * lb) < -0.999;
}

/** Splits segment `k` (from vertex k to the next) at `t`, keeping the curve: the Add Vertex tool. */
export function insertVertex(shape: Shape, k: number, t: number): Shape {
  const n = shape.vertices.length;
  const next = copy(shape);
  const j = (k + 1) % n;
  const p0 = shape.vertices[k];
  const p3 = shape.vertices[j];
  const p1 = [p0[0] + shape.outTangents[k][0], p0[1] + shape.outTangents[k][1]];
  const p2 = [p3[0] + shape.inTangents[j][0], p3[1] + shape.inTangents[j][1]];
  const lerp = (a: readonly number[], b: readonly number[]) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const a = lerp(p0, p1);
  const b = lerp(p1, p2);
  const c = lerp(p2, p3);
  const d = lerp(a, b);
  const e = lerp(b, c);
  const m = lerp(d, e);
  next.outTangents[k] = [a[0] - p0[0], a[1] - p0[1]];
  next.inTangents[j] = [c[0] - p3[0], c[1] - p3[1]];
  next.vertices.splice(k + 1, 0, m);
  next.inTangents.splice(k + 1, 0, [d[0] - m[0], d[1] - m[1]]);
  next.outTangents.splice(k + 1, 0, [e[0] - m[0], e[1] - m[1]]);
  return next;
}

/** `shape` without vertex `i`: the Delete Vertex tool (a path keeps at least two vertices). */
export function deleteVertex(shape: Shape, i: number): Shape {
  if (shape.vertices.length <= 2) return shape;
  const next = copy(shape);
  next.vertices.splice(i, 1);
  next.inTangents.splice(i, 1);
  next.outTangents.splice(i, 1);
  return next;
}

/** The Convert Vertex tool: a corner gets smooth handles along its neighbours, a vertex with handles loses them. */
export function convertVertex(shape: Shape, i: number): Shape {
  const next = copy(shape);
  const n = shape.vertices.length;
  const hasHandles = Math.hypot(...shape.inTangents[i]) > 1e-6 || Math.hypot(...shape.outTangents[i]) > 1e-6;
  if (hasHandles) {
    next.inTangents[i] = [0, 0];
    next.outTangents[i] = [0, 0];
    return next;
  }
  const prev = shape.vertices[(i - 1 + n) % n];
  const after = shape.vertices[(i + 1) % n];
  const atStart = !shape.closed && i === 0;
  const atEnd = !shape.closed && i === n - 1;
  const from = atStart ? shape.vertices[i] : prev;
  const to = atEnd ? shape.vertices[i] : after;
  const dir = [to[0] - from[0], to[1] - from[1]];
  const len = Math.hypot(dir[0], dir[1]) || 1;
  const reach = (other: readonly number[]) => Math.hypot(other[0] - shape.vertices[i][0], other[1] - shape.vertices[i][1]) / 3;
  next.inTangents[i] = [(-dir[0] / len) * reach(prev), (-dir[1] / len) * reach(prev)];
  next.outTangents[i] = [(dir[0] / len) * reach(after), (dir[1] / len) * reach(after)];
  return next;
}

/** The point of segment `k` at `t`, in the path's space. */
function segmentPoint(shape: Shape, k: number, t: number): [number, number] {
  const n = shape.vertices.length;
  const j = (k + 1) % n;
  const p0 = shape.vertices[k];
  const p3 = shape.vertices[j];
  const p1 = [p0[0] + shape.outTangents[k][0], p0[1] + shape.outTangents[k][1]];
  const p2 = [p3[0] + shape.inTangents[j][0], p3[1] + shape.inTangents[j][1]];
  const u = 1 - t;
  const f = (i: 0 | 1) => u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i];
  return [f(0), f(1)];
}

/** The segment of the path nearest comp point `at`, within `tolerance` comp pixels: [segment, t]. */
export function hitSegment(path: EditablePath, at: readonly [number, number], tolerance: number): [number, number] | undefined {
  const { shape, toComp } = path;
  const n = shape.vertices.length;
  const segments = shape.closed ? n : n - 1;
  let best: [number, number] | undefined;
  let bestDist = tolerance;
  for (let k = 0; k < segments; k++) {
    for (let s = 0; s <= 48; s++) {
      const t = s / 48;
      const [x, y] = apply(toComp, ...segmentPoint(shape, k, t));
      const dist = Math.hypot(x - at[0], y - at[1]);
      if (dist < bestDist) [best, bestDist] = [[k, t], dist];
    }
  }
  return best;
}

/** A comp-space delta in the path's space. */
export function deltaInPath(toComp: Matrix, delta: readonly [number, number]): [number, number] {
  const inv = invert(toComp);
  if (!inv) return [0, 0];
  return [inv[0] * delta[0] + inv[2] * delta[1], inv[1] * delta[0] + inv[3] * delta[1]];
}

/** A comp point in the path's space. */
export function pointInPath(toComp: Matrix, at: readonly [number, number]): [number, number] {
  const inv = invert(toComp);
  return inv ? apply(inv, at[0], at[1]) : [at[0], at[1]];
}
