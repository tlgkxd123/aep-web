// Project-level operations, the way After Effects' Project panel and File /
// Composition menus perform them: each is one undoable editor command that
// rewrites the item chunks (see items.ts), after which the editor re-derives
// the item tree. New items are cloned from the py-aep-authored templates in
// templates.ts and patched.
import { decodeLhd3, ldatItems } from "../aep/decode.ts";
import type { CompItem, FolderItem, FootageItem, Item, Layer, Project } from "../aep/model.ts";
import { readRifx, findChild, findList, filterLists, type Chunk } from "../aep/riff.ts";
import { Editor } from "./editor.ts";
import type { Transaction } from "./chunks.ts";
import { CDTA, LDTA, setRatio, stampTimeBase, timebaseFor, writeFrameRate } from "./encode.ts";
import { buildPin, carryInterpretation, footageFlags, footageLabel, setFootageSource, type FootageFile } from "./footage.ts";
import {
  allocateIds,
  detachBlocks,
  folderContainer,
  folderIsWithin,
  insertBlocks,
  itemBlock,
  nextName,
  duplicateName,
  setItemName,
} from "./items.ts";
import { cloneChunk, emptyProjectFile, templateBlock } from "./templates.ts";
import { writeRifx } from "../aep/write.ts";

export interface CompSettings {
  name: string;
  width: number;
  height: number;
  pixelAspect: number;
  frameRate: number;
  /** Seconds. */
  duration: number;
  bgColor: [number, number, number];
  /** Downsample factors, [1, 1] for Full. */
  resolutionFactor: [number, number];
  /** Start timecode in seconds. */
  displayStartTime: number;
}

/** AE 2025's factory New Composition settings (HD·1080·29.97). */
export const DEFAULT_COMP_SETTINGS: CompSettings = {
  name: "Comp 1",
  width: 1920,
  height: 1080,
  pixelAspect: 1,
  frameRate: 30000 / 1001,
  /** 0:00:30:00, 900 frames. */
  duration: (900 * 1001) / 30000,
  bgColor: [0, 0, 0],
  resolutionFactor: [1, 1],
  displayStartTime: 0,
};

const view = (chunk: Chunk) => new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);

// ---------------------------------------------------------------- new project

/** File > New > New Project: an empty AE 25.6 project (8 bpc, no working space). */
export function newProject(): Editor {
  return new Editor(readRifx(writeRifx(emptyProjectFile())));
}

// ---------------------------------------------------------------- new items

function setItemIds(itemList: Chunk, id: number, label?: number): void {
  const iide = findChild(itemList, "iide");
  if (iide) view(iide).setUint32(0, id, true);
  const idta = findChild(itemList, "idta");
  if (!idta) throw new Error("item template has no idta");
  view(idta).setUint32(16, id);
  if (label !== undefined) idta.data[58] = label;
}

const setUtf8 = (chunk: Chunk | undefined, text: string) => {
  if (chunk) chunk.data = new TextEncoder().encode(text);
};

/** The tdbs that follows the property's `tdmn` in a property group. */
function propertyTdbs(group: Chunk | undefined, matchName: string): Chunk | undefined {
  const children = group?.children ?? [];
  for (let i = 0; i < children.length - 1; i++) {
    const c = children[i];
    if (c.type !== "tdmn") continue;
    const name = new TextDecoder().decode(c.data).replace(/\0.*$/s, "");
    if (name === matchName) return children[i + 1];
  }
  return undefined;
}

function transformGroup(viewLayer: Chunk): Chunk | undefined {
  const tdgp = findList(viewLayer, "tdgp");
  const tdbs = propertyTdbs(tdgp, "ADBE Transform Group");
  return tdbs?.listType === "tdgp" ? tdbs : undefined;
}

function setPoint(tdbs: Chunk | undefined, point: [number, number, number]): void {
  const cdat = findChild(tdbs, "cdat");
  if (cdat) point.forEach((v, i) => view(cdat).setFloat64(i * 8, v));
}

/** Viewer positions of AE's 3D views, by view name (py-aep's comp skeleton). */
function viewPosition(name: string, w2: number, h2: number, zv: number): [number, number, number] | undefined {
  switch (name) {
    case "Front": return [w2, h2, -5000];
    case "Left": return [w2 - 5000, h2, 0];
    case "Top": return [w2, h2 - 5000, 0];
    case "Back": return [w2, h2, 5000];
    case "Right": return [w2 + 5000, h2, 0];
    case "Bottom": return [w2, h2 + 5000, 0];
    case "Custom View 1": return [w2 - zv, h2 - zv, -zv];
    case "Custom View 2": return [w2, h2 - zv, -zv];
    case "Custom View 3": return [w2 + zv, h2 - zv, -zv];
  }
  return undefined;
}

