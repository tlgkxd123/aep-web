// The project's item tree (folders, footage, compositions) re-read from its
// chunks after a command added or removed items, and the project-wide id
// counter new items and layers draw from.
import { commentOf, decodeIdta, decodeLdta, utf8Of } from "../aep/decode.ts";
import { parseFootageItem } from "../aep/footage.ts";
import type { FolderItem, Item, Project } from "../aep/model.ts";
import { projectFromRifx } from "../aep/parse.ts";
import { filterLists, findChild, findList, type Chunk } from "../aep/riff.ts";
import type { Transaction } from "./chunks.ts";

/**
 * Brings `project.items` and the folders' item lists in line with the chunk
 * tree. Items whose chunks are unchanged keep their model objects; new
 * folders and footage are parsed on their own, a new composition by
 * re-reading the project.
 */
export function syncItems(project: Project): void {
  const root = project.rootFolder.chunk;
  if (!root) return;
  const seen = new Map<number, Item>();
  let fresh: Project | undefined;
  const warnings: string[] = [];
  const visit = (list: Chunk, folder: FolderItem) => {
    const items: Item[] = [];
    for (const itemList of filterLists(list, "Item")) {
      const idtaChunk = findChild(itemList, "idta");
      if (!idtaChunk) continue;
      const idta = decodeIdta(idtaChunk);
      let item = project.items.get(idta.id);
      if (!item || item.chunk !== itemList) {
        const base = {
          id: idta.id,
          name: utf8Of(findChild(itemList, "Utf8")),
          comment: commentOf(findChild(itemList, "cmta")),
          label: idta.label,
          parentFolderId: folder.id,
          chunk: itemList,
        };
        if (idta.itemType === 1) item = { ...base, kind: "folder", typeName: "Folder", items: [] };
        else if (idta.itemType === 7) item = parseFootageItem(itemList, base, warnings);
        else {
          fresh ??= projectFromRifx(project.file);
          item = fresh.items.get(idta.id);
        }
      }
      if (!item) continue;
      item.parentFolderId = folder.id;
      seen.set(item.id, item);
      items.push(item);
      if (item.kind === "folder") visit(findList(itemList, "Sfdr") ?? itemList, item);
    }
    folder.items = items;
  };
  visit(root, project.rootFolder);
  for (const id of [...project.items.keys()]) if (!seen.has(id)) project.items.delete(id);
  for (const [id, item] of seen) project.items.set(id, item);
}

const HEAD_NEXT_ID = 12;

/**
 * The next id from the project-wide counter AE keeps in `head` for items and
 * layers. AE trusts the counter on open, so it is first raised above every
 * live id.
 */
export function allocateId(tx: Transaction, project: Project): number {
  const head = findChild(project.file.root, "head");
  if (!head || head.data.length < HEAD_NEXT_ID + 4) throw new Error("project has no head chunk");
  let floor = 1;
  for (const item of project.items.values()) {
    floor = Math.max(floor, item.id + 1);
    if (item.kind !== "comp" || !item.chunk) continue;
    for (const layer of filterLists(item.chunk, "Layr")) {
      const ldta = findChild(layer, "ldta");
      if (ldta) floor = Math.max(floor, decodeLdta(ldta).id + 1);
    }
  }
  const view = new DataView(head.data.buffer, head.data.byteOffset, head.data.byteLength);
  const id = Math.max(view.getUint32(HEAD_NEXT_ID), floor);
  tx.patch(head, (v) => v.setUint32(HEAD_NEXT_ID, id + 1));
  return id;
}
