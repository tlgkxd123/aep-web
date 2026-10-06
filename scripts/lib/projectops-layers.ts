// Fixture tooling for the projectops suite: puts solid and footage layers into
// compositions built by the project operations, from the py-aep-authored layer
// and solid templates (src/edit/data/project-templates.json). Adding layers is
// the app's layer operations' job; this only exists so the AE acceptance
// fixtures can be authored end to end through the editor.
import type { CompItem, FootageItem, Item, Layer } from "../../src/aep/model.ts";
import { findChild, findList, type Chunk } from "../../src/aep/riff.ts";
import { decodeCdta } from "../../src/aep/decode.ts";
import type { Editor } from "../../src/edit/editor.ts";
import { LDTA, setRatio, stampTimeBase } from "../../src/edit/encode.ts";
import { allocateIds, folderContainer, insertBlocks } from "../../src/edit/items.ts";
import { newFolder, renameItem } from "../../src/edit/project.ts";
import { templateBlock } from "../../src/edit/templates.ts";

const view = (c: Chunk) => new DataView(c.data.buffer, c.data.byteOffset, c.data.byteLength);

function propertyTdbs(group: Chunk | undefined, matchName: string): Chunk | undefined {
  const children = group?.children ?? [];
  for (let i = 0; i < children.length - 1; i++) {
    if (children[i].type === "tdmn" && new TextDecoder().decode(children[i].data).replace(/\0.*$/s, "") === matchName) return children[i + 1];
  }
  return undefined;
}

/** Writes a static point; the template leaves Anchor Point and Position out, which AE reads as source and comp center. */
function setPoint(tdbs: Chunk | undefined, point: number[]): void {
  const cdat = findChild(tdbs, "cdat");
  if (cdat) point.forEach((v, i) => view(cdat).setFloat64(i * 8, v));
}

/** The first layer block of the LAYERS template: `LIST:Layr` and the view data after it. */
function layerTemplate(): Chunk[] {
  const children = templateBlock("LAYERS")[0].children ?? [];
  const start = children.findIndex((c) => c.type === "LIST" && c.listType === "Layr");
  let end = start + 1;
  while (end < children.length && !(children[end].type === "LIST" && /^(Layr|DLay)$/.test(children[end].listType ?? ""))) end++;
  return children.slice(start, end);
}

/** Adds an AV layer for `source` at the top of `comp`, centered, spanning the composition. */
export function addLayer(editor: Editor, comp: CompItem, source: FootageItem | CompItem): Layer {
  const before = new Set(comp.layers.map((l) => l.id));
  editor.runProjectCommand("New Layer", (tx) => {
    const block = layerTemplate();
    const layr = block[0];
    const cdta = decodeCdta(findChild(comp.chunk, "cdta")!);
    const [id] = allocateIds(editor.project, tx, 1);
    const ldta = findChild(layr, "ldta")!;
    const lv = view(ldta);
    lv.setUint32(0, id);
    lv.setUint32(40, source.id);
    setRatio(lv, LDTA.startTime, 0);
    setRatio(lv, LDTA.inPoint, 0);
    setRatio(lv, LDTA.outPoint, source.kind === "footage" && source.duration > 0 ? Math.min(source.duration, comp.duration) : comp.duration);
    ldta.data[61] = source.label;
    const visit = (chunk: Chunk) => {
      for (const c of chunk.children ?? []) {
        if (c.type === "tdb4" && view(c).getUint32(12)) stampTimeBase(c.data, cdta.internalTimebase, comp.pixelAspect);
        if (c.children) visit(c);
      }
    };
    visit(layr);
    const transform = propertyTdbs(findList(layr, "tdgp"), "ADBE Transform Group");
    setPoint(propertyTdbs(transform, "ADBE Anchor Point"), [source.width / 2, source.height / 2, 0]);
    setPoint(propertyTdbs(transform, "ADBE Position"), [comp.width / 2, comp.height / 2, 0]);
    const children = comp.chunk!.children!;
    const at = children.findIndex((c) => c.type === "LIST" && (c.listType === "Layr" || c.listType === "DLay"));
    tx.setChildren(comp.chunk!, [...children.slice(0, at), ...block, ...children.slice(at)]);
  });
  const layer = comp.layers.find((l) => !before.has(l.id));
  if (!layer) throw new Error("the layer was not added");
  return layer;
}

function solidsFolder(editor: Editor): number {
  const existing = [...editor.project.items.values()].find((i: Item) => i.kind === "folder" && i.name === "Solids");
  if (existing) return existing.id;
  const folder = newFolder(editor);
  renameItem(editor, folder, "Solids");
  return folder.id;
}

/** Layer > New > Solid: a solid footage item in the Solids folder and a layer for it. */
export function addSolid(editor: Editor, comp: CompItem, name: string, color: [number, number, number], size = [comp.width, comp.height]): Layer {
  const folderId = solidsFolder(editor);
  let id = 0;
  editor.runProjectCommand("New Solid", (tx) => {
    const sfdr = findList(templateBlock("SOLIDS")[0], "Sfdr")!;
    const block = sfdr.children!;
    const item = block[0];
    [id] = allocateIds(editor.project, tx, 1);
    view(findChild(item, "iide")!).setUint32(0, id, true);
    view(findChild(item, "idta")!).setUint32(16, id);
    const pin = findList(item, "Pin ")!;
    const sspc = findChild(pin, "sspc")!;
    view(sspc).setUint16(32, size[0]);
    view(sspc).setUint16(36, size[1]);
    const opti = findChild(pin, "opti")!;
    const ov = view(opti);
    ov.setFloat32(10, 1);
    color.forEach((c, i) => ov.setFloat32(14 + i * 4, c));
    opti.data.fill(0, 26);
    opti.data.set(new TextEncoder().encode(name), 26);
    crypto.getRandomValues(findChild(pin, "pgui")!.data);
    insertBlocks(tx, folderContainer(editor.project, folderId), block);
  });
  const solid = editor.project.items.get(id) as FootageItem;
  return addLayer(editor, editor.project.items.get(comp.id) as CompItem, solid);
}