const VIEW_LAYERS = new Set(["DLay", "SLay", "CLay", "SecL"]);

/** A comp duration in timebase units, whole frames like AE. */
function durationUnits(duration: number, frameRate: number, timebase: number): number {
  return Math.round(duration * frameRate) * Math.round(timebase / frameRate);
}

/** Throws AE's complaint about settings it would not accept. */
export function validateCompSettings(s: CompSettings): void {
  if (!s.name.trim()) throw new Error("The composition needs a name");
  for (const [what, v] of [["Width", s.width], ["Height", s.height]] as const) {
    if (!Number.isInteger(v) || v < 4 || v > 30000) throw new Error(`${what} must be a whole number from 4 to 30000`);
  }
  if (!(s.pixelAspect >= 0.01 && s.pixelAspect <= 100)) throw new Error("Pixel aspect ratio must be from 0.01 to 100");
  if (!(s.frameRate >= 1 && s.frameRate <= 999)) throw new Error("Frame rate must be from 1 to 999 frames per second");
  if (!(s.duration > 0 && s.duration <= 10800)) throw new Error("Duration must be more than 0 and at most 3 hours");
  if (Math.round(s.duration * s.frameRate) < 1) throw new Error("Duration must be at least one frame");
}

function compBlock(project: Project, tx: Transaction, s: CompSettings): { block: Chunk[]; id: number } {
  validateCompSettings(s);
  const block = templateBlock("COMP");
  const item = block[0];
  const viewLayers = (item.children ?? []).filter((c) => c.type === "LIST" && VIEW_LAYERS.has(c.listType ?? ""));
  const [id, ...layerIds] = allocateIds(project, tx, 1 + viewLayers.length);
  setItemIds(item, id);
  setUtf8(findChild(item, "Utf8"), s.name);

  const { internalTimebase: tb } = timebaseFor(s.frameRate);
  const units = durationUnits(s.duration, s.frameRate, tb);
  const cdta = findChild(item, "cdta")!;
  const cv = view(cdta);
  writeFrameRate(cv, s.frameRate);
  cv.setUint16(CDTA.width, s.width);
  cv.setUint16(CDTA.height, s.height);
  setRatio(cv, CDTA.pixelAspect, s.pixelAspect, false);
  cv.setUint32(CDTA.duration, units);
  cv.setUint32(CDTA.duration + 4, tb);
  s.bgColor.forEach((c, i) => (cdta.data[CDTA.bgColor + i] = Math.round(c * 255)));
  s.resolutionFactor.forEach((f, i) => cv.setUint16(CDTA.resolutionFactor + i * 2, f));
  const startFrames = Math.round(s.displayStartTime * s.frameRate);
  cv.setInt32(CDTA.displayStartTime, startFrames * Math.round(tb / s.frameRate));
  cv.setUint32(CDTA.displayStartTime + 4, tb);

  const w2 = s.width / 2;
  const h2 = s.height / 2;
  const zv = (s.width * s.pixelAspect) / 0.72;
  viewLayers.forEach((layer, i) => {
    const ldta = findChild(layer, "ldta")!;
    const lv = view(ldta);
    lv.setUint32(0, layerIds[i]);
    lv.setUint32(LDTA.inPoint + 4, tb);
    lv.setUint32(LDTA.outPoint, units);
    lv.setUint32(LDTA.outPoint + 4, tb);
    const visit = (chunk: Chunk) => {
      for (const c of chunk.children ?? []) {
        if (c.type === "tdb4" && c.data.length > 80 && view(c).getUint32(12)) stampTimeBase(c.data, tb, s.pixelAspect);
        if (c.children) visit(c);
      }
    };
    visit(layer);
    const transform = transformGroup(layer);
    setPoint(propertyTdbs(transform, "ADBE Anchor Point"), [w2, h2, 0]);
    const name = new TextDecoder().decode(findChild(layer, "Utf8")?.data);
    const position = viewPosition(name, w2, h2, zv);
    if (position) setPoint(propertyTdbs(transform, "ADBE Position"), position);
  });
  return { block, id };
}

const created = <T extends Item>(editor: Editor, id: number, kind: T["kind"]): T => {
  const item = editor.project.items.get(id);
  if (!item || item.kind !== kind) throw new Error(`the new ${kind} was not created`);
  return item as T;
};

