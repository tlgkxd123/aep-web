// Particle Match's "Create Particular Layers": the settings it derives from a world
// model, and the Trapcode Particular layers it writes into a project.
import { describe, expect, it } from "vitest";
import type { CompItem, Layer, PropertyGroup } from "../src/aep/model.ts";
import { findList, type Chunk } from "../src/aep/riff.ts";
import { Mat4 } from "../src/aep/transform.ts";
import { Editor } from "../src/edit/editor.ts";
import { DEFAULT_COMP_SETTINGS, newComposition, newProject } from "../src/edit/project.ts";
import { createParticularLayers, effectParam, MIRROR, PARTICULAR, PARTICULAR_PARAM as P, particularSettings, type ParticularTarget } from "../src/extra/pmatch/particular.ts";
import { curveSamples } from "../src/render/effects/particularCurves.ts";
import { SPEED_BIAS, swingingFeatures, syntheticModel } from "./pmatch-fixtures.ts";

const TARGET: ParticularTarget = { width: 1920, height: 1080, frameRate: 30, duration: 4, zoom: 1920 / 0.72 };

const effectsOf = (layer: Layer): PropertyGroup[] =>
  (layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade")?.children ?? []).filter(
    (n): n is PropertyGroup => n.kind === "group",
  );

/** The stored over Life curve samples of parameter `n` of `effect`. */
function storedCurve(effect: PropertyGroup, n: number): Float32Array | null {
  const name = `${PARTICULAR}-${String(n).padStart(4, "0")}`;
  const children = effect.chunk?.children ?? [];
  const sspc = children.find((c) => c.type === "LIST" && c.listType === "sspc") ?? effect.chunk;
  const tdgp = sspc && findList(sspc, "tdgp");
  let current = "";
  for (const c of (tdgp?.children ?? []) as Chunk[]) {
    if (c.type === "tdmn") current = new TextDecoder().decode(c.data).replace(/\0[\s\S]*$/, "");
    else if (current === name && c.type === "LIST" && c.listType === "aRbs") {
      const data = c.children?.find((x) => x.type === "aRbp")?.data;
      return data ? curveSamples(data) : null;
    }
  }
  return null;
}

