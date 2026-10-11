// Masks added to layers, cloned from a Masks group After Effects 2025 saved
// (data/mask-template.json, exported by scripts/export-mask-template.ts) with the
// shape, mode and name filled in. A layer's Masks group (ADBE Mask Parade) comes
// before its Effects group; each mask is its ADBE Mask Atom name, its mkif (mode,
// inversion, id) and its properties. A shape is stored as a bounding box (shph, in
// shares of the layer's size when the layer has a source, in pixels otherwise) and
// three points per vertex inside that box (the vertex, its out handle and the next
// vertex's in handle), the last pointing back at the first vertex even when open.
import type { CompItem, Layer, Shape } from "../aep/model.ts";
import { findChild, findList, type Chunk } from "../aep/riff.ts";
import type { Transaction } from "./chunks.ts";
import type { Editor } from "./editor.ts";
import { clone, setName } from "./effects.ts";
import { setBit } from "./encode.ts";
import { chunksFromBytes, layerTimebase, setChunkData, setTimebase, tdmnName } from "./layer-templates.ts";
import template from "./data/mask-template.json" with { type: "json" };

/** ExtendScript MaskMode; the file stores the mode as its offset from NONE. */
export const MaskMode = { NONE: 6812, ADD: 6813, SUBTRACT: 6814, INTERSECT: 6815, LIGHTEN: 6816, DARKEN: 6817, DIFFERENCE: 6818 } as const;

export interface NewMask {
  /** In layer pixels. */
  shape: Shape;
  /** A MaskMode; Add by default. */
  mode?: number;
  inverted?: boolean;
  /** "Mask n" by default. */
  name?: string;
}

const MASK_PARADE = "ADBE Mask Parade";
const MASK_ATOM = "ADBE Mask Atom";
const GROUP_END = "ADBE Group End";
/** Groups the Masks group comes before in a layer. */
const AFTER_MASKS = new Set(["ADBE Effect Parade", "ADBE Essential Properties", "ADBE Transform Group"]);
const MKIF = { inverted: 0, mode: 6, id: 8 } as const;
const SHPH = { flags: 3, openBit: 3, topLeft: 4, bottomRight: 12 } as const;
const LHD3_COUNT = 10;
/** Handle length of a cubic Bézier quarter circle, as a share of the radius. */
const KAPPA = (4 / 3) * Math.tan(Math.PI / 8);

const decodeBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** A fresh copy of the template's Masks group: its tdmn and LIST:tdgp. */
function templateParade(): [Chunk, Chunk] {
  const [tdmn, parade] = chunksFromBytes(template.parade.map(decodeBase64));
  if (!tdmn || !parade) throw new Error("the mask template is damaged");
  return [tdmn, parade];
}

/** The atom of a Masks group, as the chunks that follow its name: [tdmn, mkif, LIST:tdgp]. */
function atomChunks(parade: Chunk): Chunk[] {
  const children = parade.children ?? [];
  const at = children.findIndex((c) => c.type === "tdmn" && tdmnName(c) === MASK_ATOM);
  if (at < 0) throw new Error("the mask template has no mask");
  return children.slice(at, at + 3);
}

/** An ellipse inscribed in the box centred on (cx, cy), drawn as After Effects' Ellipse tool draws it: from the top, anticlockwise on screen. */
export function ellipseShape(cx: number, cy: number, rx: number, ry: number): Shape {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return {
    closed: true,
    vertices: [
      [cx, cy - ry],
      [cx - rx, cy],
      [cx, cy + ry],
      [cx + rx, cy],
    ],
    inTangents: [
      [kx, 0],
      [0, -ky],
      [-kx, 0],
      [0, ky],
    ],
    outTangents: [
      [-kx, 0],
      [0, ky],
      [kx, 0],
      [0, -ky],
    ],
  };
}

/**
 * An open arc of the circle around (cx, cy) from angle `from` to angle `to` (degrees, 0 pointing right and 90
 * down, as screen angles go), with a vertex at least every quarter turn.
 */
export function arcShape(cx: number, cy: number, radius: number, from: number, to: number): Shape {
  const sweep = ((to - from) * Math.PI) / 180;
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const step = sweep / segments;
  const handle = (4 / 3) * Math.tan(step / 4) * radius;
  const shape: Shape = { closed: false, vertices: [], inTangents: [], outTangents: [] };
  for (let i = 0; i <= segments; i++) {
    const a = (from * Math.PI) / 180 + i * step;
    const tangent = [-Math.sin(a) * handle, Math.cos(a) * handle];
    shape.vertices.push([cx + Math.cos(a) * radius, cy + Math.sin(a) * radius]);
    shape.outTangents.push(i < segments ? tangent : [0, 0]);
    shape.inTangents.push(i > 0 ? [-tangent[0], -tangent[1]] : [0, 0]);
  }
  return shape;
}

