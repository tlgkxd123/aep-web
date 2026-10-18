// Masks the editor writes (src/edit/masks.ts): shapes, modes and names read back as written, after the layer's
// other groups, as one undoable step.
import { describe, expect, it } from "vitest";
import type { CompItem, Layer, Property, PropertyGroup, Shape } from "../src/aep/model.ts";
import { findList } from "../src/aep/riff.ts";
import { Editor } from "../src/edit/editor.ts";
import { namedList } from "../src/edit/layer-templates.ts";
import { canStore, setPropertyValue } from "../src/edit/stored-property.ts";
import { addLayer } from "../src/edit/layers.ts";
import {
  addMasks,
  arcShape,
  deleteMasks,
  duplicateMasks,
  ellipseShape,
  MaskFeatherFalloff,
  MaskMode,
  rectShape,
  renameMask,
  setMaskColor,
  setMaskFeatherFalloff,
  setMaskInverted,
  setMaskLocked,
  setMaskMode,
  starShape,
} from "../src/edit/masks.ts";
import { DEFAULT_COMP_SETTINGS, newComposition, newProject } from "../src/edit/project.ts";

function solidComp() {
  const editor = newProject();
  const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: "Masks", width: 640, height: 360, frameRate: 30 });
  const id = addLayer(editor, comp, { kind: "solid", name: "Plate", color: [1, 1, 1], width: 400, height: 200 });
  return { editor, comp, id };
}

const masksOf = (layer: Layer) =>
  (layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Mask Parade")?.children ?? []).filter(
    (n): n is PropertyGroup => n.kind === "group" && !!n.mask,
  );
const shapeOf = (mask: PropertyGroup) => (mask.children.find((c): c is Property => c.kind === "property" && c.matchName === "ADBE Mask Shape")!).value;
const reopened = (editor: Editor, name: string) => {
  const comp = [...Editor.fromBytes(editor.save()).project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === name)!;
  return comp.layers[0];
};

function expectShape(actual: unknown, expected: Shape): void {
  const shape = actual as Shape;
  expect(shape.closed).toBe(expected.closed);
  for (const key of ["vertices", "inTangents", "outTangents"] as const) {
    expect(shape[key]).toHaveLength(expected[key].length);
    shape[key].forEach((p, i) => p.forEach((v, j) => expect(v).toBeCloseTo(expected[key][i][j], 2)));
  }
}