/** Composition > New Composition. */
export function newComposition(editor: Editor, settings: CompSettings, folderId = 0): CompItem {
  let id = 0;
  editor.runProjectCommand("New Composition", (tx) => {
    const comp = compBlock(editor.project, tx, settings);
    id = comp.id;
    insertBlocks(tx, folderContainer(editor.project, folderId), comp.block);
  });
  return created<CompItem>(editor, id, "comp");
}

/** File > New > New Folder: "Untitled N", ready to be renamed. */
export function newFolder(editor: Editor, folderId = 0, name = nextName(editor.project, "Untitled")): FolderItem {
  let id = 0;
  editor.runProjectCommand("New Folder", (tx) => {
    const block = templateBlock("FOLDER");
    [id] = allocateIds(editor.project, tx, 1);
    setItemIds(block[0], id);
    setUtf8(findChild(block[0], "Utf8"), name);
    insertBlocks(tx, folderContainer(editor.project, folderId), block);
  });
  return created<FolderItem>(editor, id, "folder");
}

// ---------------------------------------------------------------- rename / move

/** Renames an item (Project panel, or a composition's timeline tab). */
export function renameItem(editor: Editor, item: Item, name: string): void {
  if (!item.chunk || name === item.name) return;
  if (!name.trim() && item.kind !== "footage") return;
  editor.runProjectCommand(`Rename ${item.kind === "comp" ? "Composition" : item.kind === "folder" ? "Folder" : "Footage"}`, (tx) => {
    setItemName(tx, item.chunk!, name.trim() ? name : "");
  });
}

/** Drag and drop in the Project panel: moves items (with their contents) into a folder, or to the root. */
export function moveItems(editor: Editor, items: Item[], folderId: number): void {
  const project = editor.project;
  const moving = topLevel(project, items).filter((i) => i.parentFolderId !== folderId);
  if (!moving.length) return;
  for (const item of moving) {
    if (item.kind === "folder" && folderIsWithin(project, folderId, item)) throw new Error(`Cannot move folder "${item.name}" into itself`);
  }
  editor.runProjectCommand(moving.length > 1 ? "Move Items" : "Move Item", (tx) => {
    const blocks = moving.map((i) => itemBlock(project, i));
    const target = folderContainer(project, folderId);
    detachBlocks(tx, blocks);
    insertBlocks(tx, target, blocks.flatMap((b) => b.chunks));
  });
}

/** Drops items whose folder is also in the list. */
function topLevel(project: Project, items: Item[]): Item[] {
  const ids = new Set(items.map((i) => i.id));
  return items.filter((item) => {
    for (let id = item.parentFolderId; id; id = project.items.get(id)?.parentFolderId ?? 0) if (ids.has(id)) return false;
    return true;
  });
}

// ---------------------------------------------------------------- delete

/** The items and everything inside the folders among them. */
function withContents(project: Project, items: Item[]): Set<Item> {
  const out = new Set<Item>();
  const add = (item: Item) => {
    out.add(item);
    if (item.kind === "folder") for (const child of item.items) add(project.items.get(child.id) ?? child);
  };
  for (const item of items) add(item);
  return out;
}

export interface ItemUsage {
  /** Layers in compositions that survive the delete that use one of the items. */
  layers: { comp: CompItem; layer: Layer }[];
  /** Render queue items that render one of the compositions. */
  renderQueue: number;
}

/** Comp ids the render queue renders (`LIST:LRdr` render settings, 2246-byte items). */
function renderQueueComps(project: Project): number[] {
  const list = findList(findList(project.file.root, "LRdr"), "list");
  const lhd3 = findChild(list, "lhd3");
  const ldat = findChild(list, "ldat");
  if (!lhd3 || !ldat || lhd3.data.length < 24) return [];
  return ldatItems(ldat, decodeLhd3(lhd3))
    .filter((item) => item.length >= 12)
    .map((item) => item.u32(8));
}

/** What deleting the items would take with it: AE warns before deleting items used in compositions. */
export function itemUsage(project: Project, items: Item[]): ItemUsage {
  const doomed = withContents(project, items);
  const ids = new Set([...doomed].map((i) => i.id));
  const layers: ItemUsage["layers"] = [];
  for (const comp of project.items.values()) {
    if (comp.kind !== "comp" || ids.has(comp.id)) continue;
    for (const layer of comp.layers) if (layer.sourceId && ids.has(layer.sourceId)) layers.push({ comp, layer });
  }
  return { layers, renderQueue: renderQueueComps(project).filter((id) => ids.has(id)).length };
}

