// The binary form of a FramePlan the native engine reads (native/src/plan.cpp): little-endian, 32-bit fields.
//
//   plan    := magic "AEVP" u32 version, comp root, u32 imageCount, image*
//   comp    := u32 width, u32 height, u32 layerCount, layer*
//   layer   := u32 flags (1 adjustment), u32 blendMode, f32 opacity, f32[16] matrix (row-major), f32 zoom,
//              content, u32 maskCount, mask*, u32 matteMode, [f32 matteOpacity, u32 hasMatte, [layer]]
//   content := u32 kind (1 solid, 2 comp, 3 image, 4 shape), u32 width, u32 height, f32 originX, f32 originY, f32 scale,
//              solid: f32 r, g, b | comp: comp | image: u32 index | shape: u32 paintCount, paint*
//   paint   := u32 flags (1 stroke, 2 even-odd), f32[6] matrix (a b c d e f), f32 width, u32 cap, u32 join,
//              f32 miterLimit, f32[4] color, u32 gradient (0 none, 1 linear, 2 radial),
//              [f32[2] start, f32[2] end, f32[2] focus, u32 stopCount, f32[4] per stop], u32 pathCount, path*
//   path    := u32 closed, u32 vertexCount, f32[6] per vertex
//   mask    := u32 mode, u32 inverted, f32 opacity, f32 feather, f32 expansion, u32 closed, u32 vertexCount,
//              f32[6] per vertex (x, y, in x, in y, out x, out y)
//   image   := u32 width, u32 height, u8[width * height * 4] straight RGBA, top row first
import type { FramePlan, PlanComp, PlanContent, PlanImage, PlanLayer, PlanMask, ShapePaintPlan } from "./plan.ts";

export const PLAN_MAGIC = 0x50564541; // "AEVP"
export const PLAN_VERSION = 1;

const KIND = { solid: 1, comp: 2, image: 3, shape: 4 } as const;

class Writer {
  private buffer = new ArrayBuffer(4096);
  private view = new DataView(this.buffer);
  private bytes = new Uint8Array(this.buffer);
  length = 0;

