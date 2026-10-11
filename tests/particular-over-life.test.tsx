// @vitest-environment jsdom
// Particular's Size over Life and Opacity over Life: the curves the renderer reads follow
// every edit, the editor rewrites them undoably through their control points (stored ones,
// or ones fitted to a curve stored without), and Effect Controls edits them as a graph of
// points: pressed to add one, dragged, nudged with the keys, typed or deleted.
import { Blob as NodeBlob } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { CompItem, Layer, PropertyGroup } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";
import { addEffects, newInstance, setEffectData } from "../src/edit/effects.ts";
import { addLayer } from "../src/edit/layers.ts";
import { DEFAULT_COMP_SETTINGS, newComposition, newProject } from "../src/edit/project.ts";
import { effectTemplates } from "../src/extra/pmatch/effectTemplates.ts";
import {
  addPoint,
  CURVE_BYTES,
  CURVE_SAMPLES,
  curveChunk,
  curveSamples,
  drawnCurve,
  fittedPoints,
  MAX_CURVE_POINTS,
  movePoint,
  OPACITY_OVER_LIFE,
  overLifeCurve,
  overLifePoints,
  PARTICULAR,
  pointSamples,
  removePoint,
  sampleCurve,
  SIZE_OVER_LIFE,
  storedPoints,
  type CurvePoint,
} from "../src/render/effects/particularCurves.ts";
import { ContextMenuHost } from "../src/ui/ContextMenu.tsx";
import { EditingContext } from "../src/ui/editing.tsx";
import { EffectControlsPanel } from "../src/ui/EffectControlsPanel.tsx";

afterEach(cleanup);

if (typeof window.PointerEvent === "undefined") {
  class PointerEventShim extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: PointerEventShim });
}

/** The effect templates, unpacked with Node's Blob: jsdom's cannot stream. */
async function templates() {
  const jsdomBlob = globalThis.Blob;
  globalThis.Blob = NodeBlob as unknown as typeof Blob;
  try {
    return await effectTemplates();
  } finally {
    globalThis.Blob = jsdomBlob;
  }
}

async function particularLayer() {
  const editor = newProject();
  const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, frameRate: 30, duration: 4 });
  const template = (await templates()).get(PARTICULAR)!;
  const id = addLayer(editor, comp, { kind: "solid", name: "Particles", color: [0, 0, 0], width: comp.width, height: comp.height, pixelAspect: comp.pixelAspect });
  addEffects(editor, comp, id, [{ template, instance: newInstance(template) }]);
  return { editor, comp, id };
}

const layerOf = (comp: CompItem, id: number) => comp.layers.find((l) => l.id === id)!;
const particularOf = (layer: Layer): PropertyGroup | undefined =>
  (layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade")?.children as PropertyGroup[] | undefined)?.find(
    (e) => e.matchName === PARTICULAR,
  );

const maxGap = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.max(...Array.from(a, (v, i) => Math.abs(v - b[i])));
const share = (i: number) => i / (CURVE_SAMPLES - 1);

