// Shape layer rasterization on a 2D canvas. Geometry conventions (path start
// points, directions, roundness handles, transform order) follow After
// Effects as reproduced by lottie-web.
import { valueAtTime } from "../aep/evaluate.ts";
import { isGradientValue, isShapeValue, type Gradient, type Layer, type Property, type PropertyGroup, type PropertyNode, type Shape } from "../aep/model.ts";

/** 2D affine [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
type Affine = [number, number, number, number, number, number];
const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
const DEG = Math.PI / 180;
/** Bezier handle length for a quarter circle, as AE draws ellipses and round corners. */
const ROUND_CORNER = 0.5519;

const mul = (m: Affine, n: Affine): Affine => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const translate = (x: number, y: number): Affine => [1, 0, 0, 1, x, y];
const scale = (x: number, y: number): Affine => [x, 0, 0, y, 0, 0];
const rotate = (rad: number): Affine => [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), 0, 0];
const applyPoint = (m: Affine, [x, y]: number[]): number[] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const applyVector = (m: Affine, [x, y]: number[]): number[] => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];

function transformShape(shape: Shape, m: Affine): Shape {
  if (m === IDENTITY) return shape;
  return {
    closed: shape.closed,
    vertices: shape.vertices.map((v) => applyPoint(m, v)),
    inTangents: shape.inTangents.map((t) => applyVector(m, t)),
    outTangents: shape.outTangents.map((t) => applyVector(m, t)),
  };
}

function reverseShape(shape: Shape): Shape {
  const n = shape.vertices.length;
  if (n < 2) return shape;
  const order = shape.closed ? [0, ...Array.from({ length: n - 1 }, (_, i) => n - 1 - i)] : Array.from({ length: n }, (_, i) => n - 1 - i);
  return {
    closed: shape.closed,
    vertices: order.map((i) => shape.vertices[i]),
    inTangents: order.map((i) => shape.outTangents[i]),
    outTangents: order.map((i) => shape.inTangents[i]),
  };
}

// --- Property access --------------------------------------------------------

class Reader {
  readonly layer: Layer;
  readonly time: number;
  constructor(layer: Layer, time: number) {
    this.layer = layer;
    this.time = time;
  }
  prop(group: PropertyGroup, matchName: string): Property | undefined {
    const node = group.children.find((c) => c.matchName === matchName);
    return node?.kind === "property" ? node : undefined;
  }
  group(group: PropertyGroup, matchName: string): PropertyGroup | undefined {
    const node = group.children.find((c) => c.matchName === matchName);
    return node?.kind === "group" ? node : undefined;
  }
  num(group: PropertyGroup, matchName: string, fallback: number): number {
    const p = this.prop(group, matchName);
    const v = p ? valueAtTime(p, this.time, this.layer) : null;
    return typeof v === "number" ? v : Array.isArray(v) ? (v[0] ?? fallback) : fallback;
  }
  vec(group: PropertyGroup, matchName: string, fallback: number[]): number[] {
    const p = this.prop(group, matchName);
    const v = p ? valueAtTime(p, this.time, this.layer) : null;
    return Array.isArray(v) ? v : fallback;
  }
  shape(group: PropertyGroup, matchName: string): Shape | null {
    const p = this.prop(group, matchName);
    const v = p ? valueAtTime(p, this.time, this.layer) : null;
    return isShapeValue(v) ? v : null;
  }
  gradient(group: PropertyGroup, matchName: string): Gradient | null {
    const p = this.prop(group, matchName);
    const v = p ? valueAtTime(p, this.time, this.layer) : null;
    return isGradientValue(v) ? v : null;
  }
}

// --- Path generators ----------------------------------------------------------