describe("addMasks", () => {
  it("writes a closed ellipse and an open arc that read back in layer pixels", () => {
    const { editor, comp, id } = solidComp();
    const ellipse = ellipseShape(200, 100, 80, 60);
    const arc = arcShape(200, 100, 90, -90, -270);
    addMasks(editor, comp, id, [{ shape: ellipse, name: "Disc" }, { shape: arc, mode: MaskMode.NONE, name: "Ring" }]);
    expect(editor.history.at(-1)).toBe("New Masks");

    const masks = masksOf(reopened(editor, "Masks"));
    expect(masks.map((m) => [m.name, m.mask?.maskMode, m.mask?.inverted])).toEqual([
      ["Disc", MaskMode.ADD, false],
      ["Ring", MaskMode.NONE, false],
    ]);
    expectShape(shapeOf(masks[0]), ellipse);
    expectShape(shapeOf(masks[1]), arc);
  });

  it("draws arcs from vertex to vertex at most a quarter turn apart", () => {
    const half = arcShape(0, 0, 10, -90, -270);
    expect(half.vertices.map((v) => v.map((c) => Math.round(c * 1000) / 1000 + 0))).toEqual([
      [0, -10],
      [-10, 0],
      [0, 10],
    ]);
    expect(arcShape(0, 0, 10, 0, 30).vertices).toHaveLength(2);
    expect(arcShape(0, 0, 10, 0, 360).vertices).toHaveLength(5);
  });

  it("adds to the masks a layer has, numbering the next one, and undoes as one step", () => {
    const { editor, comp, id } = solidComp();
    addMasks(editor, comp, id, [{ shape: ellipseShape(200, 100, 50, 50) }]);
    addMasks(editor, comp, id, [{ shape: ellipseShape(100, 50, 20, 20), mode: MaskMode.SUBTRACT, inverted: true }]);
    let masks = masksOf(reopened(editor, "Masks"));
    expect(masks.map((m) => [m.name, m.mask?.maskMode, m.mask?.inverted])).toEqual([
      ["Mask 1", MaskMode.ADD, false],
      ["Mask 2", MaskMode.SUBTRACT, true],
    ]);
    editor.undo();
    masks = masksOf(reopened(editor, "Masks"));
    expect(masks.map((m) => m.name)).toEqual(["Mask 1"]);
    editor.undo();
    expect(masksOf(reopened(editor, "Masks"))).toEqual([]);
  });

  it("can edit the properties After Effects leaves out at their defaults (Feather, Opacity, Expansion)", () => {
    const { editor, comp, id } = solidComp();
    addMasks(editor, comp, id, [{ shape: ellipseShape(200, 100, 50, 50) }]);
    const layer = () => comp.layers.find((l) => l.id === id)!;
    const prop = (name: string) => masksOf(layer())[0].children.find((c): c is Property => c.kind === "property" && c.matchName === name)!;
    for (const name of ["ADBE Mask Shape", "ADBE Mask Feather", "ADBE Mask Opacity", "ADBE Mask Offset"]) expect(canStore(editor, layer(), prop(name)), name).toBe(true);
    setPropertyValue(editor, comp, layer(), prop("ADBE Mask Feather"), [12, 12], 0);
    setPropertyValue(editor, comp, layer(), prop("ADBE Mask Offset"), -4, 0);
    setPropertyValue(editor, comp, layer(), prop("ADBE Mask Opacity"), 40, 0);
    const [mask] = masksOf(reopened(editor, "Masks"));
    const value = (name: string) => mask.children.find((c): c is Property => c.kind === "property" && c.matchName === name)!;
    expect(value("ADBE Mask Feather").value).toEqual([12, 12]);
    expect(value("ADBE Mask Offset").value).toBe(-4);
    expect(value("ADBE Mask Opacity").value).toBe(40);
    expect(mask.children.filter((c) => c.kind === "property").map((c) => c.matchName)).toEqual([
      "ADBE Mask Shape",
      "ADBE Mask Feather",
      "ADBE Mask Opacity",
      "ADBE Mask Offset",
    ]);
    editor.undo();
    expect(prop("ADBE Mask Opacity").synthesized).toBe(true);
  });

  it("puts the Masks group before the Effects and Transform groups", () => {
    const { editor, comp, id } = solidComp();
    addMasks(editor, comp, id, [{ shape: ellipseShape(200, 100, 50, 50) }]);
    const order = comp.layers[0].properties.map((n) => n.matchName);
    expect(order.indexOf("ADBE Mask Parade")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("ADBE Mask Parade")).toBeLessThan(order.indexOf("ADBE Transform Group"));
  });
});