describe("over Life curves", () => {
  const blank = drawnCurve(new Uint8Array(CURVE_BYTES), [[0, 1], [1, 1]]);

  it("store the points they are drawn through, straight lines between them", () => {
    const points: CurvePoint[] = [[0, 0], [share(40), 1], [share(150), 0.5], [1, 0]];
    const data = drawnCurve(blank, points);
    expect(storedPoints(data)).toEqual(points);
    const samples = curveSamples(data)!;
    expect(samples[20]).toBeCloseTo(0.5, 6);
    expect(samples[95]).toBeCloseTo(0.75, 6);
    expect(sampleCurve(samples, 1)).toBe(0);
    expect(sampleCurve(null, 0.5)).toBe(1);
    // A curve stored without points (Particular's presets, freehand drawing) has none to read.
    const freehand = data.slice();
    new DataView(freehand.buffer).setFloat32(24, 0, true);
    expect(storedPoints(freehand)).toBeNull();
  });

  it("fit at most 25 points to samples stored without them", () => {
    expect(fittedPoints(new Array(CURVE_SAMPLES).fill(1))).toEqual([[0, 1], [1, 1]]);
    const corners: CurvePoint[] = [[0, 0.2], [share(60), 1], [share(120), 1], [1, 0]];
    expect(fittedPoints(pointSamples(corners))).toEqual(corners.map(([u, v]) => [u, Math.fround(v)]));
    const wave = Array.from({ length: CURVE_SAMPLES }, (_, i) => 0.5 + 0.5 * Math.sin(share(i) * Math.PI * 6));
    const fitted = fittedPoints(wave);
    expect(fitted).toHaveLength(MAX_CURVE_POINTS);
    expect(maxGap(pointSamples(fitted), wave)).toBeLessThan(0.05);
  });

  it("move, add and remove points on whole samples, keeping birth and death in place", () => {
    const points: CurvePoint[] = [[0, 1], [share(100), 0.5], [1, 1]];
    expect(movePoint(points, 0, 0.4, 0.25)).toEqual([[0, 0.25], points[1], points[2]]);
    expect(movePoint(points, 2, 0.4, 1.5)).toEqual([points[0], points[1], [1, 1]]);
    expect(movePoint(points, 1, 0.3, -1)).toEqual([points[0], [share(60), 0], points[2]]);
    expect(movePoint(points, 1, 1, 0.5)[1][0]).toBe(share(199));
    expect(movePoint(points, 1, -1, 0.5)[1][0]).toBe(share(1));

    const added = addPoint(points, 0.251, 0.75);
    expect(added).toEqual({ points: [points[0], [share(50), 0.75], points[1], points[2]], index: 1 });
    expect(addPoint(points, 0.5, 0.1)).toEqual({ points: [points[0], [0.5, 0.1], points[2]], index: 1 });
    const full = Array.from({ length: MAX_CURVE_POINTS }, (_, k): CurvePoint => [k / (MAX_CURVE_POINTS - 1), 1]);
    expect(addPoint(full, 0.01, 0.5)).toEqual({ points: full, index: -1 });

    expect(removePoint(added.points, 1)).toEqual(points);
    expect(removePoint(points, 0)).toEqual(points);
    expect(removePoint(points, 2)).toEqual(points);
  });

  it("are edited through points fitted to a smooth curve After Effects stored", () => {
    const editor = Editor.fromBytes(new Uint8Array(readFileSync(resolve(import.meta.dirname, "../refs/fixtures/fxextra.aep"))));
    const comps = [...editor.project.items.values()].filter((i): i is CompItem => i.kind === "comp");
    const [comp, layer] = comps.flatMap((c) => c.layers.filter((l) => particularOf(l)).map((l) => [c, l] as const))[0];
    const effect = particularOf(layer)!;
    const smooth = Float32Array.from(overLifeCurve(effect.chunk, OPACITY_OVER_LIFE)!);
    // Particular's own fade in and out: smooth ramps, stored without points.
    expect(smooth[10]).toBeCloseTo(0.104, 3);
    expect(storedPoints(curveChunk(effect.chunk!, OPACITY_OVER_LIFE)!.data)).toBeNull();
    const points = overLifePoints(effect.chunk, OPACITY_OVER_LIFE)!;
    expect(points.length).toBeGreaterThan(4);
    expect(points.length).toBeLessThanOrEqual(MAX_CURVE_POINTS);
    expect(maxGap(pointSamples(points), smooth)).toBeLessThan(0.01);

    const middle = points.findIndex(([u]) => u >= 0.5);
    const moved = movePoint(points, middle, points[middle][0], 0.5);
    setEffectData(editor, comp, effect, OPACITY_OVER_LIFE, (d) => drawnCurve(d, moved));
    const edited = overLifeCurve(effect.chunk, OPACITY_OVER_LIFE)!;
    expect(sampleCurve(edited, points[middle][0])).toBeCloseTo(0.5, 6);
    expect(maxGap(edited.subarray(0, 50), smooth.subarray(0, 50))).toBeLessThan(0.01);
    expect(overLifePoints(effect.chunk, OPACITY_OVER_LIFE)).toEqual(moved.map(([u, v]) => [u, Math.fround(v)]));
    editor.undo();
    expect(Array.from(overLifeCurve(effect.chunk, OPACITY_OVER_LIFE)!)).toEqual(Array.from(smooth));
  });

  it("are rewritten undoably and read anew by the renderer after every edit", async () => {
    const { editor, comp, id } = await particularLayer();
    const sspc = particularOf(layerOf(comp, id))!.chunk;
    expect(Array.from(overLifeCurve(sspc, SIZE_OVER_LIFE)!).every((v) => v === 1)).toBe(true);
    expect(overLifePoints(sspc, SIZE_OVER_LIFE)).toEqual([[0, 1], [1, 1]]);
    setEffectData(editor, comp, particularOf(layerOf(comp, id))!, OPACITY_OVER_LIFE, (d) => drawnCurve(d, [[0, 1], [0.8, 1], [1, 0]]));
    expect(sampleCurve(overLifeCurve(sspc, OPACITY_OVER_LIFE), 1)).toBeCloseTo(0, 6);
    expect(sampleCurve(overLifeCurve(sspc, OPACITY_OVER_LIFE), 0.5)).toBeCloseTo(1, 6);
    expect(sampleCurve(overLifeCurve(sspc, SIZE_OVER_LIFE), 1)).toBe(1);

    // A drag's steps make one undo step.
    const before = editor.history.length;
    for (const v of [0.8, 0.6, 0.4]) {
      setEffectData(editor, comp, particularOf(layerOf(comp, id))!, SIZE_OVER_LIFE, (d) => drawnCurve(d, [[0, 1], [0.5, v], [1, 1]]), { coalesce: "drag" });
    }
    editor.commit();
    expect(editor.history.length).toBe(before + 1);
    expect(overLifeCurve(sspc, SIZE_OVER_LIFE)![100]).toBeCloseTo(0.4, 6);

    const reopened = Editor.fromBytes(editor.save()).project.items.get(comp.id) as CompItem;
    const saved = particularOf(layerOf(reopened, id))!.chunk;
    expect(overLifeCurve(saved, SIZE_OVER_LIFE)![100]).toBeCloseTo(0.4, 6);
    expect(overLifePoints(saved, SIZE_OVER_LIFE)!.map(([u]) => u)).toEqual([0, 0.5, 1]);
    expect(sampleCurve(overLifeCurve(saved, OPACITY_OVER_LIFE), 1)).toBeCloseTo(0, 6);

    editor.undo();
    expect(overLifeCurve(sspc, SIZE_OVER_LIFE)![100]).toBe(1);
    editor.undo();
    expect(sampleCurve(overLifeCurve(sspc, OPACITY_OVER_LIFE), 1)).toBe(1);
  });
});

