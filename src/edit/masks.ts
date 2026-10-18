// Masks added to layers, cloned from a Masks group After Effects 2025 saved
// (data/mask-template.json, exported by scripts/export-mask-template.ts) with the
// shape, mode and name filled in, and the Timeline's mask commands. A layer's Masks
// group (ADBE Mask Parade) comes before its Effects group; each mask is its ADBE Mask
// Atom name, its mkif (inversion, lock, motion blur, feather falloff, mode, id,
// colour) and its properties. Paths are written by paths.ts.
import type { CompItem, Layer, PropertyGroup, Shape } from "../aep/model.ts";
import { findChild, findList, type Chunk } from "../aep/riff.ts";
import { utf8Chunk, type Transaction } from "./chunks.ts";
import type { Editor } from "./editor.ts";
import { clone, nameData, setName } from "./effects.ts";
import { chunksFromBytes, layerTimebase, setChunkData, setTimebase, tdmnName } from "./layer-templates.ts";
import { encodePath, maskUnits } from "./paths.ts";
import template from "./data/mask-template.json" with { type: "json" };

/** ExtendScript MaskMode; the file stores the mode as its offset from NONE. */
export const MaskMode = { NONE: 6812, ADD: 6813, SUBTRACT: 6814, INTERSECT: 6815, LIGHTEN: 6816, DARKEN: 6817, DIFFERENCE: 6818 } as const;
/** ExtendScript MaskFeatherFalloff; stored as its offset from SMOOTH. */
export const MaskFeatherFalloff = { SMOOTH: 7212, LINEAR: 7213 } as const;
/** ExtendScript MaskMotionBlur, by the byte the file stores. */
const MOTION_BLUR_RAW: Record<number, number> = { 7012: 0, 7014: 1, 7013: 2 };

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
const MKIF = { inverted: 0, locked: 1, motionBlur: 2, featherFalloff: 3, mode: 6, id: 8, color: 45 } as const;
/** After Effects' mask colours, picked in turn for new masks ("Cycle Mask Colors"). */
const MASK_COLORS: [number, number, number][] = [
  [0.71, 0.75, 0.91],
  [0.89, 0.85, 0.31],
  [0.71, 0.36, 0.89],
  [0.89, 0.58, 0.32],
  [0.33, 0.71, 0.89],
  [0.89, 0.33, 0.6],
  [0.35, 0.89, 0.42],
];
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

/** The rectangle from (x0, y0) to (x1, y1), from its top right corner anticlockwise as After Effects draws it; `radius` rounds its corners. */
export function rectShape(x0: number, y0: number, x1: number, y1: number, radius = 0): Shape {
  const [left, right] = x0 < x1 ? [x0, x1] : [x1, x0];
  const [top, bottom] = y0 < y1 ? [y0, y1] : [y1, y0];
  const r = Math.max(0, Math.min(radius, (right - left) / 2, (bottom - top) / 2));
  if (!r) {
    const zero = () => [[0, 0], [0, 0], [0, 0], [0, 0]];
    return { closed: true, vertices: [[right, top], [left, top], [left, bottom], [right, bottom]], inTangents: zero(), outTangents: zero() };
  }
  const k = r * KAPPA;
  return {
    closed: true,
    vertices: [
      [right - r, top],
      [left + r, top],
      [left, top + r],
      [left, bottom - r],
      [left + r, bottom],
      [right - r, bottom],
      [right, bottom - r],
      [right, top + r],
    ],
    inTangents: [[k, 0], [0, 0], [0, -k], [0, 0], [-k, 0], [0, 0], [0, k], [0, 0]],
    outTangents: [[0, 0], [-k, 0], [0, 0], [0, k], [0, 0], [k, 0], [0, 0], [0, -k]],
  };
}

/**
 * A star (`inner` > 0) or polygon with `points` outer points around (cx, cy), the first pointing up and
 * turned by `rotation` degrees, as the Star and Polygon tools draw them.
 */
