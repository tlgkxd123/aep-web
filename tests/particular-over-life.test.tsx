// @vitest-environment jsdom
// Particular's Size over Life and Opacity over Life: the curves the renderer reads follow
// every edit, the editor rewrites them undoably (presets and freehand samples), and
// Effect Controls shows them as a graph with presets that draws on a drag.
import { Blob as NodeBlob } from "node:buffer";
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
  CURVE_BYTES,
  CURVE_PRESETS,
  CURVE_SAMPLES,
  curveSamples,
  drawnCurve,
  OPACITY_OVER_LIFE,
  overLifeCurve,
  PARTICULAR,
  pointSamples,
  sampleCurve,
  sampledCurve,
  SIZE_OVER_LIFE,
} from "../src/render/effects/particularCurves.ts";
import { ContextMenuHost } from "../src/ui/ContextMenu.tsx";
import { EditingContext } from "../src/ui/editing.tsx";
import { EffectControlsPanel } from "../src/ui/EffectControlsPanel.tsx";

afterEach(cleanup);

for (const name of ["PointerEvent"] as const) {
  if (typeof window[name] === "undefined") {
    Object.defineProperty(window, name, { configurable: true, value: class extends MouseEvent {} });
  }
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
const particularOf = (layer: Layer): PropertyGroup =>
  (layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade")!.children as PropertyGroup[]).find(
    (e) => e.matchName === PARTICULAR,
  )!;

describe("over Life curves", () => {
  it("writes freehand samples and presets as curves", () => {
    const blank = drawnCurve(new Uint8Array(CURVE_BYTES), [[0, 1], [1, 1]]);
    const ramp = Array.from({ length: CURVE_SAMPLES }, (_, i) => i / (CURVE_SAMPLES - 1));
    const drawn = curveSamples(sampledCurve(blank, ramp))!;
    ramp.forEach((v, i) => expect(drawn[i]).toBeCloseTo(v, 6));
    expect(sampleCurve(drawn, 0.25)).toBeCloseTo(0.25, 6);
    expect(sampleCurve(null, 0.5)).toBe(1);
    for (const preset of CURVE_PRESETS) {
      const samples = curveSamples(drawnCurve(blank, preset.points))!;
      expect(Array.from(samples)).toEqual(Array.from(pointSamples(preset.points)));
      expect(samples[0]).toBeCloseTo(preset.points[0][1], 6);
      expect(samples.at(-1)).toBeCloseTo(preset.points.at(-1)![1], 6);
    }
  });

  it("are rewritten undoably and read anew by the renderer after every edit", async () => {
    const { editor, comp, id } = await particularLayer();
    const sspc = particularOf(layerOf(comp, id)).chunk;
    expect(Array.from(overLifeCurve(sspc, SIZE_OVER_LIFE)!).every((v) => v === 1)).toBe(true);
    const fadeOut = CURVE_PRESETS.find((p) => p.name === "Fade Out")!;
    setEffectData(editor, comp, particularOf(layerOf(comp, id)), OPACITY_OVER_LIFE, (d) => drawnCurve(d, fadeOut.points));
    expect(sampleCurve(overLifeCurve(sspc, OPACITY_OVER_LIFE), 1)).toBeCloseTo(0, 6);
    expect(sampleCurve(overLifeCurve(sspc, OPACITY_OVER_LIFE), 0.5)).toBeCloseTo(1, 6);
    expect(sampleCurve(overLifeCurve(sspc, SIZE_OVER_LIFE), 1)).toBe(1);

    // A drag's steps make one undo step.
    const before = editor.history.length;
    for (const v of [0.8, 0.6, 0.4]) {
      setEffectData(editor, comp, particularOf(layerOf(comp, id)), SIZE_OVER_LIFE, (d) => sampledCurve(d, new Array(CURVE_SAMPLES).fill(v)), { coalesce: "drag" });
    }
    editor.commit();
    expect(editor.history.length).toBe(before + 1);
    expect(overLifeCurve(sspc, SIZE_OVER_LIFE)![100]).toBeCloseTo(0.4, 6);

    const reopened = Editor.fromBytes(editor.save()).project.items.get(comp.id) as CompItem;
    const saved = particularOf(layerOf(reopened, id)).chunk;
    expect(overLifeCurve(saved, SIZE_OVER_LIFE)![100]).toBeCloseTo(0.4, 6);
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

describe("Effect Controls", () => {
  it("shows Size and Opacity over Life as graphs with presets, drawn on a drag", async () => {
    const { editor, comp, id } = await particularLayer();
    render(<Panel editor={editor} comp={comp} id={id} />);
    const tree = screen.getByRole("tree", { name: "Effect Controls" });
    const sspc = particularOf(layerOf(comp, id)).chunk;

    const sizeName = "Size over Life";
    fireEvent.click(within(tree).getByText("Particle (Master)"));
    expect(within(tree).getByRole("button", { name: "Opacity over Life preset: Constant" })).toBeTruthy();
    const preset = within(tree).getByRole("button", { name: `${sizeName} preset: Constant` });
    fireEvent.click(preset);
    fireEvent.click(screen.getByRole("menuitem", { name: /Ramp Down/ }));
    expect(within(tree).getByRole("button", { name: `${sizeName} preset: Ramp Down` })).toBeTruthy();
    expect(sampleCurve(overLifeCurve(sspc, SIZE_OVER_LIFE), 1)).toBeCloseTo(0, 6);
    expect(editor.undoLabel).toBe(`${sizeName}: Ramp Down`);

    fireEvent.click(within(tree).getByText(sizeName));
    const graph = within(tree).getByRole("img", { name: `${sizeName} graph` });
    graph.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
    act(() => {
      fireEvent.pointerDown(graph, { button: 0, pointerId: 1, clientX: 0, clientY: 50 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 200, clientY: 50 });
      fireEvent.pointerUp(window, { pointerId: 1, clientX: 200, clientY: 50 });
    });
    const drawn = overLifeCurve(sspc, SIZE_OVER_LIFE)!;
    for (const i of [0, 50, 100, 150, 200]) expect(drawn[i]).toBeCloseTo(0.5, 6);
    expect(within(tree).getByRole("button", { name: `${sizeName} preset: Custom` })).toBeTruthy();
    act(() => editor.undo());
    expect(sampleCurve(overLifeCurve(sspc, SIZE_OVER_LIFE), 1)).toBeCloseTo(0, 6);
  });
});