function rectPath(r: Reader, item: PropertyGroup): Shape {
  const [px, py] = r.vec(item, "ADBE Vector Rect Position", [0, 0]);
  const [sx, sy] = r.vec(item, "ADBE Vector Rect Size", [100, 100]);
  const w = sx / 2;
  const h = sy / 2;
  const round = Math.min(w, h, r.num(item, "ADBE Vector Rect Roundness", 0));
  const k = round * ROUND_CORNER;
  let shape: Shape;
  if (round <= 0) {
    shape = {
      closed: true,
      vertices: [[px + w, py - h], [px + w, py + h], [px - w, py + h], [px - w, py - h]],
      inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
      outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
    };
  } else {
    shape = {
      closed: true,
      vertices: [
        [px + w, py - h + round], [px + w, py + h - round], [px + w - round, py + h], [px - w + round, py + h],
        [px - w, py + h - round], [px - w, py - h + round], [px - w + round, py - h], [px + w - round, py - h],
      ],
      inTangents: [[0, -k], [0, 0], [k, 0], [0, 0], [0, k], [0, 0], [-k, 0], [0, 0]],
      outTangents: [[0, 0], [0, k], [0, 0], [-k, 0], [0, 0], [0, -k], [0, 0], [k, 0]],
    };
  }
  return r.num(item, "ADBE Vector Shape Direction", 1) === 3 ? reverseShape(shape) : shape;
}

function ellipsePath(r: Reader, item: PropertyGroup): Shape {
  const [px, py] = r.vec(item, "ADBE Vector Ellipse Position", [0, 0]);
  const [sx, sy] = r.vec(item, "ADBE Vector Ellipse Size", [100, 100]);
  const w = sx / 2;
  const h = sy / 2;
  const kx = w * ROUND_CORNER;
  const ky = h * ROUND_CORNER;
  const shape: Shape = {
    closed: true,
    vertices: [[px, py - h], [px + w, py], [px, py + h], [px - w, py]],
    inTangents: [[-kx, 0], [0, -ky], [kx, 0], [0, ky]],
    outTangents: [[kx, 0], [0, ky], [-kx, 0], [0, -ky]],
  };
  return r.num(item, "ADBE Vector Shape Direction", 1) === 3 ? reverseShape(shape) : shape;
}

function starPath(r: Reader, item: PropertyGroup): Shape {
  const [px, py] = r.vec(item, "ADBE Vector Star Position", [0, 0]);
  const polygon = r.num(item, "ADBE Vector Star Type", 1) === 2;
  const points = Math.floor(r.num(item, "ADBE Vector Star Points", 5));
  const rotation = r.num(item, "ADBE Vector Star Rotation", 0) * DEG;
  const outer = r.num(item, "ADBE Vector Star Outer Radius", 100);
  const inner = r.num(item, "ADBE Vector Star Inner Radius", 50);
  const outerRound = r.num(item, "ADBE Vector Star Outer Roundess", 0) / 100;
  const innerRound = r.num(item, "ADBE Vector Star Inner Roundess", 0) / 100;
  const dir = r.num(item, "ADBE Vector Shape Direction", 1) === 3 ? -1 : 1;
  const count = polygon ? points : points * 2;
  const step = (2 * Math.PI) / count;
  const shape: Shape = { closed: true, vertices: [], inTangents: [], outTangents: [] };
  let angle = -Math.PI / 2 + rotation;
  for (let i = 0; i < count; i++) {
    const isOuter = polygon || i % 2 === 0;
    const radius = isOuter ? outer : inner;
    const roundness = isOuter ? outerRound : innerRound;
    const perimeter = (2 * Math.PI * radius) / (polygon ? count * 4 : count * 2);
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);
    const len = Math.hypot(x, y);
    const ox = len ? y / len : 0;
    const oy = len ? -x / len : 0;
    const handle = perimeter * roundness * dir;
    shape.vertices.push([x + px, y + py]);
    shape.outTangents.push([-ox * handle, -oy * handle]);
    shape.inTangents.push([ox * handle, oy * handle]);
    angle += step * dir;
  }
  return shape;
}

function freePath(r: Reader, item: PropertyGroup): Shape | null {
  const shape = r.shape(item, "ADBE Vector Shape");
  if (!shape) return null;
  return r.num(item, "ADBE Vector Shape Direction", 1) === 3 ? reverseShape(shape) : shape;
}