describe("Particular settings from a world model", () => {
  it("splits the particles into speed classes, slowest first", () => {
    const settings = particularSettings(syntheticModel(null), TARGET, null);
    expect(settings.layers.map((l) => l.name)).toEqual(["Particles (slow)", "Particles (medium)", "Particles (fast)"]);
    const velocities = settings.layers.map((l) => l.numbers.get(P.velocity)!);
    expect(velocities[0]).toBeLessThan(velocities[1]);
    expect(velocities[1]).toBeLessThan(velocities[2]);
    // The slow particles are the long-lived ones in this model.
    expect(settings.layers[0].numbers.get(P.life)!).toBeGreaterThan(settings.layers[2].numbers.get(P.life)!);
    expect(settings.layers.reduce((s, l) => s + l.share, 0)).toBeCloseTo(1, 5);
    expect(settings.mirror).toBeNull();
    expect(settings.timeFactor).toBe(1);
  });

  it("turns the emission from the stream point toward the camera", () => {
    const settings = particularSettings(syntheticModel(null), TARGET, null);
    const n = settings.layers[0].numbers;
    const direction = Mat4.rotateX(n.get(P.worldRotationX)!).mul(Mat4.rotateY(n.get(P.worldRotationY)!)).mul(Mat4.rotateZ(n.get(P.worldRotationZ)!)).transformVector([0, 0, 1]);
    // The stream point (600, 350) of 1280 × 720, framed in 1920 × 1080.
    const stream = [960 + (600 - 640) * 1.5, 540 + (350 - 360) * 1.5, 0];
    const toCamera = [960 - stream[0], 540 - stream[1], -TARGET.zoom];
    const norm = Math.hypot(...toCamera);
    for (let c = 0; c < 3; c++) expect(direction[c]).toBeCloseTo(toCamera[c] / norm, 3);
  });

  it("keeps a particle's apparent size as the model does and its opacity curve normalized", () => {
    const model = syntheticModel(null);
    const settings = particularSettings(model, TARGET, null);
    for (const layer of settings.layers) {
      const size = layer.sizeOverLife;
      expect(size[0]).toEqual([0, 1]);
      for (let k = 1; k < size.length; k++) expect(size[k][1]).toBeLessThanOrEqual(size[k - 1][1]);
      const life = layer.numbers.get(P.life)!;
      const velocity = layer.numbers.get(P.velocity)!;
      // At the end of a mean life the particle has come this far toward the camera; Particular
      // grows it by 1 / depth, the model by depth^-sizeDepth.
      const depth = 1 - Math.min(0.9, (velocity * 0.75 * life) / TARGET.zoom);
      expect(size.at(-1)![1] / depth).toBeCloseTo(depth ** -model.sizeDepth, 1);
      expect(Math.max(...layer.opacityOverLife.map(([, v]) => v))).toBeCloseTo(1, 6);
    }
  });

  it("stretches simulation time so Pre Run fills the first frame", () => {
    const normal = particularSettings(syntheticModel(null), TARGET, null);
    const slow = syntheticModel(null);
    // The clock's silent speed: half a clock second per second.
    slow.dynamics.weights[SPEED_BIAS] = Math.log(0.5);
    const stretched = particularSettings(slow, TARGET, null);
    expect(stretched.timeFactor).toBe(1);
    stretched.layers.forEach((layer, i) => {
      const n = normal.layers[i].numbers;
      expect(layer.numbers.get(P.life)! / n.get(P.life)!).toBeCloseTo(2, 2);
      expect(layer.numbers.get(P.velocity)! / n.get(P.velocity)!).toBeCloseTo(0.5, 2);
      expect(layer.numbers.get(P.rate)! / n.get(P.rate)!).toBeCloseTo(0.5, 1);
      expect(layer.sizeOverLife).toEqual(normal.layers[i].sizeOverLife);
    });
  });

  it("fits the sprites once per model: another comp size gives the numbers a fresh copy of the model gives", () => {
    const model = syntheticModel(700);
    particularSettings(model, TARGET, null);
    const small: ParticularTarget = { width: 1280, height: 720, frameRate: 25, duration: 3, zoom: 1280 / 0.72 };
    const cached = particularSettings(model, small, swingingFeatures(4));
    const fresh = particularSettings(structuredClone(model), small, swingingFeatures(4));
    expect(cached).toEqual(fresh);
    // The fit is in the class's typical size: the sprite's Size follows the comp's height.
    const full = particularSettings(model, TARGET, null);
    expect(full.layers[0].numbers.get(P.size)! / cached.layers[0].numbers.get(P.size)!).toBeCloseTo(1080 / 720, 1);
  });

  it("fits a model changed in place again", () => {
    const model = syntheticModel(null);
    const before = particularSettings(model, TARGET, null);
    // Calibration reweights the bank in place: here toward the narrower sprite.
    for (let i = 0; i < model.weights.length; i++) model.weights[i] = i % 2 ? 4 : 0.25;
    const after = particularSettings(model, TARGET, null);
    expect(after).toEqual(particularSettings(structuredClone(model), TARGET, null));
    const look = (s: typeof before) => s.layers.flatMap((l) => [P.feather, P.glowSize, P.glowOpacity].map((n) => l.numbers.get(n)));
    expect(look(after)).not.toEqual(look(before));
  });

  it("mirrors where the reference does and follows its soundtrack", () => {
    const settings = particularSettings(syntheticModel(700), TARGET, swingingFeatures(5));
    expect(settings.mirror).not.toBeNull();
    expect(settings.mirror![0]).toBeCloseTo(960 + (700 - 640) * 1.5, 6);
    const keys = settings.timeFactor as { time: number; value: number }[];
    expect(Array.isArray(keys)).toBe(true);
    expect(keys[0].time).toBe(0);
    expect(keys.at(-1)!.time).toBeCloseTo(TARGET.duration, 6);
    // A swing of ±0.5 in log speed.
    expect(Math.max(...keys.map((k) => k.value))).toBeGreaterThan(1.5);
    expect(Math.min(...keys.map((k) => k.value))).toBeLessThan(0.7);
    expect(keys.length).toBeLessThan(TARGET.duration * TARGET.frameRate);
  });
});