/** Removes layer blocks (`LIST:Layr` and the view data after it) and clears references to them. */
function removeLayers(tx: Transaction, comp: CompItem, layers: Layer[]): void {
  const list = comp.chunk;
  if (!list?.children) return;
  const removedIds = new Set(layers.map((l) => l.id));
  const removed = new Set<Chunk>();
  const children = list.children;
  for (const layer of layers) {
    const start = children.indexOf(layer.chunk);
    if (start < 0) continue;
    removed.add(layer.chunk);
    for (let i = start + 1; i < children.length; i++) {
      const c = children[i];
      if (c.type === "LIST" && LAYER_BLOCK_ENDS.has(c.listType ?? "")) break;
      removed.add(c);
    }
  }
  tx.setChildren(list, children.filter((c) => !removed.has(c)));
  for (const layer of comp.layers) {
    if (removedIds.has(layer.id)) continue;
    const ldta = findChild(layer.chunk, "ldta");
    if (!ldta) continue;
    const parent = removedIds.has(layer.parentId);
    const matte = ldta.data.length >= LDTA.matteLayerId + 4 && removedIds.has(view(ldta).getUint32(LDTA.matteLayerId));
    if (!parent && !matte) continue;
    tx.patch(ldta, (v, bytes) => {
      if (parent) v.setUint32(LDTA.parentId, 0);
      if (matte) {
        v.setUint32(LDTA.matteLayerId, 0);
        bytes[LDTA.trackMatteType] = 0;
      }
    });
  }
}

const LAYER_BLOCK_ENDS = new Set(["Layr", "DLay", "SLay", "CLay", "SecL", "CIFO", "CIF2", "CIF3", "Gide"]);

/**
 * Edit > Clear in the Project panel: deletes the items, folder contents
 * included, and the layers that use them in other compositions.
 */
export function deleteItems(editor: Editor, items: Item[]): void {
  const project = editor.project;
  const roots = topLevel(project, items.filter((i) => i.chunk));
  if (!roots.length) return;
  const usage = itemUsage(project, roots);
  if (usage.renderQueue) throw new Error("A composition to delete is in the Render Queue, which this editor cannot change yet");
  const doomed = withContents(project, roots);
  editor.runProjectCommand(doomed.size > 1 ? "Delete Items" : "Delete Item", (tx) => {
    const byComp = new Map<CompItem, Layer[]>();
    for (const { comp, layer } of usage.layers) byComp.set(comp, [...(byComp.get(comp) ?? []), layer]);
    for (const [comp, layers] of byComp) removeLayers(tx, comp, layers);
    detachBlocks(tx, roots.map((i) => itemBlock(project, i)));
    const fcid = findChild(project.file.root, "fcid");
    if (fcid && fcid.data.length >= 4 && [...doomed].some((i) => i.id === view(fcid).getUint32(0))) {
      tx.patch(fcid, (v) => v.setUint32(0, 0));
    }
  });
}

// ---------------------------------------------------------------- duplicate

/** Edit > Duplicate on a composition: a copy with fresh layer ids, after the original. */
export function duplicateComp(editor: Editor, comp: CompItem): CompItem {
  const project = editor.project;
  let id = 0;
  editor.runProjectCommand("Duplicate", (tx) => {
    const original = itemBlock(project, comp);
    const block = original.chunks.map(cloneChunk);
    const item = block[0];
    const ldtas: Chunk[] = [];
    const tdpis: Chunk[] = [];
    const visit = (chunk: Chunk) => {
      for (const c of chunk.children ?? []) {
        if (c.type === "ldta" && c.data.length >= 4) ldtas.push(c);
        else if (c.type === "tdpi" && c.data.length >= 4) tdpis.push(c);
        else if (c.children) visit(c);
      }
    };
    visit(item);
    const [newId, ...layerIds] = allocateIds(project, tx, 1 + ldtas.length);
    id = newId;
    setItemIds(item, newId);
    const idMap = new Map<number, number>();
    ldtas.forEach((ldta, i) => idMap.set(view(ldta).getUint32(0), layerIds[i]));
    for (const ldta of ldtas) {
      const v = view(ldta);
      v.setUint32(0, idMap.get(v.getUint32(0))!);
      if (ldta.data.length >= LDTA.parentId + 4 && idMap.has(v.getUint32(LDTA.parentId))) v.setUint32(LDTA.parentId, idMap.get(v.getUint32(LDTA.parentId))!);
      if (ldta.data.length >= LDTA.matteLayerId + 4 && idMap.has(v.getUint32(LDTA.matteLayerId))) {
        v.setUint32(LDTA.matteLayerId, idMap.get(v.getUint32(LDTA.matteLayerId))!);
      }
    }
    for (const tdpi of tdpis) {
      const value = view(tdpi).getInt32(0);
      if (idMap.has(value)) view(tdpi).setInt32(0, idMap.get(value)!);
    }
    rewriteEssentialGraphics(item, comp.id, newId, idMap);
    setUtf8(findChild(item, "Utf8"), duplicateName(project, comp.name));
    insertBlocks(tx, original.container, block, comp.chunk);
  });
  return created<CompItem>(editor, id, "comp");
}