// --- Path measurement and trimming -------------------------------------------

type Cubic = [number[], number[], number[], number[]];

function segments(shape: Shape): Cubic[] {
  const n = shape.vertices.length;
  const count = shape.closed ? n : n - 1;
  const out: Cubic[] = [];
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % n;
    const a = shape.vertices[i];
    const b = shape.vertices[j];
    out.push([a, [a[0] + shape.outTangents[i][0], a[1] + shape.outTangents[i][1]], [b[0] + shape.inTangents[j][0], b[1] + shape.inTangents[j][1]], b]);
  }
  return out;
}

function cubicPoint([p0, p1, p2, p3]: Cubic, t: number): number[] {
  const u = 1 - t;
  return [0, 1].map((d) => u * u * u * p0[d] + 3 * u * u * t * p1[d] + 3 * u * t * t * p2[d] + t * t * t * p3[d]);
}

const SAMPLES = 64;

/** Cumulative arc length at SAMPLES+1 evenly spaced parameters. */
function arcTable(c: Cubic): number[] {
  const table = [0];
  let prev = c[0];
  for (let k = 1; k <= SAMPLES; k++) {
    const p = cubicPoint(c, k / SAMPLES);
    table.push(table[k - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1]));
    prev = p;
  }
  return table;
}

function paramAtLength(table: number[], length: number): number {
  const total = table[table.length - 1];
  if (length <= 0 || total <= 0) return 0;
  if (length >= total) return 1;
  let k = 1;
  while (table[k] < length) k++;
  const span = table[k] - table[k - 1];
  return (k - 1 + (span > 0 ? (length - table[k - 1]) / span : 0)) / SAMPLES;
}

function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const lerp = (a: number[], b: number[]) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const a = lerp(c[0], c[1]);
  const b = lerp(c[1], c[2]);
  const d = lerp(c[2], c[3]);
  const e = lerp(a, b);
  const f = lerp(b, d);
  const g = lerp(e, f);
  return [[c[0], a, e, g], [g, f, d, c[3]]];
}

function subCubic(c: Cubic, t0: number, t1: number): Cubic {
  const right = splitCubic(c, t0)[1];
  return t0 >= 1 ? [c[3], c[3], c[3], c[3]] : splitCubic(right, (t1 - t0) / (1 - t0))[0];
}

function cubicsToShape(cubics: Cubic[]): Shape {
  const shape: Shape = { closed: false, vertices: [], inTangents: [], outTangents: [] };
  cubics.forEach((c, i) => {
    if (i === 0) {
      shape.vertices.push(c[0]);
      shape.inTangents.push([0, 0]);
    }
    shape.outTangents[shape.outTangents.length] = [c[1][0] - c[0][0], c[1][1] - c[0][1]];
    shape.vertices.push(c[3]);
    shape.inTangents.push([c[2][0] - c[3][0], c[2][1] - c[3][1]]);
  });
  if (shape.vertices.length) shape.outTangents.push([0, 0]);
  return shape;
}

interface Measured {
  cubics: Cubic[];
  tables: number[][];
  lengths: number[];
  total: number;
}

function measure(shape: Shape): Measured {
  const cubics = segments(shape);
  const tables = cubics.map(arcTable);
  const lengths = tables.map((t) => t[t.length - 1]);
  return { cubics, tables, lengths, total: lengths.reduce((a, b) => a + b, 0) };
}

/** The part of a measured path between two lengths along it (0 <= from <= to <= total). */
function extract(m: Measured, from: number, to: number): Cubic[] {
  const out: Cubic[] = [];
  let start = 0;
  m.cubics.forEach((c, i) => {
    const end = start + m.lengths[i];
    const a = Math.max(from, start);
    const b = Math.min(to, end);
    if (b > a || (m.lengths[i] === 0 && from <= start && to >= end)) {
      out.push(subCubic(c, paramAtLength(m.tables[i], a - start), paramAtLength(m.tables[i], b - start)));
    }
    start = end;
  });
  return out;
}