describe("Create Particular Layers", () => {
  const create = async (mirrorAxis: number | null) => {
    const editor = newProject();
    const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, frameRate: 30, duration: 4 });
    const original = editor.save();
    const settings = particularSettings(syntheticModel(mirrorAxis), TARGET, swingingFeatures(5));
    const ids = await createParticularLayers(editor, comp, settings);
    return { editor, comp, original, settings, ids };
  };
  const reopen = (editor: Editor, comp: CompItem) => {
    const project = Editor.fromBytes(editor.save()).project;
    const reopened = project.items.get(comp.id);
    if (reopened?.kind !== "comp") throw new Error("the comp is gone");
    return reopened;
  };

  it("writes one Particular layer per class that survives a save", async () => {
    const { editor, comp, settings, ids } = await create(null);
    expect(ids).toHaveLength(3);
    const reopened = reopen(editor, comp);
    expect(reopened.layers.map((l) => l.id)).toEqual(ids);
    reopened.layers.forEach((layer, i) => {
      const expected = settings.layers[i];
      expect(layer.name).toBe(expected.name);
      const effects = effectsOf(layer);
      expect(effects.map((e) => e.matchName)).toEqual([PARTICULAR]);
      expect(effects[0].enabled).toBe(true);
      for (const n of [P.rate, P.velocity, P.life, P.spread, P.size, P.emitterType, P.direction, P.worldRotationX, P.worldRotationY, P.worldOffsetX, P.worldOffsetY]) {
        expect(effectParam(layer, PARTICULAR, n)?.value, `parameter ${n}`).toBeCloseTo(expected.numbers.get(n)!, 4);
      }
      const color = effectParam(layer, PARTICULAR, P.color)?.value as number[];
      for (let c = 0; c < 3; c++) expect(color[c]).toBeCloseTo(expected.color[c], 2);
      const size = storedCurve(effects[0], P.sizeOverLife);
      const opacity = storedCurve(effects[0], P.opacityOverLife);
      expect(size?.[0]).toBeCloseTo(expected.sizeOverLife[0][1], 5);
      expect(size?.at(-1)).toBeCloseTo(expected.sizeOverLife.at(-1)![1], 5);
      expect(opacity?.at(-1)).toBeCloseTo(expected.opacityOverLife.at(-1)![1], 5);
      const factor = effectParam(layer, PARTICULAR, P.timeFactor)!;
      const keys = settings.timeFactor as { time: number; value: number }[];
      expect(factor.keyframes).toHaveLength(keys.length);
      expect(factor.keyframes.map((k) => k.value)).toEqual(keys.map((k) => k.value));
    });
  });

  it("adds a Mirror at the reference's axis when it is mirrored", async () => {
    const { editor, comp, settings } = await create(700);
    for (const layer of reopen(editor, comp).layers) {
      expect(effectsOf(layer).map((e) => e.matchName)).toEqual([PARTICULAR, MIRROR]);
      const center = effectParam(layer, MIRROR, 1)?.value as number[];
      expect(center[0]).toBeCloseTo(settings.mirror![0], 3);
      expect(center[1]).toBeCloseTo(settings.mirror![1], 3);
    }
  });

  it("is one undoable step", async () => {
    const { editor, original } = await create(700);
    editor.undo();
    expect(Buffer.from(editor.save()).equals(Buffer.from(original))).toBe(true);
  });
});
