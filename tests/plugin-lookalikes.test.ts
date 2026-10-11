// The Sapphire look-alikes (S_Blur, S_BlurDirectional, S_Shake, S_Glow, S_ZGlow, S_Flicker) and the Trapcode Form
// look-alike: how they are registered and skipped, the parameter math they share, and Form's settings read by
// parameter name. Their GPU passes are exercised in a browser by scripts/check-plugin-lookalikes.ts.
import { describe, expect, it } from "vitest";
import type { Layer, Property, PropertyGroup, PropertyValue } from "../src/aep/model.ts";
import { effectCategory } from "../src/edit/effectCatalog.ts";
import "../src/render/features.ts";
import { FormBase, FormBlend, formLayout, formSettings, formVisibility, MAX_FORM_PARTICLES } from "../src/render/effects/formSettings.ts";
import { namedParams, normalizeName } from "../src/render/effects/namedParams.ts";
import {
  blurKernel,
  channelGroups,
  directionalKernel,
  Filter,
  flickerGains,
  MAX_Z_SLICES,
  screenDirection,
  zSliceCount,
  zSliceWeight,
  type FlickerParams,
} from "../src/render/effects/sapphireMath.ts";
import { effectIsCacheable, effectIsScalable, effectRenderer, type LayerImage, type RenderContext } from "../src/render/registry.ts";

interface Param {
  name: string;
  value: PropertyValue;
  controlType?: number;
  options?: string[];
}

function effect(matchName: string, params: Param[]): PropertyGroup {
  const children: Property[] = params.map((p, i) => ({
    kind: "property",
    matchName: `${matchName}-${String(i + 1).padStart(4, "0")}`,
    name: p.name,
    propertyValueType: 0,
    controlType: p.controlType,
    options: p.options,
    value: p.value,
    keyframes: [],
    expression: "",
    expressionEnabled: false,
    enabled: true,
    dimensionsSeparated: false,
    isSpatial: false,
    canVaryOverTime: true,
  }));
  return { kind: "group", matchName, name: matchName, enabled: true, isEffect: true, children };
}

const topic = (name: string, params: Param[]): Param[] => [{ name, value: null, controlType: 13 }, ...params, { name: "", value: null, controlType: 14 }];
const popup = (name: string, options: string[], value: number): Param => ({ name, value, controlType: 7, options });
const layer = {} as Layer;

const SAPPHIRE = ["S_Blur", "S_BlurDirectional", "S_Shake", "S_Glow", "S_ZGlow", "S_Flicker"];