/** Pieces of one path covered by the trim window [s, e] (fractions, already offset; may wrap). */
function trimPath(shape: Shape, s: number, e: number): Shape[] {
  const m = measure(shape);
  if (m.total <= 0) return [];
  if (e - s >= 1 - 1e-9) return [shape];
  const pieces: Cubic[][] = [];
  const window = (a: number, b: number) => pieces.push(extract(m, a * m.total, b * m.total));
  const a = s - Math.floor(s);
  const b = a + (e - s);
  if (b <= 1) window(a, b);
  else {
    window(a, 1);
    window(0, b - 1);
  }
  // A window that wraps over a closed path's start joins into one piece.
  if (pieces.length === 2 && shape.closed) return [cubicsToShape([...pieces[0], ...pieces[1]])];
  return pieces.filter((p) => p.length).map(cubicsToShape);
}

// --- Gradients ------------------------------------------------------------------

/** AE-style midpoint blend between two stops: at the midpoint the mix is 50%. */
function midpointCurve(t: number, midpoint: number): number {
  const m = Math.min(0.99, Math.max(0.01, midpoint));
  return Math.pow(t, Math.log(0.5) / Math.log(m));
}

function sampleStops<T extends { offset: number; midpoint: number }>(stops: T[], at: number, value: (s: T) => number[]): number[] {
  if (!stops.length) return [];
  const sorted = [...stops].sort((a, b) => a.offset - b.offset);
  if (at <= sorted[0].offset) return value(sorted[0]);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (at <= b.offset) {
      const span = b.offset - a.offset;
      const t = span > 0 ? midpointCurve((at - a.offset) / span, a.midpoint) : 1;
      const va = value(a);
      const vb = value(b);
      return va.map((v, k) => v + (vb[k] - v) * t);
    }
  }
  return value(sorted[sorted.length - 1]);
}

function addGradientStops(gradient: CanvasGradient, ramp: Gradient, opacity: number): void {
  const n = 64;
  for (let i = 0; i <= n; i++) {
    const at = i / n;
    const [r, g, b] = sampleStops(ramp.colorStops, at, (s) => s.color);
    const [a] = ramp.alphaStops.length ? sampleStops(ramp.alphaStops, at, (s) => [s.alpha]) : [1];
    const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
    gradient.addColorStop(at, `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${Math.min(1, Math.max(0, a * opacity))})`);
  }
}

const DEFAULT_RAMP: Gradient = {
  colorStops: [
    { offset: 0, midpoint: 0.5, color: [1, 1, 1] },
    { offset: 1, midpoint: 0.5, color: [0, 0, 0] },
  ],
  alphaStops: [
    { offset: 0, midpoint: 0.5, alpha: 1 },
    { offset: 1, midpoint: 0.5, alpha: 1 },
  ],
};

// --- Content evaluation -----------------------------------------------------------

/** A path whose geometry later modifiers may replace in place. */
interface PathRecord {
  pieces: Shape[];
}

interface PaintTarget {
  path: PathRecord;
  /** Path space -> paint space. */
  toPaint: Affine;
}

interface Draw {
  paint: PropertyGroup;
  targets: PaintTarget[];
  /** Paint space -> the evaluated group's space. */
  toGroup: Affine;
  opacity: number;
}

interface Evaluated {
  paths: PaintTarget[];
  draws: Draw[];
}

const PAINTS = new Set(["ADBE Vector Graphic - Fill", "ADBE Vector Graphic - Stroke", "ADBE Vector Graphic - G-Fill", "ADBE Vector Graphic - G-Stroke"]);