  private reserve(n: number): void {
    if (this.length + n <= this.buffer.byteLength) return;
    let size = this.buffer.byteLength * 2;
    while (size < this.length + n) size *= 2;
    const next = new ArrayBuffer(size);
    new Uint8Array(next).set(this.bytes.subarray(0, this.length));
    this.buffer = next;
    this.view = new DataView(next);
    this.bytes = new Uint8Array(next);
  }
  u32(v: number): void {
    this.reserve(4);
    this.view.setUint32(this.length, v >>> 0, true);
    this.length += 4;
  }
  f32(v: number): void {
    this.reserve(4);
    this.view.setFloat32(this.length, v, true);
    this.length += 4;
  }
  raw(data: Uint8Array): void {
    this.reserve(data.length);
    this.bytes.set(data, this.length);
    this.length += data.length;
  }
  result(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

function writeComp(w: Writer, comp: PlanComp): void {
  w.u32(comp.width);
  w.u32(comp.height);
  w.u32(comp.layers.length);
  for (const layer of comp.layers) writeLayer(w, layer);
}

function writeContent(w: Writer, content: PlanContent): void {
  w.u32(KIND[content.kind]);
  w.u32(content.width);
  w.u32(content.height);
  w.f32(content.origin[0]);
  w.f32(content.origin[1]);
  w.f32(content.scale);
  if (content.kind === "solid") for (const c of content.color) w.f32(c);
  else if (content.kind === "comp") writeComp(w, content.comp);
  else if (content.kind === "image") w.u32(content.image);
  else {
    w.u32(content.paints.length);
    for (const paint of content.paints) writePaint(w, paint);
  }
}

function writePaint(w: Writer, paint: ShapePaintPlan): void {
  w.u32((paint.stroke ? 1 : 0) | (paint.evenOdd ? 2 : 0));
  for (const v of paint.matrix) w.f32(v);
  w.f32(paint.width);
  w.u32(paint.cap);
  w.u32(paint.join);
  w.f32(paint.miterLimit);
  for (const c of paint.color) w.f32(c);
  const g = paint.gradient;
  w.u32(g ? (g.radial ? 2 : 1) : 0);
  if (g) {
    for (const v of [...g.start, ...g.end, ...g.focus]) w.f32(v);
    w.u32(g.ramp.length / 4);
    for (const v of g.ramp) w.f32(v);
  }
  w.u32(paint.paths.length);
  for (const path of paint.paths) {
    w.u32(path.closed ? 1 : 0);
    w.u32(path.vertices.length / 6);
    for (const v of path.vertices) w.f32(v);
  }
}

function writeMask(w: Writer, mask: PlanMask): void {
  w.u32(mask.mode);
  w.u32(mask.inverted ? 1 : 0);
  w.f32(mask.opacity);
  w.f32(mask.feather);
  w.f32(mask.expansion);
  w.u32(mask.closed ? 1 : 0);
  w.u32(mask.vertices.length / 6);
  for (const v of mask.vertices) w.f32(v);
}

function writeLayer(w: Writer, layer: PlanLayer): void {
  w.u32(layer.adjustment ? 1 : 0);
  w.u32(layer.blendMode);
  w.f32(layer.opacity);
  for (let i = 0; i < 16; i++) w.f32(layer.matrix[i]);
  w.f32(layer.zoom);
  writeContent(w, layer.content);
  w.u32(layer.masks.length);
  for (const mask of layer.masks) writeMask(w, mask);
  w.u32(layer.matte?.mode ?? 0);
  if (layer.matte) {
    w.f32(layer.matte.opacity);
    w.u32(layer.matte.layer ? 1 : 0);
    if (layer.matte.layer) writeLayer(w, layer.matte.layer);
  }
}

/** The plan in the engine's binary form. */
export function encodePlan(plan: Pick<FramePlan, "root" | "images">): Uint8Array {
  const w = new Writer();
  w.u32(PLAN_MAGIC);
  w.u32(PLAN_VERSION);
  writeComp(w, plan.root);
  w.u32(plan.images.length);
  for (const image of plan.images) {
    if (image.pixels.length !== image.width * image.height * 4) throw new Error(`image of ${image.width}x${image.height} holds ${image.pixels.length} bytes`);
    w.u32(image.width);
    w.u32(image.height);
    w.raw(image.pixels);
  }
  return w.result();
}

class Reader {
  private offset = 0;
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number): void {
    if (this.offset + n > this.bytes.length) throw new Error(`plan truncated at byte ${this.offset}`);
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }
  raw(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  get done(): boolean {
    return this.offset === this.bytes.length;
  }
}

function readComp(r: Reader): PlanComp {
  const width = r.u32();
  const height = r.u32();
  const count = r.u32();
  const layers: PlanLayer[] = [];
  for (let i = 0; i < count; i++) layers.push(readLayer(r));
  return { width, height, layers };
}

function readContent(r: Reader): PlanContent {
  const kind = r.u32();
  const base = { width: r.u32(), height: r.u32(), origin: [r.f32(), r.f32()] as [number, number], scale: r.f32() };
  if (kind === KIND.solid) return { ...base, kind: "solid", color: [r.f32(), r.f32(), r.f32()] };
  if (kind === KIND.comp) return { ...base, kind: "comp", comp: readComp(r) };
  if (kind === KIND.image) return { ...base, kind: "image", image: r.u32() };
  if (kind === KIND.shape) {
    const paints: ShapePaintPlan[] = [];
    for (let i = r.u32(); i > 0; i--) paints.push(readPaint(r));
    return { ...base, kind: "shape", paints };
  }
  throw new Error(`unknown content kind ${kind}`);
}

function readPaint(r: Reader): ShapePaintPlan {
  const flags = r.u32();
  const matrix = [r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32()] as ShapePaintPlan["matrix"];
  const width = r.f32();
  const cap = r.u32();
  const join = r.u32();
  const miterLimit = r.f32();
  const color: ShapePaintPlan["color"] = [r.f32(), r.f32(), r.f32(), r.f32()];
  const paint: ShapePaintPlan = { stroke: (flags & 1) !== 0, evenOdd: (flags & 2) !== 0, matrix, width, cap, join, miterLimit, color, paths: [] };
  const gradient = r.u32();
  if (gradient) {
    const start: [number, number] = [r.f32(), r.f32()];
    const end: [number, number] = [r.f32(), r.f32()];
    const focus: [number, number] = [r.f32(), r.f32()];
    const ramp = Array.from({ length: r.u32() * 4 }, () => r.f32());
    paint.gradient = { radial: gradient === 2, start, end, focus, ramp };
  }
  for (let i = r.u32(); i > 0; i--) {
    const closed = r.u32() !== 0;
    const vertices = Array.from({ length: r.u32() * 6 }, () => r.f32());
    paint.paths.push({ closed, vertices });
  }
  return paint;
}

function readLayer(r: Reader): PlanLayer {
  const flags = r.u32();
  const blendMode = r.u32();
  const opacity = r.f32();
  const matrix = Array.from({ length: 16 }, () => r.f32());
  const zoom = r.f32();
  const content = readContent(r);
  const masks: PlanMask[] = [];
  for (let i = r.u32(); i > 0; i--) {
    const mode = r.u32();
    const inverted = r.u32() !== 0;
    const maskOpacity = r.f32();
    const feather = r.f32();
    const expansion = r.f32();
    const closed = r.u32() !== 0;
    const count = r.u32();
    const vertices = Array.from({ length: count * 6 }, () => r.f32());
    masks.push({ mode, inverted, opacity: maskOpacity, feather, expansion, closed, vertices });
  }
  const layer: PlanLayer = { name: "", adjustment: (flags & 1) !== 0, blendMode, opacity, content, masks, matrix, zoom };
  const matteMode = r.u32();
  if (matteMode) {
    const matteOpacity = r.f32();
    layer.matte = { mode: matteMode, opacity: matteOpacity, layer: r.u32() ? readLayer(r) : null };
  }
  return layer;
}

/** A plan read back from its binary form (layer names are not kept; numbers are 32-bit floats). */
export function decodePlan(bytes: Uint8Array): Pick<FramePlan, "root" | "images"> {
  const r = new Reader(bytes);
  if (r.u32() !== PLAN_MAGIC) throw new Error("not a render plan");
  const version = r.u32();
  if (version !== PLAN_VERSION) throw new Error(`render plan version ${version} (expected ${PLAN_VERSION})`);
  const root = readComp(r);
  const images: PlanImage[] = [];
  for (let i = r.u32(); i > 0; i--) {
    const width = r.u32();
    const height = r.u32();
    images.push({ width, height, pixels: r.raw(width * height * 4) });
  }
  if (!r.done) throw new Error("render plan has trailing bytes");
  return { root, images };
}