/** The shape's shph box and ldat points, in the units of a layer of `size` (shares of it; [1, 1] for pixels). */
function encodeShape(shape: Shape, size: readonly [number, number], shph: Chunk, lhd3: Chunk, ldat: Chunk): void {
  const n = shape.vertices.length;
  if (!n) throw new Error("a mask needs at least one vertex");
  const absolute: number[][] = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = shape.vertices[i];
    const next = shape.vertices[(i + 1) % n];
    const out = shape.outTangents[i] ?? [0, 0];
    const inn = shape.inTangents[(i + 1) % n] ?? [0, 0];
    absolute.push([x, y], [x + out[0], y + out[1]], [next[0] + inn[0], next[1] + inn[1]]);
  }
  const points = absolute.map(([x, y]) => [x / size[0], y / size[1]]);
  const lo = [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))];
  const hi = [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))];
  const span = [hi[0] - lo[0] || 1, hi[1] - lo[1] || 1];
  setChunkData(shph, (view, bytes) => {
    setBit(bytes, SHPH.flags, SHPH.openBit, !shape.closed);
    view.setFloat32(SHPH.topLeft, lo[0]);
    view.setFloat32(SHPH.topLeft + 4, lo[1]);
    view.setFloat32(SHPH.bottomRight, hi[0]);
    view.setFloat32(SHPH.bottomRight + 4, hi[1]);
  });
  setChunkData(lhd3, (view) => view.setUint16(LHD3_COUNT, points.length));
  const data = new Uint8Array(points.length * 8);
  const view = new DataView(data.buffer);
  points.forEach(([x, y], i) => {
    view.setFloat32(i * 8, (x - lo[0]) / span[0]);
    view.setFloat32(i * 8 + 4, (y - lo[1]) / span[1]);
  });
  ldat.data = data;
}

/** A filled-in mask atom: [tdmn, mkif, LIST:tdgp]. */
function maskAtom(mask: NewMask, id: number, ordinal: number, size: readonly [number, number], timebase: number): Chunk[] {
  const [tdmn, mkif, group] = atomChunks(templateParade()[1]).map(clone);
  setChunkData(mkif, (view, bytes) => {
    bytes[MKIF.inverted] = mask.inverted ? 1 : 0;
    view.setUint16(MKIF.mode, (mask.mode ?? MaskMode.ADD) - MaskMode.NONE);
    view.setUint32(MKIF.id, id);
  });
  const tdsn = findChild(group, "tdsn");
  if (tdsn) setName(tdsn, mask.name ?? `Mask ${ordinal}`);
  let shap: Chunk | undefined;
  const visit = (c: Chunk) => {
    if (c.listType === "shap") shap = c;
    c.children?.forEach(visit);
  };
  visit(group);
  const list = findList(shap, "list");
  const shph = findChild(shap, "shph");
  const lhd3 = findChild(list, "lhd3");
  const ldat = findChild(list, "ldat");
  if (!shph || !lhd3 || !ldat) throw new Error("the mask template has no shape");
  encodeShape(mask.shape, size, shph, lhd3, ldat);
  setTimebase(group, timebase);
  return [tdmn, mkif, group];
}

const masksGroup = (layer: Layer): Chunk | undefined => {
  const children = findList(layer.chunk, "tdgp")?.children ?? [];
  const at = children.findIndex((c) => c.type === "tdmn" && tdmnName(c) === MASK_PARADE);
  return at >= 0 && children[at + 1]?.listType === "tdgp" ? children[at + 1] : undefined;
};

/** Mask ids of a Masks group (After Effects numbers a layer's masks from 1). */
const maskIds = (parade: Chunk): number[] =>
  (parade.children ?? []).filter((c) => c.type === "mkif" && c.data.length >= 12).map((c) => new DataView(c.data.buffer, c.data.byteOffset).getUint32(MKIF.id));

function insertMask(tx: Transaction, layer: Layer, atom: Chunk[]): void {
  const root = findList(layer.chunk, "tdgp");
  if (!root?.children) throw new Error(`layer "${layer.name}" has no property groups`);
  const existing = masksGroup(layer);
  if (existing) {
    const children = existing.children ?? [];
    let end = children.findIndex((c) => c.type === "tdmn" && tdmnName(c) === GROUP_END);
    if (end < 0) end = children.length;
    tx.setChildren(existing, [...children.slice(0, end), ...atom, ...children.slice(end)]);
    return;
  }
  const [tdmn, parade] = templateParade();
  const children = parade.children ?? [];
  const at = children.findIndex((c) => c.type === "tdmn" && tdmnName(c) === MASK_ATOM);
  parade.children = [...children.slice(0, at), ...atom, ...children.slice(at + 3)];
  const layerChildren = root.children;
  let before = layerChildren.findIndex((c) => c.type === "tdmn" && AFTER_MASKS.has(tdmnName(c)));
  if (before < 0) before = layerChildren.findIndex((c) => c.type === "tdmn" && tdmnName(c) === GROUP_END);
  if (before < 0) before = layerChildren.length;
  tx.setChildren(root, [...layerChildren.slice(0, before), tdmn, parade, ...layerChildren.slice(before)]);
}

/** Adds masks after a layer's existing ones, as one undoable step or one step of an enclosing `editor.perform`. */
export function addMasks(editor: Editor, comp: CompItem, layerId: number, masks: NewMask[]): void {
  if (!masks.length) return;
  editor.perform(masks.length > 1 ? "New Masks" : "New Mask", [comp], (tx) => {
    const layer = comp.layers.find((l) => l.id === layerId);
    if (!layer) throw new Error(`layer ${layerId} is not in "${comp.name}"`);
    if (layer.layerType === "CameraLayer" || layer.layerType === "LightLayer") throw new Error(`"${layer.name}" cannot have masks`);
    const source = editor.project.items.get(layer.sourceId);
    const size: [number, number] = source && source.kind !== "folder" ? [source.width, source.height] : [1, 1];
    const timebase = layerTimebase(comp, layer);
    const parade = masksGroup(layer);
    const ids = parade ? maskIds(parade) : [];
    const atoms: Chunk[] = [];
    masks.forEach((mask, i) => {
      const ordinal = ids.length + i + 1;
      atoms.push(...maskAtom(mask, Math.max(0, ...ids) + i + 1, ordinal, size, timebase));
    });
    insertMask(tx, layer, atoms);
  });
}