/** Essential Graphics controllers of a duplicate get new uuids and point at the duplicate (py-aep, AE 2026). */
function rewriteEssentialGraphics(item: Chunk, oldCompId: number, newCompId: number, idMap: Map<number, number>): void {
  const uuids = new Map<string, string>();
  for (const cif of item.children ?? []) {
    if (cif.type !== "LIST" || !["CIFO", "CIF2", "CIF3"].includes(cif.listType ?? "")) continue;
    for (const cctl of filterLists(cif, "CCtl")) {
      const uuid = findChild(cctl, "Utf8");
      if (uuid) {
        const old = new TextDecoder().decode(uuid.data);
        if (!uuids.has(old)) uuids.set(old, crypto.randomUUID());
        setUtf8(uuid, uuids.get(old)!);
      }
      for (const c of cctl.children ?? []) if ((c.type === "CVal" || c.type === "CDef") && c.data.length) c.data = new Uint8Array(c.data.length);
      for (const c of findList(cctl, "CPrp")?.children ?? []) {
        if (c.data.length < 4) continue;
        const value = view(c).getUint32(0);
        if (c.type === "CCId" && value === oldCompId) view(c).setUint32(0, newCompId);
        if (c.type === "CLId" && idMap.has(value)) view(c).setUint32(0, idMap.get(value)!);
      }
    }
  }
}

// ---------------------------------------------------------------- footage

function footageBlock(project: Project, tx: Transaction, file: FootageFile): { block: Chunk[]; id: number } {
  const block = templateBlock("PNG");
  const item = block[0];
  const [id] = allocateIds(project, tx, 1);
  setItemIds(item, id, footageLabel(file.info));
  const idta = findChild(item, "idta")!;
  idta.data[23] = (idta.data[23] & ~0x34) | footageFlags(file.info);
  setUtf8(findChild(item, "Utf8"), "");
  const children = item.children!;
  const pin = children.findIndex((c) => c.type === "LIST" && c.listType === "Pin ");
  children[pin] = buildPin(file);
  return { block, id };
}

/** File > Import > File: footage items named after their files, in the folder (the root by default). */
export function importFootage(editor: Editor, files: FootageFile[], folderId = 0): FootageItem[] {
  if (!files.length) return [];
  const ids: number[] = [];
  editor.runProjectCommand(files.length > 1 ? "Import Files" : "Import File", (tx) => {
    const container = folderContainer(editor.project, folderId);
    const blocks = files.map((file) => footageBlock(editor.project, tx, file));
    for (const b of blocks) ids.push(b.id);
    insertBlocks(tx, container, blocks.flatMap((b) => b.block));
  });
  return ids.map((id) => created<FootageItem>(editor, id, "footage"));
}

/**
 * File > Replace Footage > File: points the item at another file. Layers that
 * use it keep their settings; the item's size, duration and frame rate come
 * from the new file, its Interpret Footage choices carry over.
 */
export function replaceFootage(editor: Editor, item: FootageItem, file: FootageFile): FootageItem {
  if (!item.chunk) throw new Error(`footage "${item.name}" has no chunks`);
  if (item.mainSource.sourceType !== "FileSource") throw new Error("Only file footage can be replaced with a file");
  const oldPin = findList(item.chunk, "Pin ");
  editor.runProjectCommand("Replace Footage", (tx) => {
    const pin = buildPin(file);
    if (oldPin) carryInterpretation(oldPin, pin, file.info.duration === 0);
    setFootageSource(tx, item.chunk!, pin, file.info);
  });
  return created<FootageItem>(editor, item.id, "footage");
}

export type { FootageFile };