describe("mask commands", () => {
  const twoMasks = () => {
    const setup = solidComp();
    addMasks(setup.editor, setup.comp, setup.id, [{ shape: ellipseShape(200, 100, 50, 50) }, { shape: rectShape(10, 10, 90, 60) }]);
    const layer = () => setup.comp.layers.find((l) => l.id === setup.id)!;
    return { ...setup, layer };
  };

  it("changes mode, inversion, lock, colour, feather falloff and name, each read back from the saved file", () => {
    const { editor, comp, layer } = twoMasks();
    setMaskMode(editor, comp, layer(), [masksOf(layer())[1]], MaskMode.DIFFERENCE);
    setMaskInverted(editor, comp, layer(), [masksOf(layer())[0]], true);
    setMaskLocked(editor, comp, layer(), [masksOf(layer())[0]], true);
    setMaskColor(editor, comp, layer(), [masksOf(layer())[1]], [1, 0, 0]);
    setMaskFeatherFalloff(editor, comp, layer(), [masksOf(layer())[1]], MaskFeatherFalloff.LINEAR);
    renameMask(editor, comp, layer(), masksOf(layer())[0], "Hole");
    const masks = masksOf(reopened(editor, "Masks"));
    expect(masks.map((m) => [m.name, m.mask?.maskMode, m.mask?.inverted, m.mask?.locked])).toEqual([
      ["Hole", MaskMode.ADD, true, true],
      ["Mask 2", MaskMode.DIFFERENCE, false, false],
    ]);
    expect(masks[1].mask?.color).toEqual([1, 0, 0]);
    expect(masks[1].mask?.maskFeatherFalloff).toBe(MaskFeatherFalloff.LINEAR);
    expect(editor.history.slice(-6)).toEqual(["Change mask mode", "Invert mask", "Lock mask", "Change mask color", "Change mask feather falloff", "Rename mask"]);
  });

  it("duplicates a mask under a new id and deletes masks, dropping the Masks group with the last one", () => {
    const { editor, comp, layer } = twoMasks();
    duplicateMasks(editor, comp, layer(), [masksOf(layer())[0]]);
    expect(masksOf(reopened(editor, "Masks")).map((m) => m.name)).toEqual(["Mask 1", "Mask 3", "Mask 2"]);
    expectShape(shapeOf(masksOf(layer())[1]), ellipseShape(200, 100, 50, 50));
    deleteMasks(editor, comp, layer(), [masksOf(layer())[0], masksOf(layer())[2]]);
    expect(masksOf(reopened(editor, "Masks")).map((m) => m.name)).toEqual(["Mask 3"]);
    deleteMasks(editor, comp, layer(), masksOf(layer()));
    expect(namedList(findList(reopened(editor, "Masks").chunk, "tdgp"), "ADBE Mask Parade")).toBeUndefined();
    editor.undo();
    editor.undo();
    expect(masksOf(reopened(editor, "Masks")).map((m) => m.name)).toEqual(["Mask 1", "Mask 3", "Mask 2"]);
  });
});

describe("mask paths", () => {
  const pathOf = (layer: Layer) => masksOf(layer)[0].children.find((c): c is Property => c.kind === "property" && c.matchName === "ADBE Mask Shape")!;
  const setup = () => {
    const s = solidComp();
    addMasks(s.editor, s.comp, s.id, [{ shape: rectShape(0, 0, 100, 50) }]);
    return { ...s, layer: () => s.comp.layers.find((l) => l.id === s.id)! };
  };

  it("sets a static path in layer pixels", () => {
    const { editor, comp, layer } = setup();
    const star = starShape(200, 100, 5, 80, 40);
    editor.setValue(comp, layer(), pathOf(layer()), star, 0);
    expectShape(pathOf(reopened(editor, "Masks")).value, star);
  });

  it("animates a path: stopwatch, a keyframe per changed time, moved and removed keys keep their paths", () => {
    const { editor, comp, layer } = setup();
    const a = rectShape(0, 0, 100, 50);
    const b = rectShape(50, 20, 300, 180);
    const c = ellipseShape(200, 100, 60, 60);
    editor.toggleStopwatch(comp, layer(), pathOf(layer()), 0);
    editor.setValue(comp, layer(), pathOf(layer()), b, 1);
    editor.setValue(comp, layer(), pathOf(layer()), c, 2);
    let prop = pathOf(reopened(editor, "Masks"));
    expect(prop.keyframes.map((k) => k.time)).toEqual([0, 1, 2]);
    expectShape(prop.keyframes[0].value, a);
    expectShape(prop.keyframes[1].value, b);
    expectShape(prop.keyframes[2].value, c);

    editor.moveKeyframes(comp, layer(), [{ prop: pathOf(layer()), indices: [0] }], 3);
    prop = pathOf(reopened(editor, "Masks"));
    expect(prop.keyframes.map((k) => k.time)).toEqual([1, 2, 3]);
    expectShape(prop.keyframes[2].value, a);

    editor.removeKeyframes(comp, layer(), pathOf(layer()), [1]);
    prop = pathOf(reopened(editor, "Masks"));
    expectShape(prop.keyframes[0].value, b);
    expectShape(prop.keyframes[1].value, a);

    editor.toggleStopwatch(comp, layer(), pathOf(layer()), 1);
    prop = pathOf(reopened(editor, "Masks"));
    expect(prop.keyframes).toHaveLength(0);
    expectShape(prop.value, b);
  });
});
