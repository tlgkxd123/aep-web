// Layer commands: new-layer blocks against py-aep's output byte for byte,
// then every operation and its undo/redo on a real project.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CompItem, Layer } from "../src/aep/model.ts";
import { projectFromRifx } from "../src/aep/parse.ts";
import { findChild, findList, readRifx, type Chunk } from "../src/aep/riff.ts";
import { sourcePointToComp } from "../src/aep/transform.ts";
import { Editor } from "../src/edit/editor.ts";
import {
  addLayer,
  arrangeLayer,
  autoName,
  buildLayerBlock,
  buildSolidItem,
  chunkBytes,
  chunksFromBytes,
  deleteLayers,
  duplicateLayers,
  solidColorName,
} from "../src/edit/layers.ts";
import {
  anchorInComp,
  centerAnchorPoint,
  centerInView,
  fitToComp,
  flipLayers,
  moveLayers,
  nudgeLayers,
  panBehind,
  resetTransform,
  rotateByDrag,
  scaleByHandle,
  transformProp,
  writeTransform,
} from "../src/edit/transform-ops.ts";

interface Case {
  kind: "solid" | "null" | "shape" | "comp";
  comp: { width: number; height: number; pixelAspect: number; duration: number; frameRate: number; internalTimebase: number };
  layerId: number;
  sourceId: number;
  label: number;
  layerName: string;
  layer: string[];
  solid?: { color: [number, number, number]; name: string; width: number; height: number; pixelAspect: number };
  sourceName?: string;
  item?: string[];
  source?: { width: number; height: number; duration: number };
}

const cases: Case[] = JSON.parse(readFileSync(new URL("./data/layer-templates-cases.json", import.meta.url), "utf8"));
const decode = (list: string[]) => chunksFromBytes(list.map((s) => Uint8Array.from(Buffer.from(s, "base64"))));
const hex = (chunks: Chunk[]) => chunkBytes(chunks).map((b) => Buffer.from(b).toString("hex"));

describe("new layer blocks match py-aep", () => {
  cases.forEach((c, i) => {
    it(`case ${i}: ${c.kind} in ${c.comp.width}x${c.comp.height} @ ${c.comp.frameRate}`, () => {
      const block = buildLayerBlock(c.kind === "shape" ? "shape" : "av", {
        id: c.layerId,
        sourceId: c.sourceId,
        label: c.label,
        name: c.kind === "shape" ? c.layerName : "",
        startTime: 0,
        duration: c.kind === "comp" ? c.source!.duration : c.comp.duration,
        timebase: c.comp.internalTimebase,
        nullLayer: c.kind === "null",
      });
      expect(hex(block)).toEqual(hex(decode(c.layer)));
      if (!c.item) return;
      const expected = decode(c.item);
      const guid = findChild(findList(expected[0], "Pin "), "pgui")!.data;
      const solid = c.solid ?? { color: [0, 0, 0] as [number, number, number], name: c.sourceName!, width: 100, height: 100, pixelAspect: 1 };
      const item = buildSolidItem({ ...solid, id: c.sourceId, label: 1, guid }, c.kind === "null" ? "null" : "solid");
      expect(hex(item)).toEqual(hex(expected));
    });
  });
});

describe("naming", () => {
  it("numbers names the way AE does", () => {
    expect(autoName("Null", [])).toBe("Null 1");
    expect(autoName("Null", ["Null 1", "Null 4"])).toBe("Null 5");
    expect(autoName("Box", ["Box"])).toBe("Box 2");
    expect(autoName("Box 2", ["Box 2"])).toBe("Box 3");
  });

  it("names solids after their colour", () => {
    expect(solidColorName([1, 0, 0])).toBe("Red Solid");
    expect(solidColorName([0, 0, 0])).toBe("Black Solid");
    expect(solidColorName([1, 1, 1])).toBe("White Solid");
    expect(solidColorName([0.5, 0.5, 0.5])).toBe("Gray Solid");
    expect(solidColorName([0.2, 0.3, 0.4])).toBe("Medium Gray-Royal Blue Solid");
    expect(solidColorName([0.6, 0.3, 0])).toBe("Deep Orange Solid");
  });
});

// ---------------------------------------------------------------- operations

const FIXTURES = new URL("../refs/fixtures/fixtures.aep", import.meta.url);
const load = () => Editor.fromBytes(new Uint8Array(readFileSync(FIXTURES)));
const compNamed = (editor: Editor, name: string) =>
  [...editor.project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === name)!;