function Panel({ editor, comp, id }: { editor: Editor; comp: CompItem; id: number }) {
  const [revision, setRevision] = useState(editor.revision);
  useEffect(() => editor.subscribe(() => setRevision(editor.revision)), [editor]);
  return (
    <EditingContext.Provider value={{ editor, revision, tool: "selection", report: (m) => { throw new Error(m); }, snapping: false }}>
      <EffectControlsPanel project={{ ...editor.project }} comp={comp} layer={layerOf(comp, id)} time={0} />
      <ContextMenuHost />
    </EditingContext.Provider>
  );
}

const NAME = "Size over Life";

/** Effect Controls with Size over Life twirled open, its graph 200 × 100 pixels at the origin. */
async function openGraph() {
  const { editor, comp, id } = await particularLayer();
  render(<Panel editor={editor} comp={comp} id={id} />);
  const tree = screen.getByRole("tree", { name: "Effect Controls" });
  fireEvent.click(within(tree).getByText("Particle (Master)"));
  fireEvent.click(within(tree).getByText(NAME));
  const graph = () => {
    const svg = within(tree).getByRole("img", { name: `${NAME} graph` });
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    return svg;
  };
  const points = () => within(tree).queryAllByRole("slider", { name: new RegExp(`^${NAME} point \\d+$`) });
  const curve = () => overLifeCurve(particularOf(layerOf(comp, id))!.chunk, SIZE_OVER_LIFE)!;
  const drag = (target: Element, from: [number, number], to: [number, number][], pointerType = "mouse") =>
    act(() => {
      fireEvent.pointerDown(target, { button: 0, pointerId: 1, pointerType, clientX: from[0], clientY: from[1] });
      for (const [x, y] of to) fireEvent.pointerMove(window, { pointerId: 1, pointerType, clientX: x, clientY: y });
      const [x, y] = to.at(-1) ?? from;
      fireEvent.pointerUp(window, { pointerId: 1, pointerType, clientX: x, clientY: y });
    });
  return { editor, comp, id, tree, graph, points, curve, drag };
}