describe("Sapphire look-alikes", () => {
  it("are registered, with the reuse options their output allows", () => {
    for (const matchName of SAPPHIRE) expect(effectRenderer(matchName), matchName).toBeTypeOf("function");
    expect(["S_Blur", "S_BlurDirectional", "S_Glow"].filter(effectIsCacheable)).toEqual(["S_Blur", "S_BlurDirectional", "S_Glow"]);
    // S_Shake and S_Flicker change with the time itself; S_ZGlow reads another layer.
    expect(["S_Shake", "S_Flicker", "S_ZGlow"].filter(effectIsCacheable)).toEqual([]);
    expect(SAPPHIRE.filter(effectIsScalable)).toEqual(["S_Blur", "S_BlurDirectional", "S_Glow", "S_ZGlow", "S_Flicker"]);
  });

  it("are skipped, as After Effects skips them, unless the look-alikes are switched on", () => {
    for (const matchName of SAPPHIRE) {
      const warnings: string[] = [];
      const ctx = { options: { approximateMissingPlugins: true, sapphireLookalikes: false }, warn: (m: string) => warnings.push(m) } as unknown as RenderContext;
      const input = { width: 1, height: 1, origin: [0, 0] } as unknown as LayerImage;
      expect(effectRenderer(matchName)!(input, effect(matchName, []), layer, 0, ctx)).toBe(input);
      expect(warnings).toEqual([`Sapphire ${matchName} plugin is not installed; After Effects skips it`]);
    }
  });

  it("share a variance between filters, so the filter changes the falloff and not the size", () => {
    expect(blurKernel(10, Filter.GAUSS)).toEqual({ sigma: 5, reach: 15 });
    expect(blurKernel(10, Filter.BOX).reach).toBeCloseTo(Math.sqrt(3) * 5);
    expect(blurKernel(-4, Filter.TRIANGLE)).toEqual({ sigma: 0, reach: 0 });
  });

  it("blur each distinct channel width once", () => {
    expect(channelGroups([2, 2, 2])).toEqual([{ width: 2, channels: [true, true, true] }]);
    expect(channelGroups([1, 3, 1])).toEqual([
      { width: 1, channels: [true, false, true] },
      { width: 3, channels: [false, true, false] },
    ]);
  });

  it("cut S_ZGlow's depth into at most a few slices whose weights sum to one", () => {
    expect(zSliceCount(50)).toBe(MAX_Z_SLICES);
    expect(zSliceCount(0)).toBe(2);
    for (const z of [0, 0.13, 0.5, 0.77, 1]) {
      const n = zSliceCount(5);
      const total = Array.from({ length: n }, (_, k) => zSliceWeight(k, n, z)).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo(1);
    }
    expect(zSliceWeight(0, 5, 0)).toBe(1);
    expect(zSliceWeight(4, 5, 1)).toBe(1);
  });

  it("flicker by Brightness, Amplitude per channel, random luma and the wave", () => {
    const still: FlickerParams = {
      amplitude: 0,
      lumaAmp: 1,
      colorAmp: 1,
      frequency: 6,
      waveAmp: 1,
      waveFreq: 2,
      wavePhase: [0, 0, 0],
      channelAmp: [1, 1, 1],
      brightness: 1.5,
      seed: 0,
    };
    expect(flickerGains(still, 0.37)).toEqual([1.5, 1.5, 1.5]);
    const wave = { ...still, amplitude: 0.5, lumaAmp: 0, colorAmp: 0, brightness: 1, wavePhase: [0.25, 0, 0.75] as [number, number, number] };
    const [r, g, b] = flickerGains(wave, 0);
    expect(r).toBeCloseTo(1.5);
    expect(g).toBeCloseTo(1);
    expect(b).toBeCloseTo(0.5);
    const random = { ...still, amplitude: 1, waveAmp: 0, colorAmp: 0, brightness: 1 };
    const gains = [0.1, 0.4, 0.9].map((t) => flickerGains(random, t)[0]);
    expect(new Set(gains).size).toBe(3);
    expect(flickerGains(random, 0.4)).toEqual(flickerGains(random, 0.4));
  });

  it("trail S_BlurDirectional to one side by Bias and move it by Shift", () => {
    expect(directionalKernel(10, Filter.GAUSS, 0.5, 0).center).toBe(0);
    expect(directionalKernel(10, Filter.GAUSS, 1, 0).center).toBe(15);
    expect(directionalKernel(10, Filter.GAUSS, 0, 4).center).toBe(-11);
    const [x, y] = screenDirection(90);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(-1);
  });
});

describe("parameters by name", () => {
  const fx = effect("tc Test", [
    ...topic("Base Form", [{ name: "X Rotation", value: 10 }, popup("Base Form", ["Box - Grid", "Sphere - Layered"], 2)]),
    ...topic("World Transform", [{ name: "X Rotation", value: 45 }, { name: "Color", value: [1, 0.5, 0.25, 1] }]),
    ...topic("Disperse & Twist", [{ name: "Twist", value: 3 }]),
  ]);
  const p = namedParams(fx, layer, 0);

  it("are told apart by their topic", () => {
    expect(p.num(["Base Form"], ["X Rotation"], 0)).toBe(10);
    expect(p.num(["World Transform"], ["X Rotation"], 0)).toBe(45);
    expect(p.num(null, ["X Rotation"], 0)).toBe(10);
    expect(p.num(["Particle"], ["X Rotation"], -1)).toBe(-1);
  });

  it("match ignoring case, punctuation and & against and", () => {
    expect(normalizeName("Disperse & Twist")).toBe(normalizeName("disperse and twist"));
    expect(p.num(["Disperse and Twist"], ["twist"], 0)).toBe(3);
    expect(p.num(null, ["Missing", "TWIST"], 0)).toBe(3);
  });

  it("give vectors and popup labels", () => {
    expect(p.vec(null, ["Color"], [0])).toEqual([1, 0.5, 0.25, 1]);
    expect(p.option(["Base Form"], ["Base Form"])).toBe("spherelayered");
    expect(p.option(null, ["Nothing"])).toBeUndefined();
  });
});