const layerNamed = (comp: CompItem, name: string) => comp.layers.find((l) => l.name === name)!;
const value = (layer: Layer, matchName: string) => transformProp(layer, matchName)!.value as number[];
const corners = (comp: CompItem, layer: Layer, t = 0) =>
  [
    [0, 0],
    [layer.width, 0],
    [layer.width, layer.height],
    [0, layer.height],
  ].map((p) => sourcePointToComp(layer, comp, p as [number, number], t));
/** The saved project, parsed again. */
const reopen = (editor: Editor) => projectFromRifx(readRifx(editor.save()));
const close = (a: number[], b: number[], digits = 6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe("new layers", () => {
  it("adds a solid, its footage item in the Solids folder, and undoes both", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    const before = comp.layers.length;
    const items = editor.project.items.size;
    const id = addLayer(editor, comp, { kind: "solid", color: [0.6, 0.3, 0], width: 40, height: 20 });
    const layer = comp.layers[0];
    expect(comp.layers.length).toBe(before + 1);
    expect(layer.id).toBe(id);
    expect(layer.name).toBe("Deep Orange Solid 1");
    expect([layer.width, layer.height]).toEqual([40, 20]);
    expect(value(layer, "ADBE Position").slice(0, 2)).toEqual([80, 60]);
    expect(value(layer, "ADBE Anchor Point").slice(0, 2)).toEqual([20, 10]);
    const solid = editor.project.items.get(layer.sourceId)!;
    expect(solid.kind).toBe("footage");
    const folder = editor.project.items.get(solid.parentFolderId)!;
    expect(folder.kind === "folder" && folder.items.includes(solid)).toBe(true);
    const saved = reopen(editor);
    const again = [...saved.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === "parent")!;
    expect(again.layers[0].name).toBe("Deep Orange Solid 1");
    expect(saved.items.get(layer.sourceId)?.name).toBe("Deep Orange Solid 1");
    editor.undo();
    expect(comp.layers.length).toBe(before);
    expect(editor.project.items.size).toBe(items);
    editor.redo();
    expect(comp.layers[0].name).toBe("Deep Orange Solid 1");
    expect(editor.project.items.size).toBeGreaterThan(items);
  });

  it("adds null, shape and adjustment layers above the selected layer", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    const child = layerNamed(comp, "child");
    addLayer(editor, comp, { kind: "null" }, { above: layerNamed(comp, "Null 1") });
    expect(comp.layers[1].name).toBe("Null 2");
    expect(comp.layers[1].nullLayer).toBe(true);
    expect(comp.layers[0].id).toBe(child.id);
    addLayer(editor, comp, { kind: "shape" });
    expect(comp.layers[0].layerType).toBe("ShapeLayer");
    expect(comp.layers[0].name).toBe("Shape Layer 1");
    expect(comp.layers[0].label).toBe(8);
    addLayer(editor, comp, { kind: "adjustment" });
    expect(comp.layers[0].adjustmentLayer).toBe(true);
    expect(comp.layers[0].name).toBe("Adjustment Layer 1");
    expect([comp.layers[0].width, comp.layers[0].height]).toEqual([comp.width, comp.height]);
    expect(comp.layers[0].label).toBe(5);
    const ids = comp.layers.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 0; i < 3; i++) editor.undo();
    expect(comp.layers.map((l) => l.name)).toEqual(["child", "Null 1", "bg"]);
  });

  it("adds a project item at the drop point and refuses a cycle", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    const inner = compNamed(editor, "precomp_inner");
    addLayer(editor, comp, { kind: "item", itemId: inner.id }, { position: [30, 40] });
    const layer = comp.layers[0];
    expect(layer.name).toBe("precomp_inner");
    expect(value(layer, "ADBE Position").slice(0, 2)).toEqual([30, 40]);
    expect(layer.outPoint).toBeCloseTo(inner.duration);
    expect(layer.label).toBe(inner.label);
    const outer = compNamed(editor, "precomp");
    expect(() => addLayer(editor, inner, { kind: "item", itemId: outer.id })).toThrow(/contain itself/);
    expect(() => addLayer(editor, inner, { kind: "item", itemId: inner.id })).toThrow(/contain itself/);
  });
});