function groupMatrix(r: Reader, transform: PropertyGroup | undefined): { matrix: Affine; opacity: number } {
  if (!transform) return { matrix: IDENTITY, opacity: 1 };
  const [ax, ay] = r.vec(transform, "ADBE Vector Anchor", [0, 0]);
  const [px, py] = r.vec(transform, "ADBE Vector Position", [0, 0]);
  const [sx, sy] = r.vec(transform, "ADBE Vector Scale", [100, 100]);
  const skew = r.num(transform, "ADBE Vector Skew", 0) * DEG;
  const axis = r.num(transform, "ADBE Vector Skew Axis", 0) * DEG;
  const rotation = r.num(transform, "ADBE Vector Rotation", 0) * DEG;
  // Skew shears along the axis direction: rotate the axis onto x, shear, rotate back.
  const skewM = skew ? mul(rotate(-axis), mul([1, 0, Math.tan(-skew), 1, 0, 0], rotate(axis))) : IDENTITY;
  const matrix = mul(translate(px, py), mul(rotate(rotation), mul(skewM, mul(scale(sx / 100, sy / 100), translate(-ax, -ay)))));
  return { matrix, opacity: r.num(transform, "ADBE Vector Group Opacity", 100) / 100 };
}

function liftDraw(d: Draw, m: Affine, opacity: number): Draw {
  return { ...d, toGroup: mul(m, d.toGroup), opacity: d.opacity * opacity };
}

function evaluateItems(r: Reader, items: PropertyNode[]): Evaluated {
  const paths: PaintTarget[] = [];
  const draws: Draw[] = [];
  for (const item of items) {
    if (item.kind !== "group" || !item.enabled) continue;
    switch (item.matchName) {
      case "ADBE Vector Shape - Rect":
        paths.push({ path: { pieces: [rectPath(r, item)] }, toPaint: IDENTITY });
        break;
      case "ADBE Vector Shape - Ellipse":
        paths.push({ path: { pieces: [ellipsePath(r, item)] }, toPaint: IDENTITY });
        break;
      case "ADBE Vector Shape - Star":
        paths.push({ path: { pieces: [starPath(r, item)] }, toPaint: IDENTITY });
        break;
      case "ADBE Vector Shape - Group": {
        const shape = freePath(r, item);
        if (shape) paths.push({ path: { pieces: [shape] }, toPaint: IDENTITY });
        break;
      }
      case "ADBE Vector Group": {
        const contents = r.group(item, "ADBE Vectors Group");
        const sub = evaluateItems(r, contents?.children ?? []);
        const { matrix, opacity } = groupMatrix(r, r.group(item, "ADBE Vector Transform Group"));
        for (const p of sub.paths) paths.push({ path: p.path, toPaint: mul(matrix, p.toPaint) });
        for (const d of sub.draws) draws.push(liftDraw(d, matrix, opacity));
        break;
      }
      case "ADBE Vector Filter - Trim":
        applyTrim(r, item, paths);
        break;
      case "ADBE Vector Filter - Repeater":
        applyRepeater(r, item, paths, draws);
        break;
      default:
        if (PAINTS.has(item.matchName)) {
          const draw: Draw = { paint: item, targets: paths.map((p) => ({ ...p })), toGroup: IDENTITY, opacity: 1 };
          // "Above Previous in Same Group" draws over the paint before it.
          if (r.num(item, "ADBE Vector Composite Order", 1) === 2 && draws.length) draws.splice(draws.length - 1, 0, draw);
          else draws.push(draw);
        }
    }
  }
  return { paths, draws };
}

