import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { CompItem, FootageItem, Item, Project } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { findChild, findList } from "../src/aep/riff.ts";
import { Editor } from "../src/edit/editor.ts";
import {
  DEFAULT_COMP_SETTINGS,
  deleteItems,
  duplicateComp,
  importFootage,
  itemUsage,
  moveItems,
  newComposition,
  newFolder,
  newProject,
  renameItem,
  replaceFootage,
  type CompSettings,
} from "../src/edit/project.ts";
import { probeMedia } from "../src/media/probe.ts";

const refs = resolve("refs");
const mediaPath = (name: string) => join(refs, "media", name);
const mediaBlob = (name: string) => new Blob([readFileSync(mediaPath(name))]);

async function footageFile(name: string, path = mediaPath(name)) {
  return { path, info: await probeMedia(mediaBlob(name), name) };
}

const reparse = (editor: Editor) => parseProject(editor.save());
const byName = (project: Project, name: string) => [...project.items.values()].find((i) => i.name === name);
const names = (items: Item[]) => items.map((i) => i.name);

function ldtaIds(project: Project): number[] {
  const ids: number[] = [];
  const visit = (chunk: { type: string; data: Uint8Array; children?: unknown[] }) => {
    for (const c of (chunk.children ?? []) as (typeof chunk)[]) {
      if (c.type === "ldta") ids.push(new DataView(c.data.buffer, c.data.byteOffset).getUint32(0));
      else visit(c);
    }
  };
  for (const item of project.items.values()) if (item.kind === "comp" && item.chunk) visit(item.chunk);
  return ids;
}

function headCounter(project: Project): number {
  const head = findChild(project.file.root, "head")!;
  return new DataView(head.data.buffer, head.data.byteOffset).getUint32(12);
}

const settings = (patch: Partial<CompSettings> = {}): CompSettings => ({ ...DEFAULT_COMP_SETTINGS, ...patch });

describe("new project", () => {
  test("is an empty 8 bpc project with no XMP history that parses back", () => {
    const editor = newProject();
    expect(editor.project.items.size).toBe(0);
    expect(editor.project.bitsPerChannel).toBe(8);
    expect(editor.dirty).toBe(false);
    const bytes = editor.save();
    expect(editor.file.trailer.length).toBe(0);
    expect(parseProject(bytes).items.size).toBe(0);
  });

  test("starts with a fresh copy of the template every time", () => {
    const a = newProject();
    newFolder(a);
    expect(newProject().project.items.size).toBe(0);
  });
});

