// Layer commands: new solid / null / shape / adjustment layers, layers from
// project items, delete, duplicate and stacking order. New layer and solid
// blocks are py-aep's output (see layer-templates.ts) with the fields that vary
// between layers patched in.
import { decodeCdta, decodeLdta } from "../aep/decode.ts";
import type { CompItem, FolderItem, Item, Layer, Project } from "../aep/model.ts";
import { findChild, findList, type Chunk } from "../aep/riff.ts";
import type { Transaction } from "./chunks.ts";
import type { Editor } from "./editor.ts";
import { fixedUtf8, LAYER_SWITCHES, LDTA, setBit, setRatio } from "./encode.ts";
import { allocateId } from "./layer-items.ts";
import { setChunkData, setTimebase, tdmnName, template } from "./layer-templates.ts";
import { setParentKeepingTransform, writeTransform } from "./transform-ops.ts";

export { chunkBytes, chunksFromBytes } from "./layer-templates.ts";

// ---------------------------------------------------------------- pure builders

export interface LayerBlockSpec {
  id: number;
  sourceId: number;
  label: number;
  /** The stored layer name; empty for layers named after their source. */
  name: string;
  startTime: number;
  duration: number;
  /** The comp's internal timebase (cdta). */
  timebase: number;
  nullLayer?: boolean;
  adjustmentLayer?: boolean;
}

/** A new layer block (`LIST:Layr` and its view chunks) as AE writes it. */
export function buildLayerBlock(kind: "av" | "shape", spec: LayerBlockSpec): Chunk[] {
  const block = template(kind === "shape" ? "shapeLayer" : "avLayer");
  const layr = block[0];
  setChunkData(findChild(layr, "ldta"), (view, bytes) => {
    view.setUint32(0, spec.id);
    setRatio(view, LDTA.startTime, spec.startTime);
    setRatio(view, LDTA.inPoint, 0);
    setRatio(view, LDTA.outPoint, spec.duration);
    view.setUint32(40, spec.sourceId);
    bytes[61] = spec.label;
    bytes.set(fixedUtf8(spec.name, 32), LDTA.name);
    setBit(bytes, 38, 7, !!spec.nullLayer);
    setBit(bytes, ...LAYER_SWITCHES.adjustmentLayer, !!spec.adjustmentLayer);
  });
  const utf8 = findChild(layr, "Utf8");
  if (utf8) utf8.data = new TextEncoder().encode(spec.name);
  setTimebase(layr, spec.timebase);
  return block;
}

export interface SolidSpec {
  id: number;
  name: string;
  color: [number, number, number];
  width: number;
  height: number;
  pixelAspect: number;
  label: number;
  /** 16 bytes; random when omitted. */
  guid?: Uint8Array;
}

/** A solid footage item (`LIST:Item` and its view chunks); nulls use the null template. */
export function buildSolidItem(spec: SolidSpec, kind: "solid" | "null" = "solid"): Chunk[] {
  const block = template(kind === "null" ? "nullItem" : "solidItem");
  const item = block[0];
  setChunkData(findChild(item, "iide"), (view) => view.setUint32(0, spec.id, true));
  setChunkData(findChild(item, "idta"), (view, bytes) => {
    view.setUint32(16, spec.id);
    bytes[58] = spec.label;
  });
  const pin = findList(item, "Pin ");
  setChunkData(findChild(pin, "sspc"), (view) => {
    view.setUint16(32, spec.width);
    view.setUint16(36, spec.height);
    setRatio(view, 136, spec.pixelAspect, false);
  });
  setChunkData(findChild(pin, "opti"), (view, bytes) => {
    spec.color.forEach((c, i) => view.setFloat32(14 + i * 4, c));
    bytes.set(fixedUtf8(spec.name, 256), 26);
  });
  const guid = findChild(pin, "pgui");
  if (guid) guid.data = spec.guid ?? crypto.getRandomValues(new Uint8Array(16));
  return block;
}

/** A project folder item and its view chunks. */
export function buildFolderItem(id: number, name: string): Chunk[] {
  const block = template("folderItem");
  const item = block[0];
  setChunkData(findChild(item, "iide"), (view) => view.setUint32(0, id, true));
  setChunkData(findChild(item, "idta"), (view) => view.setUint32(16, id));
  const utf8 = findChild(item, "Utf8");
  if (utf8) utf8.data = new TextEncoder().encode(name);
  return block;
}