function applyTrim(r: Reader, item: PropertyGroup, paths: PaintTarget[]): void {
  let s = r.num(item, "ADBE Vector Trim Start", 0) / 100;
  let e = r.num(item, "ADBE Vector Trim End", 100) / 100;
  if (s > e) [s, e] = [e, s];
  const offset = r.num(item, "ADBE Vector Trim Offset", 0) / 360;
  const individually = r.num(item, "ADBE Vector Trim Type", 1) === 2;
  if (!individually) {
    for (const p of paths) p.path.pieces = p.path.pieces.flatMap((shape) => trimPath(shape, s + offset, e + offset));
    return;
  }
  // Individually: the paths are trimmed as one, in stacking order.
  const lengths = paths.map((p) => p.path.pieces.reduce((sum, shape) => sum + measure(shape).total, 0));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total <= 0) return;
  let from = (s + offset) * total;
  from -= Math.floor(from / total) * total;
  const span = (e - s) * total;
  let start = 0;
  paths.forEach((p, i) => {
    const len = lengths[i];
    const pieces: Shape[] = [];
    for (const window of [[from, from + span], [from - total, from + span - total]]) {
      const a = Math.max(window[0], start) - start;
      const b = Math.min(window[1], start + len) - start;
      if (b > a && len > 0) pieces.push(...p.path.pieces.flatMap((shape) => trimPath(shape, a / len, b / len)));
    }
    p.path.pieces = pieces;
    start += len;
  });
}

function applyRepeater(r: Reader, item: PropertyGroup, paths: PaintTarget[], draws: Draw[]): void {
  const copies = Math.max(0, Math.round(r.num(item, "ADBE Vector Repeater Copies", 3)));
  const offset = r.num(item, "ADBE Vector Repeater Offset", 0);
  const above = r.num(item, "ADBE Vector Repeater Order", 1) === 2;
  const t = r.group(item, "ADBE Vector Repeater Transform");
  const [ax, ay] = t ? r.vec(t, "ADBE Vector Repeater Anchor", [0, 0]) : [0, 0];
  const [px, py] = t ? r.vec(t, "ADBE Vector Repeater Position", [0, 0]) : [0, 0];
  const [sx, sy] = t ? r.vec(t, "ADBE Vector Repeater Scale", [100, 100]) : [100, 100];
  const rotation = t ? r.num(t, "ADBE Vector Repeater Rotation", 0) * DEG : 0;
  const startOpacity = t ? r.num(t, "ADBE Vector Repeater Opacity 1", 100) / 100 : 1;
  const endOpacity = t ? r.num(t, "ADBE Vector Repeater Opacity 2", 100) / 100 : 1;
  const basePaths = paths.splice(0);
  const baseDraws = draws.splice(0);
  const copyLayers: { paths: PaintTarget[]; draws: Draw[] }[] = [];
  for (let i = 0; i < copies; i++) {
    const k = i + offset;
    const matrix = mul(
      translate(ax + px * k, ay + py * k),
      mul(rotate(rotation * k), mul(scale(Math.pow(sx / 100, k), Math.pow(sy / 100, k)), translate(-ax, -ay))),
    );
    // AE steps opacity by 1/copies per copy, so the last copy stops short of the end opacity.
    const opacity = startOpacity + ((endOpacity - startOpacity) * i) / Math.max(1, copies);
    const cloned = new Map<PathRecord, PathRecord>();
    const clone = (p: PathRecord) => {
      let c = cloned.get(p);
      if (!c) cloned.set(p, (c = { pieces: [...p.pieces] }));
      return c;
    };
    copyLayers.push({
      paths: basePaths.map((p) => ({ path: clone(p.path), toPaint: mul(matrix, p.toPaint) })),
      draws: baseDraws.map((d) => ({ ...liftDraw(d, matrix, opacity), targets: d.targets.map((tg) => ({ path: clone(tg.path), toPaint: tg.toPaint })) })),
    });
  }
  // Draws are stored top first; "Below" stacks each copy under the previous one.
  const ordered = above ? [...copyLayers].reverse() : copyLayers;
  for (const c of ordered) {
    paths.push(...c.paths);
    draws.push(...c.draws);
  }
}

// --- Rasterization ------------------------------------------------------------------

export interface ShapeRaster {
  canvas: OffscreenCanvas;
  /** Layer-space position of the canvas's first content pixel (the canvas has a `pad` border). */
  origin: [number, number];
  width: number;
  height: number;
}

function tracePieces(path: Path2D, pieces: Shape[], m: Affine): void {
  for (const piece of pieces) {
    const s = transformShape(piece, m);
    const segs = segments(s);
    if (!s.vertices.length) continue;
    path.moveTo(s.vertices[0][0], s.vertices[0][1]);
    for (const c of segs) path.bezierCurveTo(c[1][0], c[1][1], c[2][0], c[2][1], c[3][0], c[3][1]);
    if (s.closed) path.closePath();
  }
}