describe("delete, duplicate, arrange", () => {
  it("deleting a parent unparents its children in place", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    const child = layerNamed(comp, "child");
    const nul = layerNamed(comp, "Null 1");
    editor.perform("setup", [comp], () => writeTransform(editor, comp, nul.id, { rotation: 30, scale: [150, 80, 100], position: [70, 50, 0] }, 0));
    const before = corners(comp, layerNamed(comp, "child"));
    deleteLayers(editor, comp, [layerNamed(comp, "Null 1")], 0);
    expect(comp.layers.map((l) => l.name)).toEqual(["child", "bg"]);
    expect(comp.layers[0].parentId).toBe(0);
    // A rotated, non-uniformly scaled parent shears the child, which unparented can only approximate.
    const after = corners(comp, comp.layers[0]);
    const centre = (c: number[][]) => [c.reduce((s, p) => s + p[0], 0) / 4, c.reduce((s, p) => s + p[1], 0) / 4];
    close(centre(after), centre(before));
    editor.undo();
    expect(comp.layers.map((l) => l.name)).toEqual(["child", "Null 1", "bg"]);
    expect(comp.layers[0].parentId).toBe(child.parentId);
  });

  it("deleting a uniformly scaled, rotated parent keeps the child exactly", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    const nul = layerNamed(comp, "Null 1");
    editor.perform("setup", [comp], () => writeTransform(editor, comp, nul.id, { rotation: -40, scale: [-120, 120, 100], position: [70, 50, 0] }, 0));
    const before = corners(comp, layerNamed(comp, "child"));
    deleteLayers(editor, comp, [layerNamed(comp, "Null 1")], 0);
    corners(comp, comp.layers[0]).forEach((p, i) => close(p, before[i]));
  });

  it("duplicates above the original with a fresh id and name", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    const [id] = duplicateLayers(editor, comp, [layerNamed(comp, "Null 1")]);
    // A layer named after its source keeps the name; one renamed by the user is numbered on.
    expect(comp.layers.map((l) => l.name)).toEqual(["child", "Null 1", "Null 1", "bg"]);
    expect(comp.layers[1].id).toBe(id);
    expect(comp.layers[1].nullLayer).toBe(true);
    editor.renameLayer(comp, layerNamed(comp, "child"), "Arm");
    duplicateLayers(editor, comp, [layerNamed(comp, "Arm")]);
    expect(comp.layers.map((l) => l.name).slice(0, 2)).toEqual(["Arm 2", "Arm"]);
    editor.undo();
    editor.undo();
    const saved = reopen(editor);
    const again = [...saved.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === "parent")!;
    expect(again.layers.map((l) => l.id)).toEqual(comp.layers.map((l) => l.id));
    editor.undo();
    expect(comp.layers.map((l) => l.name)).toEqual(["child", "Null 1", "bg"]);
  });

  it("arranges layers", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    addLayer(editor, comp, { kind: "shape" });
    const names = () => comp.layers.map((l) => l.name);
    expect(names()).toEqual(["Shape Layer 1", "child", "Null 1", "bg"]);
    arrangeLayer(editor, comp, layerNamed(comp, "Null 1"), "forward");
    expect(names()).toEqual(["Shape Layer 1", "Null 1", "child", "bg"]);
    arrangeLayer(editor, comp, layerNamed(comp, "Shape Layer 1"), "back");
    expect(names()).toEqual(["Null 1", "child", "bg", "Shape Layer 1"]);
    arrangeLayer(editor, comp, layerNamed(comp, "child"), "front");
    expect(names()).toEqual(["child", "Null 1", "bg", "Shape Layer 1"]);
    arrangeLayer(editor, comp, layerNamed(comp, "Null 1"), "backward");
    expect(names()).toEqual(["child", "bg", "Null 1", "Shape Layer 1"]);
    arrangeLayer(editor, comp, layerNamed(comp, "child"), "forward");
    expect(names()).toEqual(["child", "bg", "Null 1", "Shape Layer 1"]);
  });
});