// ---------------------------------------------------------------- naming

const HUE_BANDS: [number, string][] = [
  [15, "Red"],
  [45, "Orange"],
  [75, "Yellow"],
  [105, "Lime Green"],
  [135, "Green"],
  [165, "Turquoise"],
  [195, "Cyan"],
  [225, "Royal Blue"],
  [255, "Blue"],
  [285, "Purple"],
  [315, "Magenta"],
  [345, "Magenta-Red"],
  [360, "Red"],
];

/** AE's colour-derived solid name ("Deep Orange Solid"), without the number. */
export function solidColorName([r, g, b]: [number, number, number]): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max * 100;
  const s = max === 0 ? 0 : ((max - min) / max) * 100;
  let h = 0;
  if (max !== min) {
    const d = max - min;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = ((h * 60) % 360 + 360) % 360;
  }
  let label: string;
  if (s === 0) label = v === 0 ? "Black" : v < 38 ? "Dark Gray" : v < 63 ? "Gray" : v < 88 ? "Light Gray" : "White";
  else {
    const hue = HUE_BANDS.find(([upper]) => h < upper)?.[1] ?? "Red";
    const [mid, high] = s < 25 ? [`Pale Gray-${hue}`, `Pale ${hue}`] : s < 75 ? [`Medium Gray-${hue}`, `Medium ${hue}`] : [`Deep ${hue}`, hue];
    label = v === 0 ? "Black" : v < 25 ? `Dark ${hue}` : v < 75 ? mid : high;
  }
  return `${label} Solid`;
}

/** `name` with the next free number: "Null" -> "Null 1", "Box 2" -> "Box 3". */
export function autoName(name: string, existing: Iterable<string>): string {
  const match = /(\d+)$/.exec(name);
  const prefix = match ? name.slice(0, match.index) : `${name} `;
  let max = 0;
  for (const other of existing) {
    if (other.startsWith(prefix)) {
      const tail = other.slice(prefix.length);
      max = Math.max(max, /^\d+$/.test(tail) ? Math.max(1, Number(tail)) : 1);
    } else if (other === prefix.trimEnd()) max = Math.max(max, 1);
  }
  return `${prefix}${max + 1}`;
}

// ---------------------------------------------------------------- label defaults

/** Factory Label Defaults (Preferences > Labels). */
export const LABEL_DEFAULTS = { solid: 1, null: 1, shape: 8, adjustment: 5 } as const;

// ---------------------------------------------------------------- comp layer blocks

const BLOCK_ENDS = new Set(["Layr", "DLay", "SLay", "CLay", "SecL", "CIFO", "CIF2", "CIF3", "Gide"]);

interface LayerBlocks {
  head: Chunk[];
  blocks: Chunk[][];
  tail: Chunk[];
}

function layerBlocks(list: Chunk): LayerBlocks {
  const head: Chunk[] = [];
  const blocks: Chunk[][] = [];
  const tail: Chunk[] = [];
  for (const c of list.children ?? []) {
    const boundary = c.type === "LIST" && BLOCK_ENDS.has(c.listType ?? "");
    if (c.type === "LIST" && c.listType === "Layr" && !tail.length) blocks.push([c]);
    else if (boundary || tail.length) tail.push(c);
    else if (blocks.length) blocks.at(-1)!.push(c);
    else head.push(c);
  }
  return { head, blocks, tail };
}

const joinBlocks = ({ head, blocks, tail }: LayerBlocks): Chunk[] => [...head, ...blocks.flat(), ...tail];

function compList(comp: CompItem): Chunk {
  if (!comp.chunk?.children) throw new Error(`composition "${comp.name}" has no chunks`);
  return comp.chunk;
}

/** Inserts `block` into the stack directly above `above`, or at the top. */
function insertBlock(tx: Transaction, comp: CompItem, block: Chunk[], above?: Layer): void {
  const list = compList(comp);
  const parts = layerBlocks(list);
  const at = above ? parts.blocks.findIndex((b) => b[0] === above.chunk) : 0;
  parts.blocks.splice(Math.max(0, at), 0, block);
  tx.setChildren(list, joinBlocks(parts));
}