describe("new composition", () => {
  test("writes the Composition Settings into cdta and survives a write and re-parse", () => {
    const editor = newProject();
    const comp = newComposition(
      editor,
      settings({ name: "Main", width: 640, height: 360, pixelAspect: 10 / 11, frameRate: 25, duration: 4, bgColor: [1, 0.5, 0], resolutionFactor: [2, 2], displayStartTime: 2 }),
    );
    expect(comp.name).toBe("Main");
    expect(editor.dirty).toBe(true);
    expect(editor.undoLabel).toBe("New Composition");
    const parsed = byName(reparse(editor), "Main") as CompItem;
    expect(parsed.kind).toBe("comp");
    expect([parsed.width, parsed.height, parsed.frameRate, parsed.duration]).toEqual([640, 360, 25, 4]);
    expect(parsed.pixelAspect).toBeCloseTo(10 / 11, 9);
    expect(parsed.bgColor.map((c) => Math.round(c * 255))).toEqual([255, 128, 0]);
    expect(parsed.resolutionFactor).toEqual([2, 2]);
    expect(parsed.displayStartTime).toBeCloseTo(2, 9);
    expect(parsed.layers).toEqual([]);
  });

  test("rounds the duration to whole frames and handles drop-frame rates", () => {
    const editor = newProject();
    const comp = newComposition(editor, settings({ frameRate: 30000 / 1001, duration: 10 }));
    expect(comp.frameRate).toBeCloseTo(29.97, 2);
    expect(Math.round(comp.duration * comp.frameRate)).toBe(300);
  });

  test("draws the item and viewer-layer ids from the head counter", () => {
    const editor = newProject();
    const before = headCounter(editor.project);
    const a = newComposition(editor, settings({ name: "A" }));
    const b = newComposition(editor, settings({ name: "B" }));
    const ids = [a.id, b.id, ...ldtaIds(editor.project)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(before);
    expect(headCounter(editor.project)).toBe(Math.max(...ids) + 1);
  });

  test("rejects settings AE's dialog does not accept", () => {
    const editor = newProject();
    expect(() => newComposition(editor, settings({ width: 2 }))).toThrow(/Width/);
    expect(() => newComposition(editor, settings({ duration: 0 }))).toThrow(/Duration/);
    expect(editor.project.items.size).toBe(0);
    expect(editor.dirty).toBe(false);
  });

  test("undo removes it, redo brings back the same object", () => {
    const editor = newProject();
    const comp = newComposition(editor, settings());
    editor.undo();
    expect(editor.project.items.size).toBe(0);
    expect(editor.project.rootFolder.items).toEqual([]);
    expect(editor.dirty).toBe(false);
    editor.redo();
    expect(editor.project.items.get(comp.id)).toBe(comp);
    expect(editor.project.rootFolder.items).toEqual([comp]);
  });

  test("goes into the given folder", () => {
    const editor = newProject();
    const folder = newFolder(editor);
    const comp = newComposition(editor, settings(), folder.id);
    expect(comp.parentFolderId).toBe(folder.id);
    const parsed = reparse(editor);
    const parsedFolder = parsed.items.get(folder.id)!;
    expect(parsedFolder.kind === "folder" && names(parsedFolder.items)).toEqual(["Comp 1"]);
  });

  test("composition settings edit pixel aspect, resolution and start timecode", () => {
    const editor = newProject();
    const comp = newComposition(editor, settings({ name: "C" }));
    editor.setCompSettings(comp, { pixelAspect: 2, resolutionFactor: [4, 4], displayStartTime: 1, name: "D" });
    const parsed = byName(reparse(editor), "D") as CompItem;
    expect(parsed.pixelAspect).toBe(2);
    expect(parsed.resolutionFactor).toEqual([4, 4]);
    expect(parsed.displayStartTime).toBeCloseTo(1, 9);
  });
});

describe("folders, rename and move", () => {
  test("new folders are numbered Untitled 1, Untitled 2", () => {
    const editor = newProject();
    newFolder(editor);
    newFolder(editor);
    expect(names(editor.project.rootFolder.items)).toEqual(["Untitled 1", "Untitled 2"]);
    expect(names(reparse(editor).rootFolder.items)).toEqual(["Untitled 1", "Untitled 2"]);
  });

  test("rename writes the item name and undoes", () => {
    const editor = newProject();
    const folder = newFolder(editor);
    renameItem(editor, folder, "Renders");
    expect(folder.name).toBe("Renders");
    expect(names(reparse(editor).rootFolder.items)).toEqual(["Renders"]);
    editor.undo();
    expect(folder.name).toBe("Untitled 1");
  });

  test("an empty name is ignored except on footage, which falls back to its file name", async () => {
    const editor = newProject();
    const comp = newComposition(editor, settings({ name: "Keep" }));
    renameItem(editor, comp, "  ");
    expect(comp.name).toBe("Keep");
    const [png] = importFootage(editor, [await footageFile("straight.png")]);
    renameItem(editor, png, "Logo");
    expect(editor.project.items.get(png.id)!.name).toBe("Logo");
    renameItem(editor, editor.project.items.get(png.id)!, "");
    expect(editor.project.items.get(png.id)!.name).toBe("straight.png");
  });

  test("moves items into folders, out to the root and keeps folder contents", () => {
    const editor = newProject();
    const a = newFolder(editor);
    const b = newFolder(editor);
    const comp = newComposition(editor, settings());
    moveItems(editor, [comp], a.id);
    moveItems(editor, [a], b.id);
    let parsed = reparse(editor);
    expect(names(parsed.rootFolder.items)).toEqual(["Untitled 2"]);
    const inner = parsed.items.get(a.id)!;
    expect(inner.parentFolderId).toBe(b.id);
    expect(inner.kind === "folder" && names(inner.items)).toEqual(["Comp 1"]);
    moveItems(editor, [comp], 0);
    parsed = reparse(editor);
    expect(names(parsed.rootFolder.items)).toEqual(["Untitled 2", "Comp 1"]);
    editor.undo();
    expect(editor.project.items.get(comp.id)!.parentFolderId).toBe(a.id);
  });

  test("a folder cannot move into itself or its subfolders", () => {
    const editor = newProject();
    const a = newFolder(editor);
    const b = newFolder(editor, a.id);
    expect(() => moveItems(editor, [a], b.id)).toThrow(/into itself/);
    expect(() => moveItems(editor, [a], a.id)).toThrow(/into itself/);
  });
});

describe("import and replace footage", () => {
  test.each([
    ["straight.png", 96, 72, true, 0, 0, "png!"],
    ["photo.jpg", 96, 72, false, 0, 0, "ZPEG"],
    ["clip.mp4", 96, 64, false, 1, 30, "XCEX"],
    ["alpha.tif", 0, 0, true, 0, 0, "TIF "],
    ["still.bmp", 0, 0, true, 0, 0, "STIL"],
  ] as const)("%s imports with the size, timing and alpha AE caches", async (name, width, height, alpha, duration, fps, format) => {
    const file = await footageFile(name);
    expect(file.info.format).toBe(format);
    const editor = newProject();
    const [item] = importFootage(editor, [file]);
    const parsed = reparse(editor).items.get(item.id) as FootageItem;
    expect(parsed.kind).toBe("footage");
    expect(parsed.name).toBe(name);
    if (width) expect([parsed.width, parsed.height]).toEqual([width, height]);
    else expect(parsed.width).toBeGreaterThan(0);
    expect(parsed.duration).toBeCloseTo(duration, 6);
    expect(parsed.frameRate).toBeCloseTo(fps || parsed.frameRate, 6);
    expect(parsed.hasVideo).toBe(true);
    const source = parsed.mainSource;
    expect(source.sourceType).toBe("FileSource");
    if (source.sourceType !== "FileSource") return;
    expect(source.file).toBe(mediaPath(name));
    expect(source.isStill).toBe(duration === 0);
    expect(source.hasAlpha).toBe(alpha);
    expect(parsed.label).toBe(duration === 0 ? 5 : 3);
  });

  test("a footage file without a known path records its file name", async () => {
    const editor = newProject();
    const [item] = importFootage(editor, [await footageFile("straight.png", "straight.png")]);
    const source = (reparse(editor).items.get(item.id) as FootageItem).mainSource;
    expect(source.sourceType === "FileSource" && source.file).toBe("straight.png");
  });

  test("each import gets its own pgui and the item name stays empty in the file", async () => {
    const editor = newProject();
    const [a, b] = importFootage(editor, [await footageFile("straight.png"), await footageFile("photo.jpg")]);
    const pgui = (item: Item) => [...findChild(findList(item.chunk, "Pin "), "pgui")!.data].join();
    expect(pgui(a)).not.toBe(pgui(b));
    expect(findChild(a.chunk, "Utf8")!.data.length).toBe(0);
    editor.undo();
    expect(editor.project.items.size).toBe(0);
  });

  test("replace repoints the item, keeps its id, name and interpretation choices", async () => {
    const editor = newProject();
    const [item] = importFootage(editor, [await footageFile("straight.png")]);
    renameItem(editor, item, "Logo");
    const loop = findChild(findList(editor.project.items.get(item.id)!.chunk, "Pin "), "sspc")!;
    loop.data = loop.data.slice();
    new DataView(loop.data.buffer).setUint32(126, 3);
    const replaced = replaceFootage(editor, editor.project.items.get(item.id) as FootageItem, await footageFile("clip.mp4"));
    expect(replaced).not.toBe(item);
    expect(replaced.id).toBe(item.id);
    const parsed = reparse(editor).items.get(item.id) as FootageItem;
    expect(parsed.name).toBe("Logo");
    expect([parsed.width, parsed.height, parsed.frameRate]).toEqual([96, 64, 30]);
    expect(parsed.duration).toBeCloseTo(3, 9);
    expect(parsed.mainSource.sourceType === "FileSource" && parsed.mainSource.file).toBe(mediaPath("clip.mp4"));
    expect(parsed.mainSource.loop).toBe(3);
    editor.undo();
    const back = editor.project.items.get(item.id) as FootageItem;
    expect(back.mainSource.sourceType === "FileSource" && back.mainSource.file).toBe(mediaPath("straight.png"));
  });
});

describe("delete and duplicate", () => {
  const fixture = () => Editor.fromBytes(new Uint8Array(readFileSync(join(refs, "fixtures", "footage.aep"))));

  function usedFootage(project: Project): { footage: FootageItem; comp: CompItem } {
    for (const comp of project.items.values()) {
      if (comp.kind !== "comp") continue;
      for (const layer of comp.layers) {
        const source = project.items.get(layer.sourceId);
        if (source?.kind === "footage" && source.mainSource.sourceType === "FileSource") return { footage: source, comp };
      }
    }
    throw new Error("fixture has no footage layer");
  }

  test("deleting footage used in compositions removes its layers; undo restores them", () => {
    const editor = fixture();
    const { footage, comp } = usedFootage(editor.project);
    const usage = itemUsage(editor.project, [footage]);
    expect(usage.layers.length).toBeGreaterThan(0);
    const layerCount = comp.layers.length;
    const using = comp.layers.filter((l) => l.sourceId === footage.id).length;
    deleteItems(editor, [footage]);
    expect(editor.project.items.has(footage.id)).toBe(false);
    expect(comp.layers.length).toBe(layerCount - using);
    const parsed = reparse(editor);
    expect(parsed.items.has(footage.id)).toBe(false);
    expect((parsed.items.get(comp.id) as CompItem).layers.length).toBe(layerCount - using);
    for (const c of parsed.items.values()) if (c.kind === "comp") for (const l of c.layers) expect(l.sourceId).not.toBe(footage.id);
    editor.undo();
    expect(editor.project.items.get(footage.id)).toBe(footage);
    expect(comp.layers.length).toBe(layerCount);
  });

  test("deleting a folder deletes what is inside it", () => {
    const editor = newProject();
    const folder = newFolder(editor);
    newComposition(editor, settings(), folder.id);
    deleteItems(editor, [folder]);
    expect(editor.project.items.size).toBe(0);
    expect(reparse(editor).items.size).toBe(0);
  });

  test("duplicating a composition copies its layers with fresh ids and the next name", () => {
    const editor = fixture();
    const { comp } = usedFootage(editor.project);
    const copy = duplicateComp(editor, comp);
    expect(copy.id).not.toBe(comp.id);
    expect(copy.parentFolderId).toBe(comp.parentFolderId);
    expect(copy.layers.map((l) => l.name)).toEqual(comp.layers.map((l) => l.name));
    const originalIds = new Set(comp.layers.map((l) => l.id));
    for (const layer of copy.layers) {
      expect(originalIds.has(layer.id)).toBe(false);
      if (layer.parentId) expect(copy.layers.some((l) => l.id === layer.parentId)).toBe(true);
    }
    const ids = ldtaIds(editor.project);
    expect(new Set(ids).size).toBe(ids.length);
    const parsed = reparse(editor);
    const parsedCopy = parsed.items.get(copy.id) as CompItem;
    expect(parsedCopy.name).toBe(copy.name);
    expect(parsedCopy.layers.length).toBe(comp.layers.length);
    const siblings = comp.parentFolderId ? (parsed.items.get(comp.parentFolderId) as { items: Item[] }).items : parsed.rootFolder.items;
    expect(siblings.findIndex((i) => i.id === copy.id)).toBe(siblings.findIndex((i) => i.id === comp.id) + 1);
  });

  test("duplicate names count up the trailing number", () => {
    const editor = newProject();
    const comp = newComposition(editor, settings({ name: "Comp 1" }));
    expect(duplicateComp(editor, comp).name).toBe("Comp 2");
    expect(duplicateComp(editor, comp).name).toBe("Comp 3");
    const plain = newComposition(editor, settings({ name: "Title" }));
    expect(duplicateComp(editor, plain).name).toBe("Title 2");
  });
});