export function starShape(cx: number, cy: number, points: number, outer: number, inner: number, rotation = 0): Shape {
  const corners = inner > 0 ? points * 2 : points;
  const shape: Shape = { closed: true, vertices: [], inTangents: [], outTangents: [] };
  for (let i = 0; i < corners; i++) {
    const a = ((rotation - 90) * Math.PI) / 180 + (i * 2 * Math.PI) / corners;
    const r = inner > 0 && i % 2 ? inner : outer;
    shape.vertices.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    shape.inTangents.push([0, 0]);
    shape.outTangents.push([0, 0]);
  }
  return shape;
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

/** A filled-in mask atom: [tdmn, mkif, LIST:tdgp]. */
function maskAtom(mask: NewMask, id: number, ordinal: number, units: readonly [number, number], timebase: number): Chunk[] {
  const [tdmn, mkif, group] = atomChunks(templateParade()[1]).map(clone);
  const color = MASK_COLORS[(id - 1) % MASK_COLORS.length];
  setChunkData(mkif, (view, bytes) => {
    bytes[MKIF.inverted] = mask.inverted ? 1 : 0;
    view.setUint16(MKIF.mode, (mask.mode ?? MaskMode.ADD) - MaskMode.NONE);
    view.setUint32(MKIF.id, id);
    if (bytes.length >= MKIF.color + 3) color.forEach((c, i) => (bytes[MKIF.color + i] = Math.round(c * 255)));
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
  encodePath(mask.shape, units, shph, lhd3, ldat);
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

function insertMask(tx: Transaction, layer: Layer, atom: Chunk[], after?: Chunk): void {
  const root = findList(layer.chunk, "tdgp");
  if (!root?.children) throw new Error(`layer "${layer.name}" has no property groups`);
  const existing = masksGroup(layer);
  if (existing) {
    const children = existing.children ?? [];
    let end = after ? children.indexOf(after) + 1 : children.findIndex((c) => c.type === "tdmn" && tdmnName(c) === GROUP_END);
    if (end <= 0) end = children.length;
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

function assertMaskable(layer: Layer): void {
  if (layer.layerType === "CameraLayer" || layer.layerType === "LightLayer") throw new Error(`"${layer.name}" cannot have masks`);
}

/** Adds masks after a layer's existing ones, as one undoable step or one step of an enclosing `editor.perform`. */
export function addMasks(editor: Editor, comp: CompItem, layerId: number, masks: NewMask[]): void {
  if (!masks.length) return;
  editor.perform(masks.length > 1 ? "New Masks" : "New Mask", [comp], (tx) => {
    const layer = comp.layers.find((l) => l.id === layerId);
    if (!layer) throw new Error(`layer ${layerId} is not in "${comp.name}"`);
    assertMaskable(layer);
    const units = maskUnits(editor.project, layer);
    const timebase = layerTimebase(comp, layer);
    const parade = masksGroup(layer);
    const ids = parade ? maskIds(parade) : [];
    const ordinal = parade ? layerMasks(layer).length : 0;
    const atoms: Chunk[] = [];
    masks.forEach((mask, i) => atoms.push(...maskAtom(mask, Math.max(0, ...ids) + i + 1, ordinal + i + 1, units, timebase)));
    insertMask(tx, layer, atoms);
  });
}

/** Layer > Mask > New Mask: a mask around the whole layer. */
export function newMask(editor: Editor, comp: CompItem, layer: Layer): void {
  addMasks(editor, comp, layer.id, [{ shape: rectShape(0, 0, layer.width, layer.height) }]);
}

/** The layer's masks, top first. */
export function layerMasks(layer: Layer): PropertyGroup[] {
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === MASK_PARADE);
  return (parade?.children ?? []).filter((n): n is PropertyGroup => n.kind === "group" && !!n.mask);
}

/** A mask's place in its Masks group: the group and the mask's mkif and tdgp. */
function maskChunks(layer: Layer, mask: PropertyGroup): { parade: Chunk; mkif: Chunk; tdgp: Chunk } {
  const parade = masksGroup(layer);
  const children = parade?.children ?? [];
  const at = mask.chunk ? children.indexOf(mask.chunk) : -1;
  const mkif = children[at - 1];
  if (!parade || at < 1 || mkif?.type !== "mkif" || !mask.chunk) throw new Error(`"${mask.name}" is not a mask of "${layer.name}"`);
  return { parade, mkif, tdgp: mask.chunk };
}

function patchMasks(editor: Editor, comp: CompItem, layer: Layer, masks: PropertyGroup[], label: string, edit: (view: DataView, bytes: Uint8Array) => void): void {
  if (!masks.length) return;
  editor.perform(label, [comp], (tx) => {
    for (const mask of masks) tx.patch(maskChunks(layer, mask).mkif, edit, MKIF.color + 3);
  });
}

export function setMaskMode(editor: Editor, comp: CompItem, layer: Layer, masks: PropertyGroup[], mode: number): void {
  if (mode < MaskMode.NONE || mode > MaskMode.DIFFERENCE) throw new Error(`${mode} is not a mask mode`);
  patchMasks(editor, comp, layer, masks, "Change mask mode", (view) => view.setUint16(MKIF.mode, mode - MaskMode.NONE));
}

export function setMaskInverted(editor: Editor, comp: CompItem, layer: Layer, masks: PropertyGroup[], inverted: boolean): void {
  patchMasks(editor, comp, layer, masks, inverted ? "Invert mask" : "Uninvert mask", (_, bytes) => (bytes[MKIF.inverted] = inverted ? 1 : 0));
}

export function setMaskLocked(editor: Editor, comp: CompItem, layer: Layer, masks: PropertyGroup[], locked: boolean): void {
  patchMasks(editor, comp, layer, masks, locked ? "Lock mask" : "Unlock mask", (_, bytes) => (bytes[MKIF.locked] = locked ? 1 : 0));
}

export function setMaskColor(editor: Editor, comp: CompItem, layer: Layer, masks: PropertyGroup[], color: readonly number[]): void {
  patchMasks(editor, comp, layer, masks, "Change mask color", (_, bytes) => color.slice(0, 3).forEach((c, i) => (bytes[MKIF.color + i] = Math.round(Math.min(1, Math.max(0, c)) * 255))));
}

export function setMaskFeatherFalloff(editor: Editor, comp: CompItem, layer: Layer, masks: PropertyGroup[], falloff: number): void {
  patchMasks(editor, comp, layer, masks, "Change mask feather falloff", (_, bytes) => (bytes[MKIF.featherFalloff] = falloff === MaskFeatherFalloff.LINEAR ? 1 : 0));
}

export function setMaskMotionBlur(editor: Editor, comp: CompItem, layer: Layer, masks: PropertyGroup[], motionBlur: number): void {
  patchMasks(editor, comp, layer, masks, "Change mask motion blur", (_, bytes) => (bytes[MKIF.motionBlur] = MOTION_BLUR_RAW[motionBlur] ?? 0));
}

/** Renames a property group (a mask, a shape group) through its tdsn. */
export function renameGroupChunk(tx: Transaction, tdgp: Chunk, name: string): void {
  const tdsn = findChild(tdgp, "tdsn");
  if (!tdsn) throw new Error("the group has no name");
  tx.setData(tdsn, nameData(name));
  tx.setChildren(tdsn, [utf8Chunk(name)]);
}

export function renameMask(editor: Editor, comp: CompItem, layer: Layer, mask: PropertyGroup, name: string): void {
  const text = name.trim();
  if (!text) throw new Error("A mask needs a name");
  editor.perform("Rename mask", [comp], (tx) => renameGroupChunk(tx, maskChunks(layer, mask).tdgp, text));
}

/** Deletes masks; a layer left without any loses its Masks group, as After Effects saves it. */
export function deleteMasks(editor: Editor, comp: CompItem, layer: Layer, masks: PropertyGroup[]): void {
  if (!masks.length) return;
  editor.perform(masks.length > 1 ? "Delete masks" : "Delete mask", [comp], (tx) => {
    const parade = masksGroup(layer)!;
    const drop = new Set<Chunk>();
    for (const mask of masks) {
      const { mkif, tdgp } = maskChunks(layer, mask);
      const children = parade.children ?? [];
      drop.add(children[children.indexOf(mkif) - 1]).add(mkif).add(tdgp);
    }
    const kept = (parade.children ?? []).filter((c) => !drop.has(c));
    if (kept.some((c) => c.type === "mkif")) {
      tx.setChildren(parade, kept);
      return;
    }
    const root = findList(layer.chunk, "tdgp")!;
    const children = root.children ?? [];
    const at = children.indexOf(parade);
    tx.setChildren(root, [...children.slice(0, at - 1), ...children.slice(at + 1)]);
  });
}

/** Duplicates masks below themselves under new ids, named as After Effects names copies. */
export function duplicateMasks(editor: Editor, comp: CompItem, layer: Layer, masks: PropertyGroup[]): void {
  if (!masks.length) return;
  editor.perform(masks.length > 1 ? "Duplicate masks" : "Duplicate mask", [comp], (tx) => {
    const parade = masksGroup(layer)!;
    let id = Math.max(0, ...maskIds(parade));
    let count = layerMasks(layer).length;
    for (const mask of [...masks].reverse()) {
      const { mkif, tdgp } = maskChunks(layer, mask);
      const children = parade.children ?? [];
      const tdmn = children[children.indexOf(mkif) - 1];
      const copy = [clone(tdmn), clone(mkif), clone(tdgp)];
      id++;
      count++;
      setChunkData(copy[1], (view) => view.setUint32(MKIF.id, id));
      const tdsn = findChild(copy[2], "tdsn");
      if (tdsn) setName(tdsn, `Mask ${count}`);
      insertMask(tx, layer, copy, tdgp);
    }
  });
}