describe("Trapcode Form look-alike", () => {
  it("is registered as a Trapcode effect, drawn every frame at full resolution", () => {
    expect(effectRenderer("tc Form")).toBeTypeOf("function");
    expect(effectIsCacheable("tc Form")).toBe(false);
    expect(effectIsScalable("tc Form")).toBe(false);
    expect(effectCategory("tc Form")).toBe("RG Trapcode");
  });

  const formEffect = (base: number, more: Param[] = []) =>
    effect("tc Form", [
      ...topic("Base Form", [
        popup("Base Form", ["Box - Grid", "Box - Strings", "Sphere - Layered", "OBJ Model"], base),
        { name: "Size X", value: 400 },
        { name: "Size Y", value: 300 },
        { name: "Size Z", value: 20 },
        { name: "Particles in X", value: 50 },
        { name: "Particles in Y", value: 40 },
        { name: "Particles in Z", value: 2 },
        { name: "Sphere Layers", value: 3 },
        { name: "Center XY", value: [100, 200] },
        { name: "Center Z", value: 50 },
        { name: "Y Rotation", value: 30 },
      ]),
      ...topic("Particle", [
        popup("Particle Type", ["Sphere", "Glow Sphere (No DOF)"], 2),
        { name: "Size", value: 6 },
        { name: "Opacity", value: 80 },
        { name: "Sphere Feather", value: 20 },
        popup("Transfer Mode", ["Normal", "Add", "Screen", "Lighten", "Multiply"], 2),
      ]),
      ...topic("Fractal Field", [popup("Displacement Mode", ["XYZ Linked", "XYZ Individual"], 1), { name: "Displace", value: 25 }, { name: "Y Displace", value: 5 }]),
      ...topic("World Transform", [{ name: "Y Rotation", value: -15 }, { name: "Z Offset", value: 100 }]),
      ...more,
    ]);

  it("reads its settings by name", () => {
    const s = formSettings(namedParams(formEffect(1), layer, 0), [1920, 1080]);
    expect(s.base).toBe(FormBase.GRID);
    expect(s.size).toEqual([400, 300, 20]);
    expect(s.count).toEqual([50, 40, 2]);
    expect(s.center).toEqual([100, 200, 50]);
    expect(s.rotation).toEqual([0, 30, 0]);
    expect(s.world).toEqual({ rotation: [0, -15, 0], offset: [0, 0, 100] });
    expect(s.particleSize).toBe(6);
    expect(s.opacity).toBeCloseTo(0.8);
    expect(s.feather).toBeCloseTo(0.2);
    expect(s.glow).toBe(true);
    expect(s.blend).toBe(FormBlend.ADD);
    // XYZ Linked displaces every axis by Displace.
    expect(s.fractal.displace).toEqual([25, 25, 25]);
    expect(s.unsupported).toEqual([]);
  });

  it("lays out spheres by Sphere Layers and draws other base forms as a grid, with a note", () => {
    const sphere = formSettings(namedParams(formEffect(3), layer, 0), [1920, 1080]);
    expect(sphere.base).toBe(FormBase.SPHERE);
    expect(sphere.count).toEqual([50, 40, 3]);
    const obj = formSettings(namedParams(formEffect(4), layer, 0), [1920, 1080]);
    expect(obj.base).toBe(FormBase.GRID);
    expect(obj.unsupported).toEqual(["the base form is drawn as a grid"]);
  });

  it("falls back to Form's defaults, centred in the comp, when parameters are missing", () => {
    const s = formSettings(namedParams(effect("tc Form", []), layer, 0), [1280, 720]);
    expect(s.base).toBe(FormBase.GRID);
    expect(s.center).toEqual([640, 360, 0]);
    expect(s.blend).toBe(FormBlend.NORMAL);
    expect(s.opacity).toBe(1);
  });

  it("draws strings as dense lines and thins out forms of too many particles", () => {
    const strings = formLayout(formSettings(namedParams(formEffect(2), layer, 0), [1920, 1080]));
    // 400 px long strings of particles 6 px wide: one every 3 px.
    expect(strings.count).toEqual([134, 40, 2]);
    expect(strings.stride).toBe(1);
    const huge = formSettings(namedParams(formEffect(1), layer, 0), [1920, 1080]);
    huge.count = [2000, 2000, 2];
    const layout = formLayout(huge);
    expect(layout.total).toBe(8_000_000);
    expect(layout.stride).toBe(4);
    expect(layout.drawn).toBeLessThanOrEqual(MAX_FORM_PARTICLES);
  });

  it("fades particles in and out by Visibility", () => {
    const v = { nearVanish: 10, nearFade: 110, farFade: 1000, farVanish: 2000 };
    expect(formVisibility(v, 5)).toBe(0);
    expect(formVisibility(v, 60)).toBeCloseTo(0.5);
    expect(formVisibility(v, 500)).toBe(1);
    expect(formVisibility(v, 1500)).toBeCloseTo(0.5);
    expect(formVisibility(v, 2500)).toBe(0);
  });
});