describe("Effect Controls", () => {
  it("shows Size and Opacity over Life as curves, without presets", async () => {
    const { tree, points } = await openGraph();
    expect(within(tree).getByRole("img", { name: `${NAME} curve` })).toBeTruthy();
    expect(within(tree).getByRole("img", { name: "Opacity over Life curve" })).toBeTruthy();
    expect(within(tree).queryByRole("button", { name: /preset/i })).toBeNull();
    expect(points().map((p) => p.getAttribute("aria-valuetext"))).toEqual(["0.0 % of life: 100.0 %", "100.0 % of life: 100.0 %"]);
    expect(within(tree).getByText("Click the graph to add a point")).toBeTruthy();
  });

  it("adds a point where the graph is pressed and drags it, as one undo step", async () => {
    const { editor, graph, points, curve, drag } = await openGraph();
    const before = editor.history.length;
    drag(graph(), [100, 20], [[120, 40], [150, 50]]);
    expect(points()).toHaveLength(3);
    expect(points()[1].getAttribute("aria-valuetext")).toBe("75.0 % of life: 50.0 %");
    expect(curve()[150]).toBeCloseTo(0.5, 6);
    expect(curve()[75]).toBeCloseTo(0.75, 6);
    expect(editor.history.length).toBe(before + 1);
    expect(editor.undoLabel).toBe(`Add ${NAME} Point`);
    expect(document.activeElement).toBe(points()[1]);

    // Death keeps its place at the end of life, whichever way it is dragged.
    drag(points()[2], [200, 0], [[150, 100]]);
    expect(points()[2].getAttribute("aria-valuetext")).toBe("100.0 % of life: 0.0 %");
    expect(curve()[200]).toBe(0);
    expect(editor.undoLabel).toBe(`Move ${NAME} Point`);

    act(() => editor.undo());
    expect(curve()[200]).toBe(1);
    act(() => editor.undo());
    expect(points()).toHaveLength(2);
    expect(Array.from(curve()).every((v) => v === 1)).toBe(true);
  });

  it("nudges, types and deletes the selected point", async () => {
    const { editor, comp, id, tree, graph, points, curve, drag } = await openGraph();
    drag(graph(), [100, 50], []);
    const point = points()[1];
    expect(point.getAttribute("aria-valuetext")).toBe("50.0 % of life: 50.0 %");

    fireEvent.keyDown(point, { key: "ArrowUp" });
    fireEvent.keyDown(points()[1], { key: "ArrowLeft", shiftKey: true });
    expect(points()[1].getAttribute("aria-valuetext")).toBe("45.0 % of life: 51.0 %");

    fireEvent.keyDown(within(tree).getByRole("spinbutton", { name: `${NAME} point 2 size` }), { key: "Enter" });
    const input = within(tree).getByRole("textbox", { name: `${NAME} point 2 size` });
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sampleCurve(curve(), 0.45)).toBeCloseTo(0.25, 6);

    fireEvent.keyDown(within(tree).getByRole("spinbutton", { name: `${NAME} point 2 life` }), { key: "Enter" });
    const life = within(tree).getByRole("textbox", { name: `${NAME} point 2 life` });
    fireEvent.change(life, { target: { value: "20" } });
    fireEvent.keyDown(life, { key: "Enter" });
    expect(points()[1].getAttribute("aria-valuetext")).toBe("20.0 % of life: 25.0 %");

    // Delete takes the point, not the effect.
    act(() => points()[1].focus());
    fireEvent.keyDown(points()[1], { key: "Delete" });
    expect(points()).toHaveLength(2);
    expect(editor.undoLabel).toBe(`Delete ${NAME} Point`);
    expect(particularOf(layerOf(comp, id))).toBeTruthy();
    expect(document.activeElement).toBe(points()[0]);
    fireEvent.keyDown(points()[0], { key: "Delete" });
    expect(points()).toHaveLength(2);
    expect(particularOf(layerOf(comp, id))).toBeTruthy();

    drag(graph(), [60, 30], []);
    fireEvent.click(within(tree).getByRole("button", { name: `Delete ${NAME} point 2` }));
    expect(points()).toHaveLength(2);
    expect(within(tree).getByRole("button", { name: `Delete ${NAME} point 1` })).toHaveProperty("disabled", true);
  });

  it("adds a point on a tap, and opens the menu instead on a long press", async () => {
    const { tree, graph, points, curve, drag } = await openGraph();
    drag(graph(), [50, 75], [], "touch");
    expect(points()).toHaveLength(3);
    expect(points()[1].getAttribute("aria-valuetext")).toBe("25.0 % of life: 25.0 %");

    act(() => {
      fireEvent.pointerDown(graph(), { button: 0, pointerId: 2, pointerType: "touch", clientX: 150, clientY: 50 });
      fireEvent.contextMenu(graph(), { clientX: 150, clientY: 50 });
      fireEvent.pointerUp(window, { pointerId: 2, pointerType: "touch", clientX: 150, clientY: 50 });
    });
    expect(points()).toHaveLength(3);
    expect(screen.getByRole("menuitem", { name: /Delete Point/ })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("menuitem", { name: new RegExp(`Reset ${NAME}`) }));
    expect(points()).toHaveLength(2);
    expect(Array.from(curve()).every((v) => v === 1)).toBe(true);
    expect(within(tree).getByRole("img", { name: `${NAME} curve` })).toBeTruthy();
  });

  it("deletes a point from its context menu and refuses a 26th", async () => {
    const { editor, comp, id, tree, graph, points, drag } = await openGraph();
    drag(graph(), [100, 50], []);
    fireEvent.contextMenu(points()[1], { clientX: 100, clientY: 50 });
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete Point/ }));
    expect(points()).toHaveLength(2);

    const full = Array.from({ length: MAX_CURVE_POINTS }, (_, k): CurvePoint => [k / (MAX_CURVE_POINTS - 1), k % 2 ? 0.5 : 1]);
    act(() => setEffectData(editor, comp, particularOf(layerOf(comp, id))!, SIZE_OVER_LIFE, (d) => drawnCurve(d, full)));
    expect(points()).toHaveLength(MAX_CURVE_POINTS);
    const before = editor.history.length;
    drag(graph(), [5, 90], []);
    expect(points()).toHaveLength(MAX_CURVE_POINTS);
    expect(editor.history.length).toBe(before);
    expect(within(tree).getByText(`A curve holds ${MAX_CURVE_POINTS} points at most`)).toBeTruthy();
  });
});
