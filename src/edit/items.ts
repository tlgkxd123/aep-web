// Project-panel item plumbing: where an item's chunks live, the project-wide
// id counter, and item names. An item is a block in its folder's container
// (the root `LIST:Fold`, or a folder's `LIST:Sfdr`): its `LIST:Item` followed
// by the view data AE writes after it, up to the next `LIST:Item`.
import type { Item, Project } from "../aep/model.ts";
import { findChild, findList, type Chunk } from "../aep/riff.ts";
import type { Transaction } from "./chunks.ts";

const isItemList = (c: Chunk) => c.type === "LIST" && c.listType === "Item";

export function rootContainer(project: Project): Chunk {
  const fold = findList(project.file.root, "Fold");
  if (!fold) throw new Error("project has no root folder (LIST:Fold)");
  return fold;
}

/** The chunk list holding a folder's items. */
export function folderContainer(project: Project, folderId: number): Chunk {
  if (folderId === 0) return rootContainer(project);
  const folder = project.items.get(folderId);
  const sfdr = folder?.kind === "folder" ? findList(folder.chunk, "Sfdr") : undefined;
  if (!sfdr) throw new Error(`item ${folderId} is not a folder`);
  return sfdr;
}

export interface ItemBlock {
  container: Chunk;
  chunks: Chunk[];
}

export function itemBlock(project: Project, item: Item): ItemBlock {
  const container = folderContainer(project, item.parentFolderId);
  const children = container.children ?? [];
  const start = item.chunk ? children.indexOf(item.chunk) : -1;
  if (start < 0) throw new Error(`item "${item.name}" is not in its folder`);
  let end = start + 1;
  while (end < children.length && !isItemList(children[end])) end++;
  return { container, chunks: children.slice(start, end) };
}

/** Removes the blocks from their containers. */
export function detachBlocks(tx: Transaction, blocks: ItemBlock[]): void {
  const byContainer = new Map<Chunk, Set<Chunk>>();
  for (const { container, chunks } of blocks) {
    const set = byContainer.get(container) ?? new Set();
    for (const c of chunks) set.add(c);
    byContainer.set(container, set);
  }
  for (const [container, removed] of byContainer) {
    tx.setChildren(container, (container.children ?? []).filter((c) => !removed.has(c)));
  }
}

/** Inserts item blocks into a folder container, after `after`'s block or at the end. */
export function insertBlocks(tx: Transaction, container: Chunk, chunks: Chunk[], after?: Chunk): void {
  const children = container.children ?? [];
  let at = children.length;
  if (after) {
    const start = children.indexOf(after);
    if (start >= 0) {
      at = start + 1;
      while (at < children.length && !isItemList(children[at])) at++;
    }
  }
  tx.setChildren(container, [...children.slice(0, at), ...chunks, ...children.slice(at)]);
}

/** Whether folder `folderId` is `item` or inside it. */
export function folderIsWithin(project: Project, folderId: number, item: Item): boolean {
  for (let id: number | undefined = folderId; id; id = project.items.get(id)?.parentFolderId) {
    if (id === item.id) return true;
  }
  return false;
}

// ---------------------------------------------------------------- ids

const u32 = (chunk: Chunk, at: number) => new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength).getUint32(at);

function maxLiveId(project: Project): number {
  let max = 0;
  for (const id of project.items.keys()) max = Math.max(max, id);
  const visit = (chunk: Chunk) => {
    for (const c of chunk.children ?? []) {
      if (c.type === "ldta" && c.data.length >= 4) max = Math.max(max, u32(c, 0));
      else if (c.children) visit(c);
    }
  };
  for (const item of project.items.values()) if (item.kind === "comp" && item.chunk) visit(item.chunk);
  return max;
}

/**
 * Draws ids from the project-wide counter in `head` that After Effects uses
 * for items and layers alike (viewer pseudo-layers included). AE trusts the
 * counter on open, so it is first raised past every id in use.
 */
export function allocateIds(project: Project, tx: Transaction, count: number): number[] {
  const head = findChild(project.file.root, "head");
  if (!head || head.data.length < 16) throw new Error("project has no head chunk");
  const next = Math.max(u32(head, 12), maxLiveId(project) + 1);
  tx.patch(head, (view) => view.setUint32(12, next + count));
  return Array.from({ length: count }, (_, i) => next + i);
}

// ---------------------------------------------------------------- names

export function setItemName(tx: Transaction, itemList: Chunk, name: string): void {
  const utf8 = findChild(itemList, "Utf8");
  if (!utf8) throw new Error("item has no name chunk");
  tx.setData(utf8, new TextEncoder().encode(name));
}

/** `base N` with the smallest N no item uses (AE's "Comp 1", "Untitled 1"). */
export function nextName(project: Project, base: string): string {
  const used = new Set([...project.items.values()].map((i) => i.name));
  for (let n = 1; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** The name AE gives a duplicate: the trailing number counted up past every name in use. */
export function duplicateName(project: Project, name: string): string {
  const used = new Set([...project.items.values()].map((i) => i.name));
  const m = /^(.*?)(?: (\d+))?$/.exec(name)!;
  const stem = m[1];
  for (let n = m[2] ? Number(m[2]) + 1 : 2; ; n++) if (!used.has(`${stem} ${n}`)) return `${stem} ${n}`;
}
