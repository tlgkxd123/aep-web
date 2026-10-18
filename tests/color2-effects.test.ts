// The Color Correction effects of src/render/effects/colorExtra.ts: each has a renderer with its reuse options,
// and the per-pixel models the shaders follow (colorExtraMath.ts) reproduce values read from After Effects' probe
// renders (refs/fixtures/color2.probe.aep). Their pixels are checked against After Effects by the color2 pixel suite.
import { describe, expect, it } from "vitest";
import "../src/render/features.ts";
import { effectIsCacheable, effectIsScalable, effectRenderer } from "../src/render/registry.ts";
import { COLOR2_EFFECTS } from "../src/render/effects/colorExtra.ts";
import {
  BALANCE_TOE_SLOPE,
  balancePow,
  blackStretch,
  changeToColorMatte,
  colorBalanceChannel,
  colorBalanceSliders,
  COLORAMA_MODIFY,
  COLORAMA_PHASE_SCALE,
  coloramaModify,
  cycleAt,
  neutralizerWeights,
  photoFilterMatrix,
} from "../src/render/effects/colorExtraMath.ts";
import type { Params } from "../src/render/effects/stockUtil.ts";

function fakeParams(values: Record<number, number | number[]>): Params {
  const num = (i: number, f: number) => (typeof values[i] === "number" ? (values[i] as number) : f);
  return {
    num,
    vec: (i, f) => (Array.isArray(values[i]) ? (values[i] as number[]) : f),
    bool: (i, f) => num(i, f ? 1 : 0) !== 0,
    rgb: (i, f) => (Array.isArray(values[i]) ? (values[i] as [number, number, number]) : f),
    choice: (i, f) => num(i, f),
  };
}

const to8 = (v: number) => Math.round(v * 255);

describe("color2 effects", () => {
  it("registers every effect as cacheable and scalable", () => {
    expect(COLOR2_EFFECTS.length).toBeGreaterThan(0);
    for (const matchName of COLOR2_EFFECTS) {
      expect(effectRenderer(matchName), matchName).toBeTypeOf("function");
      expect(effectIsCacheable(matchName), matchName).toBe(true);
      expect(effectIsScalable(matchName), matchName).toBe(true);
    }
  });

  it("Color Balance applies the stretches, then the product of the highlight, midtone and shadow powers", () => {
    expect(colorBalanceChannel(0.4, 0, 0, 0)).toBeCloseTo(0.4, 6);
    // probe frame 8: shadow R +30, midtone R +50, highlight R +20; midtone B -70, highlight B +80
    expect(to8(colorBalanceChannel(174 / 255, 0.3, 0.5, 0.2))).toBe(213);
    expect(to8(colorBalanceChannel(174 / 255, 0, -0.7, 0.8))).toBe(255);
  });

  it("Color Balance's powers below 1 turn into a parabola where their slope reaches the toe slope", () => {
    // probe frame 53 (midtone R +100): After Effects gives 16, 30 and 55 for 4, 8 and 16, not sqrt's 32, 45 and 64
    expect([4, 8, 16].map((v) => to8(balancePow(v / 255, 0.5)))).toEqual([16, 31, 56]);
    const x0 = (BALANCE_TOE_SLOPE / 0.5) ** (1 / (0.5 - 1));
    expect(balancePow(x0 - 1e-9, 0.5)).toBeCloseTo(Math.sqrt(x0), 6);
    expect(balancePow(0, 0.5)).toBe(0);
    expect(balancePow(0.2, 1.4)).toBeCloseTo(0.2 ** 1.4, 9);
  });

  it("Color Balance's Preserve Luminosity shifts each range and drops the shadow and highlight powers", () => {
    const sliders = colorBalanceSliders(fakeParams({ 1: 50, 4: 30, 8: -20, 9: 40, 10: 1 }));
    expect(sliders.map((v) => +v.toFixed(3))).toEqual([0, -0.5, -0.5, 0.15, -0.15, -0.15, 0.2, 0, 0.6]);
    // probe3 frame 2: highlight R +50 with Preserve Luminosity takes red 51 to 63
    expect(Math.abs(colorBalanceChannel(51 / 255, 0, 0, 0.5, true) * 255 - 63)).toBeLessThan(1);
  });

  it("Gamma/Pedestal/Gain's black stretch leaves values alone at 1", () => {
    for (const v of [0, 0.2, 0.45, 0.8]) expect(blackStretch(v, 1)).toBe(v);
  });

  it("Photo Filter is the identity at zero density", () => {
    const m = photoFilterMatrix(fakeParams({ 1: 1, 3: 0 }));
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(m[i]).toBeCloseTo(v, 4));
  });

  it("Color Neutralizer's range weights partition unity between its black and white points", () => {
    for (const mean of [0, 0.2, 0.5, 0.7, 1]) {
      const w = neutralizerWeights(mean);
      expect(w[0] + w[1] + w[2]).toBeCloseTo(1, 6);
    }
    expect(neutralizerWeights(0)[0]).toBe(1);
    expect(neutralizerWeights(1)[2]).toBe(1);
    // probe4 frame 6: black point 20 % puts grey 121 at a shadow weight of 0.237
    expect(neutralizerWeights(121 / 255, 0.2, 1)[0]).toBeCloseTo(0.237, 2);
  });

  it("Change To Color's matte ramps over softness from the summed tolerance distances", () => {
    expect(changeToColorMatte(0.04, 0.4, 0.6, [0.1, 1, 1], 0)).toBe(1);
    expect(changeToColorMatte(0.049, 0.4, 0.6, [0.1, 1, 1], 0)).toBe(0);
    expect(changeToColorMatte(0.051, 0, 0, [0.1, 1, 1], 0)).toBe(0);
    // probe frame 48, cell 26: matte 0.784
    expect(changeToColorMatte(0.0267, 0.11, 0.474, [0.1, 1, 1], 0.5)).toBeCloseTo(0.784, 2);
  });

  it("Colorama picks the nearest entry without interpolation and modifies the chosen components", () => {
    const cycle = [
      { at: 0, rgba: [1, 0, 0, 1] as [number, number, number, number] },
      { at: 0.5, rgba: [0, 0, 1, 1] as [number, number, number, number] },
    ];
    expect(cycleAt(cycle, 0.2, false)).toEqual([1, 0, 0, 1]);
    expect(cycleAt(cycle, 0.3, false)).toEqual([0, 0, 1, 1]);
    expect(cycleAt(cycle, 0.25, true)).toEqual([0.5, 0, 0.5, 1]);
    expect(COLORAMA_PHASE_SCALE).toBeLessThan(1);
    expect(coloramaModify(COLORAMA_MODIFY[2], [0.1, 0.2, 0.3], [0.9, 0.8, 0.7])).toEqual([0.9, 0.2, 0.3]);
    expect(coloramaModify(COLORAMA_MODIFY[14], [0.1, 0.2, 0.3], [0.9, 0.8, 0.7])).toEqual([0.1, 0.2, 0.3]);
  });
});
