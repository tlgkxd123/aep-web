import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { CompItem, FolderItem, Layer, Project, Property, PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { findChild, findList, type Chunk } from "../src/aep/riff.ts";
import { Editor } from "../src/edit/editor.ts";
import { addEffects, newInstance } from "../src/edit/effects.ts";
import { importProject } from "../src/edit/import-project.ts";
import { addLayer } from "../src/edit/layers.ts";
import { DEFAULT_COMP_SETTINGS, importFootage, newComposition, newFolder, newProject } from "../src/edit/project.ts";
import { effectTemplates } from "../src/extra/pmatch/effectTemplates.ts";
import { transformProp } from "../src/edit/transform-ops.ts";
import { storedProperty } from "../src/edit/stored-property.ts";

const bytes = (path: string) => new Uint8Array(readFileSync(path));
const settings = (name: string) => ({ ...DEFAULT_COMP_SETTINGS, name, width: 160, height: 120, frameRate: 24, duration: 2 });
const layer = (comp: CompItem, id: number) => comp.layers.find((l) => l.id === id)!;
const effects = (l: Layer) => l.properties.find((p) => p.matchName === "ADBE Effect Parade") as PropertyGroup;
const parameter = (l: Layer, n: number) => (effects(l).children[0] as PropertyGroup).children.find((p) => p.matchName === `tc Particular-${String(n).padStart(4, "0")}`) as Property;
const descendants = (project: Project, folder: FolderItem) => [...project.items.values()].filter((item) => {
  for (let id = item.parentFolderId; id; id = project.items.get(id)?.parentFolderId ?? 0) if (id === folder.id) return true;
  return false;
});

async function sourceProject() {
  const source = newProject();
  const art = newFolder(source, 0, "Art");
  const inner = newComposition(source, settings("Inner"), art.id);
  const parentId = addLayer(source, inner, { kind: "null" });
  const solidId = addLayer(source, inner, { kind: "solid", name: "Red", color: [1, 0, 0], width: 32, height: 24 });
  const matteId = addLayer(source, inner, { kind: "solid", name: "Matte", color: [1, 1, 1], width: 160, height: 120 });
  source.setParent(inner, layer(inner, solidId), parentId);
  source.setTrackMatte(inner, layer(inner, solidId), 5013, matteId);
  const solid = () => layer(inner, solidId);
  const stored = (match: string) => storedProperty(source, inner, solid(), transformProp(solid(), match)!).prop;
  source.addKeyframe(inner, solid(), stored("ADBE Opacity"), 0);
  source.setValue(inner, solid(), transformProp(solid(), "ADBE Opacity")!, 25, 1);
  source.setExpression(inner, solid(), stored("ADBE Rotate Z"), "time * 10");
  const template = (await effectTemplates()).get("tc Particular")!;
  addEffects(source, inner, solidId, [{ template, instance: newInstance(template) }]);
  source.setLayerReference(inner, solid(), parameter(solid(), 66), layer(inner, matteId));
  const outer = newComposition(source, settings("Outer"));
  addLayer(source, outer, { kind: "item", itemId: inner.id });
  importFootage(source, [{ path: "C:/original/assets/image.png", info: { kind: "png", format: "png!", width: 32, height: 24, hasAlpha: true, frameRate: 0, duration: 0 } }], art.id);
  return source;
}

function allIds(project: Project): number[] {
  const ids = [...project.items.keys()];
  const walk = (c: Chunk) => {
    if (c.type === "ldta") ids.push(new DataView(c.data.buffer, c.data.byteOffset).getUint32(0));
    for (const child of c.children ?? []) walk(child);
  };
  for (const item of project.items.values()) if (item.kind === "comp" && item.chunk) walk(item.chunk);
  return ids;
}

describe("native project import", () => {
  test("copies the full hierarchy with fresh IDs, nested comps, solids, parents, mattes, effects and animation", async () => {
    const source = await sourceProject();
    const beforeSource = source.save();
    const target = newProject();
    const host = newComposition(target, settings("Host"));
    const hostChunk = host.chunk;
    const folder = importProject(target, source.project, "Native.aep");
    expect(folder.name).toBe("Native");
    expect(descendants(target.project, folder)).toHaveLength(source.project.items.size);
    expect(target.project.items.get(host.id)?.chunk).toBe(hostChunk);
    expect(source.save()).toEqual(beforeSource);
    expect(new Set(allIds(target.project)).size).toBe(allIds(target.project).length);
    const reopen = parseProject(target.save());
    const imported = descendants(reopen, reopen.items.get(folder.id) as FolderItem);
    const inner = imported.find((i): i is CompItem => i.kind === "comp" && i.name === "Inner")!;
    const outer = imported.find((i): i is CompItem => i.kind === "comp" && i.name === "Outer")!;
    expect(outer.layers[0].sourceId).toBe(inner.id);
    expect(inner.parentFolderId).toBe(imported.find((i) => i.name === "Art")!.id);
    const red = inner.layers.find((l) => l.name === "Red")!;
    const originalInner = [...source.project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === "Inner")!;
    const originalRed = originalInner.layers.find((l) => l.name === "Red")!;
    expect(red.id).not.toBe(originalRed.id);
    expect(inner.layers.find((l) => l.id === red.parentId)?.nullLayer).toBe(true);
    expect(inner.layers.find((l) => l.id === red.trackMatteLayerId)?.name).toBe("Matte");
    expect(parameter(red, 66).value).toBe(inner.layers.find((l) => l.name === "Matte")!.index);
    expect(parameter(red, 26).options?.length).toBeGreaterThan(0);
    expect(transformProp(red, "ADBE Opacity")?.keyframes).toEqual(transformProp(originalRed, "ADBE Opacity")?.keyframes);
    expect(transformProp(red, "ADBE Rotate Z")?.expression).toBe("time * 10");
    const solid = reopen.items.get(red.sourceId);
    expect(solid?.kind === "footage" && solid.mainSource.sourceType === "SolidSource" && solid.mainSource.color).toEqual([1, 0, 0]);
    expect(imported.find((i) => i.kind === "footage" && i.mainSource.sourceType === "FileSource")?.name).toBe("image.png");
    expect(reopen.bitsPerChannel).toBe(target.project.bitsPerChannel);
    expect(reopen.expressionEngine).toBe(target.project.expressionEngine);
  });

  test("repeated imports are independent, register each effect once, and undo byte for byte", async () => {
    const source = await sourceProject();
    const target = newProject();
    const destination = newFolder(target, 0, "Destination");
    const original = target.save();
    const a = importProject(target, source.project, "Native.aep", destination.id);
    const first = target.save();
    const b = importProject(target, source.project, "Native.aep", destination.id);
    expect(a.id).not.toBe(b.id);
    expect(b.parentFolderId).toBe(destination.id);
    const idsA = new Set(descendants(target.project, a).map((i) => i.id));
    expect(descendants(target.project, b).every((i) => !idsA.has(i.id))).toBe(true);
    expect(new Set(allIds(target.project)).size).toBe(allIds(target.project).length);
    const defs = findList(target.file.root, "EfdG")!.children!.filter((c) => c.listType === "EfDf");
    expect(defs).toHaveLength(1);
    expect(findChild(findList(target.file.root, "EfdG"), "EfDC")?.data).toEqual(new Uint8Array([1, 0, 0, 0]));
    target.undo();
    expect(target.save()).toEqual(first);
    target.undo();
    expect(target.save()).toEqual(original);
    target.redo();
    expect(target.save()).toEqual(first);
  });

  test("imports actual corpus projects without changing their bytes or losing item/layer references", () => {
    const target = newProject();
    for (const path of ["refs/fixtures/fixtures.aep", "refs/fixtures/footage.aep"]) {
      const source = Editor.fromBytes(bytes(path));
      const original = source.save();
      const folder = importProject(target, source.project, path);
      const imported = descendants(target.project, folder);
      expect(imported).toHaveLength(source.project.items.size);
      for (const comp of imported.filter((i): i is CompItem => i.kind === "comp")) {
        for (const l of comp.layers) {
          if (l.sourceId) expect(target.project.items.has(l.sourceId), `${comp.name}/${l.name}`).toBe(true);
          if (l.parentId) expect(comp.layers.some((p) => p.id === l.parentId)).toBe(true);
        }
      }
      expect(source.save()).toEqual(original);
    }
    const reopened = parseProject(target.save());
    expect(reopened.items.size).toBe(target.project.items.size);
    expect(new Set(allIds(reopened)).size).toBe(allIds(reopened).length);
  });

  test("an invalid destination changes nothing", () => {
    const target = newProject();
    const before = target.save();
    expect(() => importProject(target, newProject().project, "Empty.aep", 99999)).toThrow(/not a folder/);
    expect(target.save()).toEqual(before);
    expect(target.undoLabel).toBeUndefined();
  });
});