describe("Layer > Transform", () => {
  it("fits to comp, comp width and comp height", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    const id = addLayer(editor, comp, { kind: "solid", color: [0, 0, 1], width: 40, height: 20 }, { position: [10, 10] });
    const layer = () => comp.layers.find((l) => l.id === id)!;
    fitToComp(editor, comp, [layer()], "both", 0);
    corners(comp, layer()).forEach((p, i) => close(p, [[0, 0], [160, 0], [160, 120], [0, 120]][i]));
    fitToComp(editor, comp, [layer()], "width", 0);
    close(value(layer(), "ADBE Scale").slice(0, 2), [400, 400]);
    corners(comp, layer()).forEach((p, i) => close(p, [[0, 20], [160, 20], [160, 100], [0, 100]][i]));
    fitToComp(editor, comp, [layer()], "height", 0);
    close(value(layer(), "ADBE Scale").slice(0, 2), [600, 600]);
    corners(comp, layer()).forEach((p, i) => close(p, [[-40, 0], [200, 0], [200, 120], [-40, 120]][i]));
  });

  it("fits a parented layer through its parent", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    const nul = layerNamed(comp, "Null 1");
    editor.perform("setup", [comp], () => {
      writeTransform(editor, comp, nul.id, { scale: [50, 200, 100], position: [20, 30, 0], rotation: 0 }, 0);
      writeTransform(editor, comp, layerNamed(comp, "child").id, { rotation: 0 }, 0);
    });
    fitToComp(editor, comp, [layerNamed(comp, "child")], "both", 0);
    corners(comp, layerNamed(comp, "child")).forEach((p, i) => close(p, [[0, 0], [160, 0], [160, 120], [0, 120]][i]));
  });

  it("centres in view, centres the anchor, flips and resets", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    const child = () => layerNamed(comp, "child");
    centerInView(editor, comp, [child()], 0);
    close(anchorInComp(comp, child(), 0), [80, 60]);
    editor.perform("setup", [comp], () => writeTransform(editor, comp, child().id, { anchor: [0, 0, 0], rotation: 30 }, 0));
    const before = corners(comp, child());
    centerAnchorPoint(editor, comp, [child()], 0);
    close(value(child(), "ADBE Anchor Point").slice(0, 2), [25, 15]);
    corners(comp, child()).forEach((p, i) => close(p, before[i]));
    const scale = value(child(), "ADBE Scale");
    flipLayers(editor, comp, [child()], "horizontal", 0);
    expect(value(child(), "ADBE Scale")[0]).toBeCloseTo(-scale[0]);
    flipLayers(editor, comp, [child()], "vertical", 0);
    expect(value(child(), "ADBE Scale")[1]).toBeCloseTo(-scale[1]);
    resetTransform(editor, comp, [child()], 0);
    close(value(child(), "ADBE Scale"), [100, 100, 100]);
    expect(transformProp(child(), "ADBE Rotate Z")!.value).toBe(0);
    close(value(child(), "ADBE Anchor Point").slice(0, 2), [25, 15]);
    close(value(child(), "ADBE Position").slice(0, 2), [80, 60]);
  });
});

