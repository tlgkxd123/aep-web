// Import an After Effects project as editable items, preserving the original chunks and allocating fresh
// project-wide item/layer IDs. Only the imported tree is rewritten; the destination keeps its settings.
import type { FolderItem, Project } from "../aep/model.ts";
import { findChild, findList, type Chunk } from "../aep/riff.ts";
import { leaf, list, type Transaction } from "./chunks.ts";
import type { Editor } from "./editor.ts";
import { LDTA } from "./encode.ts";
import { allocateIds, folderContainer, insertBlocks, rootContainer } from "./items.ts";
import { cloneChunk, templateBlock } from "./templates.ts";

const text = (c: Chunk | undefined) => c ? new TextDecoder().decode(c.data).replace(/\0.*$/s, "") : "";
const view = (c: Chunk) => new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);

function visit(chunk: Chunk, fn: (c: Chunk) => void): void {
  fn(chunk);
  for (const child of chunk.children ?? []) visit(child, fn);
}

/** Adds missing effect definitions and plug-in entries without changing the destination's existing ones. */
function mergeEffects(tx: Transaction, root: Chunk, source: Chunk): void {
  const plugins = findList(root, "Pefl");
  const incomingPlugins = findList(source, "Pefl")?.children ?? [];
  if (plugins) {
    const names = new Set((plugins.children ?? []).filter((c) => c.type === "pjef").map(text));
    const added = incomingPlugins.filter((c) => c.type === "pjef" && !names.has(text(c))).map(cloneChunk);
    if (added.length) tx.setChildren(plugins, [...(plugins.children ?? []), ...added]);
  } else if (incomingPlugins.length) {
    tx.setChildren(root, [...(root.children ?? []), list("Pefl", incomingPlugins.map(cloneChunk))]);
  }
  const definitions = findList(root, "EfdG");
  const names = new Set((definitions?.children ?? []).filter((c) => c.listType === "EfDf").map((c) => text(findChild(c, "tdmn"))));
  const added = (findList(source, "EfdG")?.children ?? [])
    .filter((c) => c.listType === "EfDf" && !names.has(text(findChild(c, "tdmn"))))
    .map(cloneChunk);
  if (!added.length) return;
  if (definitions) {
    const count = findChild(definitions, "EfDC") ?? leaf("EfDC", new Uint8Array(4));
    const children = definitions.children ?? [];
    tx.setChildren(definitions, [...(children.includes(count) ? children : [count, ...children]), ...added]);
    tx.patch(count, (v) => v.setUint32(0, definitions.children!.filter((c) => c.listType === "EfDf").length, true), 4);
  } else {
    const count = leaf("EfDC", new Uint8Array(4));
    view(count).setUint32(0, added.length, true);
    const children = root.children ?? [];
    const at = children.indexOf(findList(root, "Pefl")!) + 1;
    tx.setChildren(root, [...children.slice(0, at), list("EfdG", [count, ...added]), ...children.slice(at)]);
  }
}

/** File > Import > File: an .aep becomes a named folder holding its original item hierarchy. One undo step. */
export function importProject(editor: Editor, source: Project, name: string, folderId = 0): FolderItem {
  const incoming = rootContainer(source);
  const folderBlock = templateBlock("FOLDER");
  const folder = folderBlock[0];
  const contents = findList(folder, "Sfdr");
  if (!contents) throw new Error("folder template has no item container");
  contents.children = (incoming.children ?? []).map(cloneChunk);
  const originalIds = new Set<number>();
  visit(contents, (c) => {
    if (c.type === "idta" && c.data.length >= 20) originalIds.add(view(c).getUint32(16));
    if (c.type === "ldta" && c.data.length >= 4) originalIds.add(view(c).getUint32(0));
  });
  originalIds.delete(0);
  let folderIdCreated = 0;
  editor.runProjectCommand("Import Project", (tx) => {
    const container = folderContainer(editor.project, folderId);
    const [id, ...allocated] = allocateIds(editor.project, tx, originalIds.size + 1);
    folderIdCreated = id;
    const ids = new Map([...originalIds].map((old, i) => [old, allocated[i]]));
    const remap = (c: Chunk, at: number, littleEndian = false) => {
      if (c.data.length < at + 4) return;
      const v = view(c);
      const next = ids.get(v.getUint32(at, littleEndian));
      if (next !== undefined) v.setUint32(at, next, littleEndian);
    };
    visit(contents, (c) => {
      if (c.type === "idta") remap(c, 16);
      else if (c.type === "iide") remap(c, 0, true);
      else if (c.type === "ldta") {
        for (const at of [0, 40, LDTA.parentId, LDTA.matteLayerId]) remap(c, at);
      } else if (["tdpi", "CCId", "CLId"].includes(c.type)) remap(c, 0);
    });
    const idta = findChild(folder, "idta");
    const iide = findChild(folder, "iide");
    const utf8 = findChild(folder, "Utf8");
    if (!idta || !iide || !utf8) throw new Error("folder template is incomplete");
    view(idta).setUint32(16, id);
    view(iide).setUint32(0, id, true);
    utf8.data = new TextEncoder().encode(name.split(/[\\/]/).pop()?.replace(/\.aep$/i, "") || "Imported Project");
    mergeEffects(tx, editor.file.root, source.file.root);
    insertBlocks(tx, container, folderBlock);
  });
  return editor.project.items.get(folderIdCreated) as FolderItem;
}