function drawBounds(draws: Draw[], r: Reader): [number, number, number, number] | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const d of draws) {
    const stroked = d.paint.matchName.includes("Stroke");
    const width = stroked ? r.num(d.paint, "ADBE Vector Stroke Width", 2) : 0;
    const miter = stroked ? Math.max(1, r.num(d.paint, "ADBE Vector Stroke Miter Limit", 4)) : 1;
    const scaleFactor = Math.hypot(d.toGroup[0], d.toGroup[1]) + Math.hypot(d.toGroup[2], d.toGroup[3]);
    const grow = (width / 2) * miter * scaleFactor + 1;
    for (const t of d.targets) {
      const m = mul(d.toGroup, t.toPaint);
      for (const piece of t.path.pieces) {
        for (const c of segments(transformShape(piece, m)).flat().concat(transformShape(piece, m).vertices)) {
          x0 = Math.min(x0, c[0] - grow);
          y0 = Math.min(y0, c[1] - grow);
          x1 = Math.max(x1, c[0] + grow);
          y1 = Math.max(y1, c[1] + grow);
        }
      }
    }
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
}

const LINE_CAPS: CanvasLineCap[] = ["butt", "butt", "round", "square"];
const LINE_JOINS: CanvasLineJoin[] = ["miter", "miter", "round", "bevel"];
const MAX_RASTER = 8192;