const ldtaOf = (layer: Layer): Chunk => {
  const ldta = findChild(layer.chunk, "ldta");
  if (!ldta) throw new Error(`layer "${layer.name}" has no ldta chunk`);
  return ldta;
};

// ---------------------------------------------------------------- new layers

export type NewLayer =
  | { kind: "solid"; color: [number, number, number]; width: number; height: number; pixelAspect?: number; name?: string }
  | { kind: "adjustment" }
  | { kind: "null" }
  | { kind: "shape" }
  | { kind: "item"; itemId: number };

export interface Placement {
  /** The new layer goes directly above this layer; at the top of the stack otherwise. */
  above?: Layer;
  /** Comp point for the layer's anchor; the comp centre otherwise. */
  position?: [number, number];
  /** Start time in comp seconds; 0 by default ("Create New Layers At Time Zero"). */
  startTime?: number;
}

const NEW_LAYER_LABELS: Record<NewLayer["kind"], string> = {
  solid: "New Solid",
  adjustment: "New Adjustment Layer",
  null: "New Null Object",
  shape: "New Shape Layer",
  item: "Add Layer",
};

/** Whether `outer` is `target` or uses it, directly or through nested comps. */
export function compUses(project: Project, outer: CompItem, target: number, seen = new Set<number>()): boolean {
  if (outer.id === target) return true;
  if (seen.has(outer.id)) return false;
  seen.add(outer.id);
  return outer.layers.some((l) => {
    const source = project.items.get(l.sourceId);
    return source?.kind === "comp" && compUses(project, source, target, seen);
  });
}

function solidsFolderName(project: Project): string {
  const sfnm = findList(project.file.root, "sfnm");
  const utf8 = findChild(sfnm, "Utf8");
  return (utf8 && new TextDecoder().decode(utf8.data)) || "Solids";
}

/** The project's Solids folder, created at the root when missing. */
function solidsFolder(tx: Transaction, editor: Editor): FolderItem {
  const project = editor.project;
  const name = solidsFolderName(project);
  const existing = project.rootFolder.items.find((i): i is FolderItem => i.kind === "folder" && i.name === name);
  if (existing) return existing;
  const root = project.rootFolder.chunk;
  if (!root) throw new Error("project has no root folder");
  const id = allocateId(tx, project);
  tx.setChildren(root, [...(root.children ?? []), ...buildFolderItem(id, name)]);
  editor.syncItems();
  const folder = project.items.get(id);
  if (folder?.kind !== "folder") throw new Error("could not create the Solids folder");
  return folder;
}

function addSolidItem(tx: Transaction, editor: Editor, spec: Omit<SolidSpec, "id">, kind: "solid" | "null"): number {
  const folder = solidsFolder(tx, editor);
  const sfdr = findList(folder.chunk, "Sfdr");
  if (!sfdr) throw new Error(`folder "${folder.name}" has no Sfdr list`);
  const id = allocateId(tx, editor.project);
  tx.setChildren(sfdr, [...(sfdr.children ?? []), ...buildSolidItem({ ...spec, id }, kind)]);
  editor.syncItems();
  return id;
}

const itemNames = (project: Project) => [...project.items.values()].map((i) => i.name);

