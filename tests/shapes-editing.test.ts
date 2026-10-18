// Shapes the editor draws (src/edit/shapes.ts): shape layers and groups as the shape tools and the Pen make
// them, every property stored and read back as written, and the Contents commands.
import { describe, expect, it } from "vitest";
import type { CompItem, Layer, Property, PropertyGroup, PropertyNode, Shape } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";
import { ellipseShape } from "../src/edit/masks.ts";
import { DEFAULT_COMP_SETTINGS, newComposition, newProject } from "../src/edit/project.ts";
import { addShapeLayer, addShapes, deleteShapeItems, duplicateShapeItems, renameShapeGroup, type ShapePaint } from "../src/edit/shapes.ts";
import { setPropertyValue } from "../src/edit/stored-property.ts";

const PAINT: ShapePaint = { fill: [1, 0, 0], stroke: [0, 0, 1], strokeWidth: 4 };

function setup() {
  const editor = newProject();
  const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: "Shapes", width: 640, height: 360, frameRate: 30 });
  return { editor, comp };
}

const reopened = (editor: Editor): Layer[] =>
  [...Editor.fromBytes(editor.save()).project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === "Shapes")!.layers;

const groupsOf = (layer: Layer) =>
  ((layer.properties.find((n) => n.matchName === "ADBE Root Vectors Group") as PropertyGroup).children ?? []).filter((n): n is PropertyGroup => n.kind === "group");

function find(nodes: readonly PropertyNode[], matchName: string): PropertyNode | undefined {
  for (const n of nodes) {
    if (n.matchName === matchName) return n;
    if (n.kind === "group") {
      const found = find(n.children, matchName);
      if (found) return found;
    }
  }
  return undefined;
}
const value = (group: PropertyGroup, matchName: string) => (find(group.children, matchName) as Property).value;
const transformValue = (layer: Layer, matchName: string) => value(layer.properties.find((n) => n.matchName === "ADBE Transform Group") as PropertyGroup, matchName);

describe("addShapeLayer", () => {
  it("makes a shape layer at the drawn centre holding a Rectangle with its Stroke and Fill, all stored", () => {
    const { editor, comp } = setup();
    addShapeLayer(editor, comp, { kind: "rect", size: [200, 100], roundness: 6, paint: PAINT }, [100, 80]);
    expect(editor.history.at(-1)).toBe("New Rectangle Layer");
    const [layer] = reopened(editor);
    expect(layer.layerType).toBe("ShapeLayer");
    expect(layer.name).toBe("Shape Layer 1");
    expect(transformValue(layer, "ADBE Position")).toEqual([100, 80, 0]);
    const [group] = groupsOf(layer);
    expect(group.name).toBe("Rectangle 1");
    expect(value(group, "ADBE Vector Rect Size")).toEqual([200, 100]);
    expect(value(group, "ADBE Vector Rect Roundness")).toBe(6);
    expect(value(group, "ADBE Vector Position")).toEqual([0, 0]);
    expect(value(group, "ADBE Vector Scale")).toEqual([100, 100]);
    expect(value(group, "ADBE Vector Stroke Width")).toBe(4);
    expect((value(group, "ADBE Vector Stroke Color") as number[]).slice(0, 3)).toEqual([0, 0, 1]);
    expect((value(group, "ADBE Vector Fill Color") as number[]).slice(0, 3)).toEqual([1, 0, 0]);
    expect(value(group, "ADBE Vector Fill Opacity")).toBe(100);
    const contents = find(group.children, "ADBE Vectors Group") as PropertyGroup;
    expect(contents.children.map((c) => c.matchName)).toEqual(["ADBE Vector Shape - Rect", "ADBE Vector Graphic - Stroke", "ADBE Vector Graphic - Fill"]);
    const leftOut: string[] = [];
    const visit = (nodes: readonly PropertyNode[]) =>
      nodes.forEach((n) => (n.kind === "group" ? !/Materials|Taper|Wave|Dashes/.test(n.matchName) && visit(n.children) : n.synthesized && leftOut.push(n.matchName)));
    visit(group.children);
    expect(leftOut).toEqual([]);
    editor.undo();
    expect(reopened(editor)).toHaveLength(0);
  });

  it("adds ellipses, stars, polygons and paths on top, numbering each kind, without a Fill or Stroke when there is none", () => {
    const { editor, comp } = setup();
    const id = addShapeLayer(editor, comp, { kind: "ellipse", size: [50, 40], paint: PAINT }, [320, 180]);
    const path: Shape = ellipseShape(10, 20, 30, 40);
    addShapes(editor, comp, id, [
      { kind: "star", center: [5, 6], points: 6, outerRadius: 40, innerRadius: 20, paint: { ...PAINT, fill: null } },
      { kind: "polygon", center: [7, 8], points: 7, outerRadius: 30, paint: { ...PAINT, stroke: null } },
      { kind: "path", path, paint: PAINT },
    ]);
    const [layer] = reopened(editor);
    const groups = groupsOf(layer);
    expect(groups.map((g) => g.name)).toEqual(["Shape 1", "Polystar 2", "Polystar 1", "Ellipse 1"]);
    const [pathGroup, polygon, star, ellipse] = groups;
    expect(value(ellipse, "ADBE Vector Ellipse Size")).toEqual([50, 40]);
    expect(value(star, "ADBE Vector Star Type")).toBe(1);
    expect(value(star, "ADBE Vector Star Points")).toBe(6);
    expect(value(star, "ADBE Vector Star Inner Radius")).toBe(20);
    expect(value(star, "ADBE Vector Position")).toEqual([5, 6]);
    expect(find(star.children, "ADBE Vector Graphic - Fill")).toBeUndefined();
    expect(value(polygon, "ADBE Vector Star Type")).toBe(2);
    expect(find(polygon.children, "ADBE Vector Graphic - Stroke")).toBeUndefined();
    const stored = value(pathGroup, "ADBE Vector Shape") as Shape;
    stored.vertices.forEach((v, i) => v.forEach((c, j) => expect(c).toBeCloseTo(path.vertices[i][j], 3)));
  });
});

describe("shape commands", () => {
  it("renames, duplicates and deletes groups, and edits paint and paths", () => {
    const { editor, comp } = setup();
    const id = addShapeLayer(editor, comp, { kind: "rect", size: [100, 100], paint: PAINT }, [100, 100]);
    const layer = () => comp.layers.find((l) => l.id === id)!;
    renameShapeGroup(editor, comp, groupsOf(layer())[0], "Box");
    duplicateShapeItems(editor, comp, layer(), [groupsOf(layer())[0]]);
    expect(groupsOf(reopened(editor)[0]).map((g) => g.name)).toEqual(["Box 2", "Box"]);
    const width = find(groupsOf(layer())[1].children, "ADBE Vector Stroke Width") as Property;
    setPropertyValue(editor, comp, layer(), width, 9, 0);
    expect(value(groupsOf(reopened(editor)[0])[1], "ADBE Vector Stroke Width")).toBe(9);
    expect(value(groupsOf(reopened(editor)[0])[0], "ADBE Vector Stroke Width")).toBe(4);
    deleteShapeItems(editor, comp, layer(), [groupsOf(layer())[0]]);
    expect(groupsOf(reopened(editor)[0]).map((g) => g.name)).toEqual(["Box"]);
  });
});