function paintColor(r: Reader, paint: PropertyGroup, colorName: string, opacityName: string, opacity: number): string {
  const [cr, cg, cb] = r.vec(paint, colorName, [1, 1, 1, 1]);
  const a = (r.num(paint, opacityName, 100) / 100) * opacity;
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgba(${c(cr)}, ${c(cg)}, ${c(cb)}, ${Math.min(1, Math.max(0, a))})`;
}

/**
 * AE evaluates gradients at pixel corners, canvas at pixel centers; `shift` is
 * half a canvas pixel expressed in paint space, added to the gradient geometry.
 */
function gradientStyle(ctx: OffscreenCanvasRenderingContext2D, r: Reader, paint: PropertyGroup, opacity: number, shift: number[]): CanvasGradient {
  const [sx0, sy0] = r.vec(paint, "ADBE Vector Grad Start Pt", [0, 0]);
  const [ex0, ey0] = r.vec(paint, "ADBE Vector Grad End Pt", [100, 0]);
  const [sx, sy, ex, ey] = [sx0 + shift[0], sy0 + shift[1], ex0 + shift[0], ey0 + shift[1]];
  const ramp = r.gradient(paint, "ADBE Vector Grad Colors") ?? DEFAULT_RAMP;
  let gradient: CanvasGradient;
  if (r.num(paint, "ADBE Vector Grad Type", 1) === 2) {
    const radius = Math.hypot(ex - sx, ey - sy);
    const length = Math.max(-0.99, Math.min(0.99, r.num(paint, "ADBE Vector Grad HiLite Length", 0) / 100));
    const angle = Math.atan2(ey - sy, ex - sx) + r.num(paint, "ADBE Vector Grad HiLite Angle", 0) * DEG;
    gradient = ctx.createRadialGradient(sx + Math.cos(angle) * radius * length, sy + Math.sin(angle) * radius * length, 0, sx, sy, radius);
  } else {
    gradient = ctx.createLinearGradient(sx, sy, ex, ey);
  }
  addGradientStops(gradient, ramp, (r.num(paint, "ADBE Vector Fill Opacity", r.num(paint, "ADBE Vector Stroke Opacity", 100)) / 100) * opacity);
  return gradient;
}

function dashPattern(r: Reader, paint: PropertyGroup): { dashes: number[]; offset: number } | null {
  const group = r.group(paint, "ADBE Vector Stroke Dashes");
  if (!group) return null;
  const dashes: number[] = [];
  for (const node of group.children) {
    if (node.kind !== "property" || node.synthesized || node.matchName === "ADBE Vector Stroke Offset") continue;
    if (/Dash \d|Gap \d/.test(node.matchName)) dashes.push(r.num(group, node.matchName, 0));
  }
  if (!dashes.length) return null;
  if (dashes.length % 2) dashes.push(dashes[dashes.length - 1]);
  return { dashes, offset: r.num(group, "ADBE Vector Stroke Offset", 0) };
}

/** Rasterizes a shape layer's contents at `time` in layer space; null when it draws nothing. */
export function rasterizeShapeLayer(layer: Layer, time: number, pad: number): ShapeRaster | null {
  const root = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Root Vectors Group");
  if (!root) return null;
  const r = new Reader(layer, time);
  const { draws } = evaluateItems(r, root.children);
  const visible = draws.filter((d) => d.opacity > 0 && d.targets.some((t) => t.path.pieces.length));
  const bounds = drawBounds(visible, r);
  if (!bounds) return null;
  const x0 = Math.floor(bounds[0]);
  const y0 = Math.floor(bounds[1]);
  const width = Math.min(MAX_RASTER, Math.ceil(bounds[2]) - x0);
  const height = Math.min(MAX_RASTER, Math.ceil(bounds[3]) - y0);
  if (width <= 0 || height <= 0) return null;
  const canvas = new OffscreenCanvas(width + 2 * pad, height + 2 * pad);
  const ctx = canvas.getContext("2d")!;

  // Draws are listed top first; paint from the bottom up.
  for (const d of [...visible].reverse()) {
    const kind = d.paint.matchName;
    const toCanvas = mul(translate(pad - x0, pad - y0), d.toGroup);
    ctx.setTransform(...toCanvas);
    const det = toCanvas[0] * toCanvas[3] - toCanvas[1] * toCanvas[2];
    const shift = det ? [(toCanvas[3] * 0.5 - toCanvas[2] * 0.5) / det, (toCanvas[0] * 0.5 - toCanvas[1] * 0.5) / det] : [0, 0];
    const path = new Path2D();
    for (const t of d.targets) tracePieces(path, t.path.pieces, t.toPaint);
    if (kind === "ADBE Vector Graphic - Fill" || kind === "ADBE Vector Graphic - G-Fill") {
      ctx.fillStyle =
        kind === "ADBE Vector Graphic - Fill"
          ? paintColor(r, d.paint, "ADBE Vector Fill Color", "ADBE Vector Fill Opacity", d.opacity)
          : gradientStyle(ctx, r, d.paint, d.opacity, shift);
      ctx.fill(path, r.num(d.paint, "ADBE Vector Fill Rule", 1) === 2 ? "evenodd" : "nonzero");
    } else {
      const width = r.num(d.paint, "ADBE Vector Stroke Width", 2);
      if (width <= 0) continue;
      ctx.lineWidth = width;
      ctx.lineCap = LINE_CAPS[r.num(d.paint, "ADBE Vector Stroke Line Cap", 1)] ?? "butt";
      ctx.lineJoin = LINE_JOINS[r.num(d.paint, "ADBE Vector Stroke Line Join", 1)] ?? "miter";
      ctx.miterLimit = r.num(d.paint, "ADBE Vector Stroke Miter Limit", 4);
      const dash = dashPattern(r, d.paint);
      ctx.setLineDash(dash ? dash.dashes : []);
      ctx.lineDashOffset = dash ? dash.offset : 0;
      ctx.strokeStyle =
        kind === "ADBE Vector Graphic - Stroke"
          ? paintColor(r, d.paint, "ADBE Vector Stroke Color", "ADBE Vector Stroke Opacity", d.opacity)
          : gradientStyle(ctx, r, d.paint, d.opacity, shift);
      ctx.stroke(path);
    }
  }
  return { canvas, origin: [x0, y0], width, height };
}