/** Adds a layer the way Layer > New and dropping a project item do; returns the new layer's id. */
export function addLayer(editor: Editor, comp: CompItem, layer: NewLayer, place: Placement = {}): number {
  const project = editor.project;
  let source: Item | undefined;
  if (layer.kind === "item") {
    source = project.items.get(layer.itemId);
    if (!source || source.kind === "folder") throw new Error("Only footage and compositions can be added as layers");
    if (source.kind === "comp" && compUses(project, source, comp.id)) {
      throw new Error(`"${source.name}" cannot be added to "${comp.name}": it would contain itself`);
    }
  }
  const cdta = findChild(comp.chunk, "cdta");
  if (!cdta) throw new Error(`composition "${comp.name}" has no cdta chunk`);
  const timebase = decodeCdta(cdta).internalTimebase;
  const above = place.above;
  let id = 0;
  editor.perform(
    NEW_LAYER_LABELS[layer.kind],
    [comp],
    (tx) => {
      let sourceId = 0;
      let label: number = LABEL_DEFAULTS.solid;
      let name = "";
      let duration = comp.duration;
      let adjustmentLayer = false;
      let nullLayer = false;
      if (layer.kind === "solid" || layer.kind === "adjustment") {
        const solid =
          layer.kind === "solid"
            ? { ...layer, pixelAspect: layer.pixelAspect ?? 1 }
            : { color: [1, 1, 1] as [number, number, number], width: comp.width, height: comp.height, pixelAspect: comp.pixelAspect };
        const solidName =
          (layer.kind === "solid" && layer.name) ||
          autoName(layer.kind === "solid" ? solidColorName(layer.color) : "Adjustment Layer", itemNames(project));
        sourceId = addSolidItem(tx, editor, { ...solid, name: solidName, label: LABEL_DEFAULTS.solid }, "solid");
        adjustmentLayer = layer.kind === "adjustment";
        if (adjustmentLayer) label = LABEL_DEFAULTS.adjustment;
      } else if (layer.kind === "null") {
        const nullName = autoName("Null", comp.layers.map((l) => l.name));
        sourceId = addSolidItem(tx, editor, { name: nullName, color: [0, 0, 0], width: 100, height: 100, pixelAspect: 1, label: LABEL_DEFAULTS.null }, "null");
        nullLayer = true;
        label = LABEL_DEFAULTS.null;
      } else if (layer.kind === "shape") {
        name = autoName("Shape Layer", comp.layers.map((l) => l.name));
        label = LABEL_DEFAULTS.shape;
      } else if (source && source.kind !== "folder") {
        sourceId = source.id;
        label = source.label;
        duration = source.duration > 0 ? source.duration : comp.duration;
      }
      id = allocateId(tx, project);
      const block = buildLayerBlock(layer.kind === "shape" ? "shape" : "av", {
        id,
        sourceId,
        label,
        name,
        startTime: place.startTime ?? 0,
        duration,
        timebase,
        nullLayer,
        adjustmentLayer,
      });
      editor.perform("", [comp], (inner) => insertBlock(inner, comp, block, above));
      const [x, y] = place.position ?? [comp.width / 2, comp.height / 2];
      writeTransform(editor, comp, id, { position: [x, y] }, place.startTime ?? 0);
    },
    { items: layer.kind !== "shape" && layer.kind !== "item" },
  );
  return id;
}

// ---------------------------------------------------------------- delete / duplicate / order

/**
 * Deletes layers. Children are unparented keeping their place in the comp and
 * track mattes that used a deleted layer are cleared; the source items stay.
 */
export function deleteLayers(editor: Editor, comp: CompItem, layers: Layer[], time: number): void {
  const ids = new Set(layers.map((l) => l.id));
  if (!ids.size) return;
  editor.perform(layers.length > 1 ? "Delete Layers" : "Delete Layer", [comp], (tx) => {
    const live = () => comp.layers.filter((l) => !ids.has(l.id));
    for (const child of live().filter((l) => ids.has(l.parentId)).map((l) => l.id)) {
      const layer = comp.layers.find((l) => l.id === child);
      if (layer) setParentKeepingTransform(editor, comp, layer, 0, time);
    }
    for (const layer of live()) {
      if (!ids.has(layer.trackMatteLayerId)) continue;
      tx.patch(ldtaOf(layer), (view, bytes) => {
        view.setUint32(LDTA.matteLayerId, 0);
        bytes[LDTA.trackMatteType] = 0;
      });
    }
    const list = compList(comp);
    const parts = layerBlocks(list);
    parts.blocks = parts.blocks.filter((b) => {
      const ldta = findChild(b[0], "ldta");
      return !ldta || !ids.has(decodeLdta(ldta).id);
    });
    tx.setChildren(list, joinBlocks(parts));
  });
}

function cloneChunk(chunk: Chunk): Chunk {
  return { ...chunk, children: chunk.children?.map(cloneChunk) };
}

/** Points every effect's hidden `-0000` parameter at the owning layer, as AE does on duplicate. */
function rewriteOwnerTdpi(list: Chunk, layerId: number): void {
  const children = list.children ?? [];
  children.forEach((c, i) => {
    const next = children[i + 1];
    if (c.type === "tdmn" && tdmnName(c).endsWith("-0000") && next?.children) {
      for (const inner of next.children) if (inner.type === "tdpi") setChunkData(inner, (view) => view.setInt32(0, layerId));
    } else if (c.children) rewriteOwnerTdpi(c, layerId);
  });
}