describe("direct manipulation", () => {
  const setupParent = (editor: Editor, comp: CompItem) =>
    editor.perform("setup", [comp], () =>
      writeTransform(editor, comp, layerNamed(comp, "Null 1").id, { rotation: 90, scale: [200, 50, 100], position: [70, 50, 0] }, 0),
    );

  it("moves a parented layer with the pointer, one undo step per drag", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    setupParent(editor, comp);
    const start = anchorInComp(comp, layerNamed(comp, "child"), 0);
    const original = value(layerNamed(comp, "child"), "ADBE Position");
    moveLayers(editor, comp, [layerNamed(comp, "child")], [4, 1], 0, { coalesce: "drag" });
    moveLayers(editor, comp, [layerNamed(comp, "child")], [12, 5], 0, { coalesce: "drag" });
    close(anchorInComp(comp, layerNamed(comp, "child"), 0), [start[0] + 12, start[1] + 5]);
    moveLayers(editor, comp, [layerNamed(comp, "child")], [12, 5], 0, { coalesce: "drag", constrain: true });
    close(anchorInComp(comp, layerNamed(comp, "child"), 0), [start[0] + 12, start[1]]);
    editor.commit();
    editor.undo();
    close(value(layerNamed(comp, "child"), "ADBE Position"), original);
    expect(editor.undoLabel).toBe("setup");
  });

  it("scales from a handle around the anchor point", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    deleteLayers(editor, comp, [layerNamed(comp, "Null 1")], 0);
    const child = () => layerNamed(comp, "child");
    resetTransform(editor, comp, [child()], 0);
    const scale = value(child(), "ADBE Scale");
    const [, right] = corners(comp, child());
    const rightMiddle = sourcePointToComp(child(), comp, [child().width, child().height / 2], 0);
    scaleByHandle(editor, comp, child(), [1, 0], rightMiddle, [rightMiddle[0] + 10, rightMiddle[1] + 7], 0, { coalesce: "s" });
    close(sourcePointToComp(child(), comp, [child().width, child().height / 2], 0), [rightMiddle[0] + 10, rightMiddle[1]]);
    expect(value(child(), "ADBE Scale")[1]).toBeCloseTo(scale[1]);
    scaleByHandle(editor, comp, child(), [1, 1], corners(comp, child())[2], [right[0] + 5, right[1] + 50], 0, { coalesce: "s2" });
    scaleByHandle(editor, comp, child(), [1, 1], corners(comp, child())[2], [0, 0], 0, { coalesce: "s3", proportional: true });
    const [sx, sy] = value(child(), "ADBE Scale");
    const ratio = sx / sy;
    scaleByHandle(editor, comp, child(), [1, 1], corners(comp, child())[2], [200, 150], 0, { coalesce: "s4", proportional: true });
    const [nx, ny] = value(child(), "ADBE Scale");
    expect(nx / ny).toBeCloseTo(ratio);
  });

  it("handle drags follow the pointer on rotated, parented layers", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    setupParent(editor, comp);
    editor.perform("setup", [comp], () => writeTransform(editor, comp, layerNamed(comp, "child").id, { rotation: 25 }, 0));
    const child = () => layerNamed(comp, "child");
    const corner = sourcePointToComp(child(), comp, [child().width, child().height], 0);
    const handleBefore = corner;
    const to: [number, number] = [corner[0] + 6, corner[1] - 3];
    scaleByHandle(editor, comp, child(), [1, 1], handleBefore, to, 0);
    // The parent shears the layer frame, so the corner lands on the pointer only up to the shear.
    const after = sourcePointToComp(child(), comp, [child().width, child().height], 0);
    expect(Math.hypot(after[0] - to[0], after[1] - to[1])).toBeLessThan(Math.hypot(handleBefore[0] - to[0], handleBefore[1] - to[1]));
  });

  it("rotates around the anchor point and snaps to 45°", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    const child = () => layerNamed(comp, "child");
    const [cx, cy] = anchorInComp(comp, child(), 0);
    const before = transformProp(child(), "ADBE Rotate Z")!.value as number;
    rotateByDrag(editor, comp, child(), [cx + 10, cy], [cx, cy + 10], 0, { coalesce: "r" });
    expect(transformProp(child(), "ADBE Rotate Z")!.value).toBeCloseTo(before + 90);
    rotateByDrag(editor, comp, child(), [cx + 10, cy], [cx + 10, cy + 4], 0, { coalesce: "r", snap: true });
    expect(((transformProp(child(), "ADBE Rotate Z")!.value as number) % 45 + 45) % 45).toBeCloseTo(0);
    close(anchorInComp(comp, child(), 0), [cx, cy]);
  });

  it("pans behind: the anchor moves, the layer stays unless Alt", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    setupParent(editor, comp);
    const child = () => layerNamed(comp, "child");
    const before = corners(comp, child());
    const anchor = anchorInComp(comp, child(), 0);
    panBehind(editor, comp, child(), [5, -3], 0);
    corners(comp, child()).forEach((p, i) => close(p, before[i]));
    close(anchorInComp(comp, child(), 0), [anchor[0] + 5, anchor[1] - 3]);
    const position = value(child(), "ADBE Position");
    panBehind(editor, comp, child(), [5, -3], 0, { anchorOnly: true });
    close(value(child(), "ADBE Position"), position);
    close(anchorInComp(comp, child(), 0), [anchor[0] + 5, anchor[1] - 3]);
  });

  it("nudges Position", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    const child = () => layerNamed(comp, "child");
    const position = value(child(), "ADBE Position");
    nudgeLayers(editor, comp, [child()], [10, -1], 0);
    close(value(child(), "ADBE Position").slice(0, 2), [position[0] + 10, position[1] - 1]);
    editor.undo();
    close(value(child(), "ADBE Position"), position);
  });

  it("keys animated properties at the current time", () => {
    const editor = load();
    const comp = compNamed(editor, "parent");
    const child = () => layerNamed(comp, "child");
    editor.toggleStopwatch(comp, child(), transformProp(child(), "ADBE Position")!, 0);
    const keys = transformProp(child(), "ADBE Position")!.keyframes.length;
    const [x, y] = anchorInComp(comp, child(), 0.5);
    moveLayers(editor, comp, [child()], [10, 0], 0.5, { coalesce: "k" });
    moveLayers(editor, comp, [child()], [20, 0], 0.5, { coalesce: "k" });
    const prop = transformProp(child(), "ADBE Position")!;
    expect(prop.keyframes.length).toBe(keys + 1);
    expect(prop.keyframes.at(-1)!.time).toBeCloseTo(0.5);
    close(anchorInComp(comp, child(), 0.5), [x + 20, y]);
    editor.undo();
    expect(transformProp(child(), "ADBE Position")!.keyframes.length).toBe(keys);
  });
});
