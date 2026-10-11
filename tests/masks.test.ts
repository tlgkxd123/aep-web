// Masks the editor writes (src/edit/masks.ts): shapes, modes and names read back as written, after the layer's
// other groups, as one undoable step.
import { describe, expect, it } from "vitest";
import type { CompItem, Layer, Property, PropertyGroup, Shape } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";
import { addLayer } from "../src/edit/layers.ts";
import { addMasks, arcShape, ellipseShape, MaskMode } from "../src/edit/masks.ts";
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

  it("puts the Masks group before the Effects and Transform groups", () => {
    const { editor, comp, id } = solidComp();
    addMasks(editor, comp, id, [{ shape: ellipseShape(200, 100, 50, 50) }]);
    const order = comp.layers[0].properties.map((n) => n.matchName);
    expect(order.indexOf("ADBE Mask Parade")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("ADBE Mask Parade")).toBeLessThan(order.indexOf("ADBE Transform Group"));
  });
});