/** Duplicates layers directly above their originals (Edit > Duplicate); returns the new ids. */
export function duplicateLayers(editor: Editor, comp: CompItem, layers: Layer[]): number[] {
  const created: number[] = [];
  if (!layers.length) return created;
  editor.perform(layers.length > 1 ? "Duplicate Layers" : "Duplicate Layer", [comp], (tx) => {
    const list = compList(comp);
    const parts = layerBlocks(list);
    const names = comp.layers.map((l) => l.name);
    for (const layer of [...layers].sort((a, b) => a.index - b.index)) {
      const at = parts.blocks.findIndex((b) => b[0] === layer.chunk);
      if (at < 0) continue;
      const block = parts.blocks[at].map(cloneChunk);
      const layr = block[0];
      const id = allocateId(tx, editor.project);
      const utf8 = findChild(layr, "Utf8");
      const stored = utf8 ? new TextDecoder().decode(utf8.data) : "";
      const name = stored ? autoName(stored, names) : "";
      if (name) names.push(name);
      setChunkData(findChild(layr, "ldta"), (view, bytes) => {
        view.setUint32(0, id);
        if (name) bytes.set(fixedUtf8(name, 32), LDTA.name);
      });
      if (utf8 && name) findChild(layr, "Utf8")!.data = new TextEncoder().encode(name);
      rewriteOwnerTdpi(layr, id);
      parts.blocks.splice(at, 0, block);
      created.push(id);
    }
    tx.setChildren(list, joinBlocks(parts));
  });
  return created;
}

export type Arrange = "forward" | "backward" | "front" | "back";

/** Layer > Arrange: Bring Forward / Send Backward / Bring to Front / Send to Back. */
export function arrangeLayer(editor: Editor, comp: CompItem, layer: Layer, how: Arrange): void {
  const count = comp.layers.length;
  const index = how === "front" ? 1 : how === "back" ? count : how === "forward" ? layer.index - 1 : layer.index + 1;
  if (index < 1 || index > count || index === layer.index) return;
  editor.moveLayer(comp, layer, index);
}

/** The duration and frame rate of the layer's source when it has time to remap (movies and comps, not stills). */
function remappableSource(project: Project, layer: Layer): { duration: number; frameRate: number } | undefined {
  const source = layer.sourceId ? project.items.get(layer.sourceId) : undefined;
  if (source?.kind !== "footage" && source?.kind !== "comp") return undefined;
  if (source.kind === "footage" && source.mainSource.isStill) return undefined;
  return source.duration > 0 ? { duration: source.duration, frameRate: source.frameRate || 24 } : undefined;
}

/** Whether Layer > Time > Enable Time Remapping applies to the layer. */
export function canRemapTime(project: Project, layer: Layer): boolean {
  return !!remappableSource(project, layer) && layer.properties.some((n) => n.matchName === "ADBE Time Remapping" && n.kind === "property");
}

/**
 * Layer > Time > Enable Time Remapping, on or off. On seeds the two linear keys After Effects' command adds:
 * source time 0 at the layer's start and the source's last frame where the layer reaches it. Off removes
 * every Time Remap key, which turns remapping off.
 */
export function setTimeRemapping(editor: Editor, comp: CompItem, layers: Layer[], on: boolean): void {
  editor.perform(on ? "Enable Time Remapping" : "Disable Time Remapping", [comp], () => {
    for (const { id } of layers) {
      const layer = comp.layers.find((l) => l.id === id);
      const source = layer && remappableSource(editor.project, layer);
      const prop = layer?.properties.find((n) => n.matchName === "ADBE Time Remapping");
      if (!layer || !source || prop?.kind !== "property" || layer.timeRemapEnabled === on) continue;
      if (!on) {
        editor.removeKeyframes(comp, layer, prop, prop.keyframes.map((_, i) => i), 0);
        continue;
      }
      const last = Math.max(0, source.duration - 1 / source.frameRate);
      const keys = [
        { time: layer.startTime, value: 0 },
        { time: layer.startTime + last * (layer.stretch / 100), value: last },
      ];
      editor.replaceKeyframes(comp, layer, [{ prop, keys }], -Infinity, Infinity, "Enable Time Remapping");
    }
  });
}