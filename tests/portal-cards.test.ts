import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { CompItem, Property, PropertyGroup } from "../src/aep/model.ts";
import { currentValue } from "../src/aep/evaluate.ts";
import { parseProject } from "../src/aep/parse.ts";
import { readRifx } from "../src/aep/riff.ts";
import { writeChunkBytes, writeRifx } from "../src/aep/write.ts";
import { Editor } from "../src/edit/editor.ts";
import { applyLibraryEffect, effectLibrary, projectEffect } from "../src/edit/effectLibrary.ts";
import { tdmnName } from "../src/edit/layer-templates.ts";
import { addLayer } from "../src/edit/layers.ts";
import { DEFAULT_COMP_SETTINGS, newComposition, newProject } from "../src/edit/project.ts";
import { PORTAL_CARDS, PORTAL_CARD_PARAMS } from "../src/edit/portalCards.ts";
import { effectIsCacheable, effectIsScalable, effectRenderer, type LayerImage, type RenderContext } from "../src/render/registry.ts";
import "../src/render/effects/portalCards.ts";

describe("Portal Cards", () => {
  it("expands centered opaque portals with fixed proportions and continuous seeded handoffs", async () => {
    const editor = newProject();
    const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, width: 960, height: 540 });
    const id = addLayer(editor, comp, { kind: "solid", name: "Cards", width: 960, height: 540, color: [0.1, 0.2, 0.4], pixelAspect: 1 });
    const template = (await effectLibrary()).find((e) => e.matchName === PORTAL_CARDS)!;
    applyLibraryEffect(editor, comp, [id], template);
    const state = () => {
      const layer = comp.layers.find((l) => l.id === id)!;
      const parade = layer.properties.find((p) => p.matchName === "ADBE Effect Parade") as PropertyGroup;
      return { layer, effect: parade.children[0] as PropertyGroup };
    };
    const set = (index: number, value: number) => {
      const { layer, effect } = state();
      editor.setValue(comp, layer, effect.children[index - 1] as Property, value, 0);
    };
    set(3, 20);
    const frames = (time: number) => {
      const passes: Record<string, number[]>[] = [];
      let uniforms: Record<string, number[]>;
      const target = { width: 962, height: 542 };
      const input = { width: 960, height: 540, origin: [0, 0], target } as LayerImage;
      const scalar = (name: string, value: number) => { uniforms[name] = [value]; };
      const vector = (name: string, values: Float32Array) => { uniforms[name] = Array.from(values); };
      const ctx = {
        pad: 1,
        gl: { uniform1f: scalar, uniform1i: scalar, uniform2f: (name: string, x: number, y: number) => { uniforms[name] = [x, y]; }, uniform3fv: vector, uniform4fv: vector },
        pool: { acquire: () => target, release: () => {} },
        program: () => ({}),
        pass: (_program: unknown, _out: unknown, _inputs: unknown, write: (name: (key: string) => string) => void) => {
          uniforms = {};
          write((name) => name);
          passes.push(uniforms);
        },
      } as unknown as RenderContext;
      const { layer, effect } = state();
      effectRenderer(PORTAL_CARDS)!(input, effect, layer, time, ctx);
      return passes.filter((p) => p["u_sizes[0]"]);
    };
    const start = frames(0)[0];
    expect(start.u_count).toEqual([8]);
    expect(frames(5)[0]).not.toEqual(start);
    expect(frames(160)[0]).toEqual(start);
    const samples = Array.from({ length: 100 }, (_, i) => frames(i / 20)[0]);
    for (let card = 1; card < 7; card++) {
      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        const sizes = sample["u_sizes[0]"];
        expect(sizes[card * 4] / sizes[card * 4 + 1]).toBeCloseTo(960 / 540, 5);
        expect(sizes[card * 4 + 2]).toBe(1);
        if (i) expect(sizes[card * 4 + 1]).toBeGreaterThan(samples[i - 1]["u_sizes[0]"][card * 4 + 1]);
        const center = sample["u_centers[0]"];
        expect(Math.abs(center[card * 3]) / sizes[card * 4]).toBeLessThan(0.03);
        expect(Math.abs(center[card * 3 + 1]) / sizes[card * 4 + 1]).toBeLessThan(0.03);
      }
    }
    const before = frames(4.99999)[0];
    const after = frames(5.00001)[0];
    for (let card = 0; card < 7; card++) {
      for (const key of ["u_x[0]", "u_y[0]", "u_centers[0]"]) for (let axis = 0; axis < 3; axis++) {
        expect(before[key][(card + 1) * 3 + axis]).toBeCloseTo(after[key][card * 3 + axis], 4);
      }
      for (let axis = 0; axis < 2; axis++) expect(before["u_sizes[0]"][(card + 1) * 4 + axis]).toBeCloseTo(after["u_sizes[0]"][card * 4 + axis], 4);
    }
    set(8, 0);
    const still = frames(0)[0]["u_centers[0]"];
    for (let card = 0; card < 8; card++) for (let axis = 0; axis < 2; axis++) expect(still[card * 3 + axis]).toBeCloseTo(0);
    set(16, 0);
    expect(frames(0)[0].u_count).toEqual([8]);
    expect(frames(5)[0]).toEqual(frames(0)[0]);
    set(16, 50);
    const partial = frames(0);
    expect(partial).toHaveLength(1);
    expect(partial[0].u_count).toEqual([8]);
  });

  it("upgrades older saved controls without changing values, animation or unrelated chunks", async () => {
    const original = readFileSync("refs/portal-cards/portal-cards.aep");
    const file = readRifx(original);
    const get = (project: ReturnType<typeof parseProject>) => {
      const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === "Portal Cards")!;
      const layer = comp.layers[0];
      const parade = layer.properties.find((p): p is PropertyGroup => p.kind === "group" && p.matchName === "ADBE Effect Parade")!;
      const effect = parade.children[0] as PropertyGroup;
      const controls = effect.children.filter((p): p is Property => p.kind === "property");
      return { comp, layer, effect, controls };
    };
    const legacy = get(parseProject(original));
    expect(legacy.controls).toHaveLength(15);
    const unrelated = file.root.children!.filter((c) => c.listType !== "Fold" && c.listType !== "EfdG").map(writeChunkBytes);
    const editor = Editor.fromBytes(original);
    let state = get(editor.project);
    expect(state.controls).toHaveLength(17);
    expect(state.controls.slice(0, 15).map((p) => [p.name, p.value])).toEqual(legacy.controls.map((p) => [p.name, p.value]));
    expect(state.controls.slice(15).map((p) => [p.name, p.value])).toEqual([["Randomness", 0], ["Random Seed", 1]]);
    expect(state.controls.slice(15).every((p) => p.chunk && !p.synthesized && p.canVaryOverTime)).toBe(true);
    expect(state.controls.slice(4, 7).map((p) => [p.min, p.max])).toEqual([[-360, 360], [-360, 360], [-360, 360]]);
    expect(editor.project.effectParams.get(PORTAL_CARDS)).toHaveLength(17);
    expect(editor.file.root.children!.filter((c) => c.listType !== "Fold" && c.listType !== "EfdG").map(writeChunkBytes)).toEqual(unrelated);
    expect(editor.dirty).toBe(false);
    const baseline = editor.save();
    expect(Editor.fromBytes(baseline).save()).toEqual(baseline);
    editor.setValue(state.comp, state.layer, state.controls[15], 100, 0);
    editor.undo();
    expect(editor.save()).toEqual(baseline);
    editor.redo();
    state = get(editor.project);
    editor.toggleStopwatch(state.comp, state.layer, state.controls[15], 0);
    state = get(editor.project);
    editor.setValue(state.comp, state.layer, state.controls[15], 0, 1);
    state = get(editor.project);
    editor.toggleStopwatch(state.comp, state.layer, state.controls[0], 0);
    state = get(editor.project);
    editor.setValue(state.comp, state.layer, state.controls[0], 12, 1);
    state = get(editor.project);
    editor.setExpression(state.comp, state.layer, state.controls[0], "time * 2");
    state = get(editor.project);
    editor.setValue(state.comp, state.layer, state.controls[16], 481, 0);
    const animatedFile = readRifx(editor.save());
    // Remove new controls from both definition and instance to reproduce the prior schema.
    const strip = (chunk: typeof file.root) => {
      if (chunk.listType === "parT" || chunk.listType === "tdgp") {
        const children = chunk.children ?? [];
        chunk.children = children.filter((c, i) => {
          const name = c.type === "tdmn" ? tdmnName(c) : i > 0 && children[i - 1].type === "tdmn" ? tdmnName(children[i - 1]) : "";
          return name !== `${PORTAL_CARDS}-0016` && name !== `${PORTAL_CARDS}-0017`;
        });
      }
      chunk.children?.forEach(strip);
    };
    strip(animatedFile.root);
    const omitted = parseProject(writeRifx(animatedFile));
    const instance = get(omitted).effect.chunk!;
    // AE can omit an instance's parT and use its shared effect definition.
    instance.children = instance.children!.filter((c) => c.listType !== "parT");
    const upgraded = Editor.fromBytes(writeRifx(omitted.file));
    state = get(upgraded.project);
    expect(state.controls[0].expression).toBe("time * 2");
    expect(state.controls[0].keyframes.map((k) => [k.time, k.value])).toEqual([[0, legacy.controls[0].value], [1, 12]]);
    expect(state.controls.slice(15).every((p) => p.keyframes.length === 0 && p.expression === "")).toBe(true);
    expect(get(Editor.fromBytes(upgraded.save()).project).controls).toHaveLength(17);
    expect(projectEffect(upgraded.file.root, PORTAL_CARDS)?.template.instance).toBeTruthy();
    const library = (await effectLibrary()).find((e) => e.matchName === PORTAL_CARDS)!;
    applyLibraryEffect(upgraded, state.comp, [state.layer.id], library);
    expect(get(Editor.fromBytes(upgraded.save()).project).controls).toHaveLength(17);
  });

  it("is offered with independent editable defaults, saves/reopens, and undoes as one step", async () => {
    const library = await effectLibrary();
    const effect = library.find((e) => e.matchName === PORTAL_CARDS)!;
    expect(effect.name).toBe("Portal Cards");
    expect(effect.category).toBe("AEP Web");
    expect(effectRenderer(PORTAL_CARDS)).toBeTypeOf("function");
    expect(effectIsCacheable(PORTAL_CARDS)).toBe(false);
    expect(effectIsScalable(PORTAL_CARDS)).toBe(true);
    const editor = newProject();
    const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, width: 640, height: 360 });
    const id = addLayer(editor, comp, { kind: "solid", name: "Background", width: 640, height: 360, color: [0.1, 0.2, 0.4], pixelAspect: 1 });
    const get = (ed = editor) => {
      const c = ed.project.items.get(comp.id) as CompItem;
      const layer = c.layers.find((l) => l.id === id)!;
      const parade = layer.properties.find((p) => p.matchName === "ADBE Effect Parade") as PropertyGroup | undefined;
      const fx = parade?.children.find((p) => p.matchName === PORTAL_CARDS) as PropertyGroup | undefined;
      return { c, layer, fx, controls: fx?.children.filter((p): p is Property => p.kind === "property") ?? [] };
    };
    const before = editor.save();
    applyLibraryEffect(editor, get().c, [id], effect);
    expect(get().controls.map((p) => [p.name, p.value, p.min, p.max])).toEqual(PORTAL_CARD_PARAMS.map((p) => [...p]));
    expect(get().controls.every((p) => p.canVaryOverTime && p.chunk && !p.synthesized)).toBe(true);
    editor.undo();
    expect(editor.save()).toEqual(before);
    editor.redo();
    expect(get().fx?.enabled).toBe(true);
    let state = get();
    editor.setValue(state.c, state.layer, state.controls[4], 62, 0);
    state = get();
    editor.toggleStopwatch(state.c, state.layer, state.controls[14], 0);
    state = get();
    editor.setValue(state.c, state.layer, state.controls[14], 100, 1);
    state = get();
    editor.setValue(state.c, state.layer, state.controls[15], 72, 0);
    state = get();
    editor.setValue(state.c, state.layer, state.controls[16], 481, 0);
    const reopened = Editor.fromBytes(editor.save());
    const saved = get(reopened);
    expect(saved.controls[4].value).toBe(62);
    expect(saved.controls[14].keyframes).toHaveLength(2);
    expect(currentValue(saved.controls[14], 0.5, saved.layer)).toBeCloseTo(50);
    expect(saved.controls[15].value).toBe(72);
    expect(saved.controls[16].value).toBe(481);
    expect(projectEffect(reopened.file.root, PORTAL_CARDS)?.name).toBe("Portal Cards");
    applyLibraryEffect(reopened, saved.c, [id], effect);
    const effects = (get(reopened).layer.properties.find((p) => p.matchName === "ADBE Effect Parade") as PropertyGroup).children;
    const fresh = effects[1] as PropertyGroup;
    expect((fresh.children[4] as Property).value).toBe(60);
    expect((fresh.children[14] as Property).keyframes).toHaveLength(0);
    expect((fresh.children[15] as Property).value).toBe(100);
    expect((fresh.children[16] as Property).value).toBe(1);
  });
});
