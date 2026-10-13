// The stock After Effects effects added in src/render/effects/{colorCorrection,blurSharpen,distort,transitions,
// stylize,matte,generate,displace}.ts: each has a renderer with the reuse options its output allows, popups are
// read by their choice, and the geometry, colour and noise math they share (stockMath.ts, fractal.ts) behaves as
// the effects describe. Their GPU passes are exercised in a browser by scripts/check-stock-effects.ts.
import { describe, expect, it } from "vitest";
import type { Layer, PropertyGroup } from "../src/aep/model.ts";
import "../src/render/features.ts";
import { NOISE_CELL, noiseSpace, octaveTransform } from "../src/render/effects/fractal.ts";
import {
  applyPoint,
  blackWhiteGray,
  blurrinessSigma,
  boxRadiusForSigma,
  bulgeShape,
  bulgeSource,
  cornerPinInverse,
  DisplaceChannel,
  displacementFraction,
  directionVector,
  evolutionPlanes,
  fourColorWeights,
  geometryMatrix,
  invert,
  invert3,
  levels,
  levelsFractions,
  linearWipeEdge,
  opticsBounds,
  opticsFocals,
  opticsSourceRadius,
  opticsTargetRadius,
  popupChoice,
  posterize,
  project,
  projectionRange,
  radialBlurBounds,
  squareToQuad,
  twirlTurn,
  vibrance,
  waveShape,
  type Mat3,
} from "../src/render/effects/stockMath.ts";
import { params } from "../src/render/effects/stockUtil.ts";
import { effectIsCacheable, effectIsScalable, effectRenderer } from "../src/render/registry.ts";

const STOCK = [
  "ADBE Tint",
  "ADBE Tritone",
  "ADBE Brightness & Contrast 2",
  "ADBE Brightness & Contrast",
  "ADBE Exposure2",
  "ADBE HUE SATURATION",
  "ADBE Color Balance (HLS)",
  "ADBE CHANNEL MIXER",
  "ADBE Black&White",
  "ADBE Easy Levels2",
  "ADBE Invert",
  "ADBE Posterize",
  "ADBE Threshold2",
  "ADBE Threshold",
  "ADBE Shift Channels",
  "ADBE Gaussian Blur 2",
  "ADBE Gaussian Blur",
  "ADBE Fast Blur",
  "ADBE Motion Blur",
  "ADBE Sharpen",
  "ADBE Unsharp Mask2",
  "ADBE Geometry2",
  "ADBE Offset",
  "ADBE Corner Pin",
  "ADBE Tile",
  "ADBE Linear Wipe",
  "ADBE Radial Wipe",
  "ADBE Venetian Blinds",
  "ADBE Drop Shadow",
  "ADBE Glo2",
  "ADBE Mosaic",
  "ADBE Fill",
  "ADBE Set Matte3",
  "ADBE Simple Choker",
  "ADBE Vibrance",
  "ADBE Radial Blur",
  "ADBE Fractal Noise",
  "ADBE 4ColorGradient",
  "ADBE Turbulent Displace",
  "ADBE Bulge",
  "ADBE Twirl",
  "ADBE Optics Compensation",
];

const close = (a: number[], b: number[], digits = 9) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));

describe("stock effect renderers", () => {
  it("are registered, reusable between frames and rendered at reduced resolutions", () => {
    for (const matchName of STOCK) {
      expect(effectRenderer(matchName), matchName).toBeTypeOf("function");
      expect(effectIsCacheable(matchName), matchName).toBe(true);
      expect(effectIsScalable(matchName), matchName).toBe(true);
    }
  });

  it("draw Noise anew every frame", () => {
    expect(effectRenderer("ADBE Noise2")).toBeTypeOf("function");
    expect(effectIsCacheable("ADBE Noise2")).toBe(false);
    expect(effectIsScalable("ADBE Noise2")).toBe(true);
  });

  it("draw Wave Warp (which travels with the time) and Displacement Map (which reads another layer) every frame", () => {
    for (const matchName of ["ADBE Wave Warp", "ADBE Displacement Map"]) {
      expect(effectRenderer(matchName), matchName).toBeTypeOf("function");
      expect(effectIsCacheable(matchName), matchName).toBe(false);
      expect(effectIsScalable(matchName), matchName).toBe(true);
    }
  });

  it("read popups by their choice, skipping the separators the stored value counts", () => {
    const blendMenu = ["None", "Normal", "(-", "Add", "Multiply", "Screen"];
    const popup = (value: number, options?: string[]): PropertyGroup => ({
      kind: "group",
      matchName: "ADBE Fractal Noise",
      name: "Fractal Noise",
      enabled: true,
      isEffect: true,
      children: [
        {
          kind: "property",
          matchName: "ADBE Fractal Noise-0030",
          name: "Blending Mode",
          propertyValueType: 0,
          controlType: 7,
          options,
          value,
          keyframes: [],
          expression: "",
          expressionEnabled: false,
          enabled: true,
          dimensionsSeparated: false,
          isSpatial: false,
          canVaryOverTime: true,
        },
      ],
    });
    const layer = {} as Layer;
    // The definition's own menu wins, whatever its language; the fallback menu stands in when it has none.
    expect(params(popup(4, ["Ninguno", "Normal", "(-", "Añadir"]), layer, 0).choice(30, 2, ["None", "Normal", "Add"])).toBe(3);
    expect(params(popup(5), layer, 0).choice(30, 2, blendMenu)).toBe(4);
    expect(params(popup(5), layer, 0).choice(30, 2)).toBe(5);
    expect(params(popup(5), layer, 0).choice(29, 2, blendMenu)).toBe(2);
  });
});

describe("stock effect math", () => {
  it("maps Blurriness to a Gaussian as mask feather does, and big Gaussians to boxes of the same variance", () => {
    expect(blurrinessSigma(24)).toBeCloseTo(10);
    expect(blurrinessSigma(-5)).toBe(0);
    for (const sigma of [1, 7.5, 40]) {
      const r = boxRadiusForSigma(sigma);
      expect(r * (r + 1)).toBeCloseTo(sigma * sigma);
    }
  });

  it("turns direction angles clockwise from up", () => {
    close(directionVector(0), [0, -1]);
    close(directionVector(90), [1, 0]);
    close(directionVector(135), [Math.SQRT1_2, Math.SQRT1_2]);
  });

  it("builds the Transform effect's matrix: anchor to position, scale, then clockwise rotation", () => {
    const identity = geometryMatrix([40, 30], [40, 30], 100, 100, 0, 0, 0);
    close(applyPoint(identity, [12, 7]), [12, 7]);
    const m = geometryMatrix([40, 30], [100, 50], 200, 50, 0, 0, 90);
    close(applyPoint(m, [40, 30]), [100, 50]);
    // +x from the anchor, doubled, turns to +y (down) under a 90 degree rotation.
    close(applyPoint(m, [41, 30]), [100, 52]);
    close(applyPoint(m, [40, 32]), [99, 50]);
    const back = invert(m)!;
    close(applyPoint(back, applyPoint(m, [13, -4])), [13, -4]);
    // A skew along x (axis 0) shears x by y, keeping the anchor in place.
    const skew = geometryMatrix([0, 0], [0, 0], 100, 100, 45, 0, 0);
    close(applyPoint(skew, [0, 10]), [-10, 10]);
  });

  it("pins the layer's corners where Corner Pin puts them", () => {
    const pins = [
      [10, 5],
      [130, 0],
      [0, 95],
      [110, 80],
    ];
    const forward = squareToQuad(pins[0], pins[1], pins[2], pins[3]);
    close(project(forward, [0, 0]), pins[0]);
    close(project(forward, [1, 0]), pins[1]);
    close(project(forward, [0, 1]), pins[2]);
    close(project(forward, [1, 1]), pins[3]);
    const inverse = cornerPinInverse(pins[0], pins[1], pins[2], pins[3])!;
    close(project(inverse, pins[3]), [1, 1]);
    close(project(inverse, project(forward, [0.25, 0.6])), [0.25, 0.6]);
    expect(cornerPinInverse([0, 0], [0, 0], [0, 0], [0, 0])).toBeNull();
    const m: Mat3 = [2, 0, 1, 0, 3, -2, 0, 0, 1];
    close(project(invert3(m)!, project(m, [5, 7])), [5, 7]);
  });

  it("greys colours as Black & White's sliders weight them", () => {
    const defaults = [0.4, 0.6, 0.4, 0.6, 0.2, 0.8];
    expect(blackWhiteGray([1, 1, 1], defaults)).toBeCloseTo(1);
    expect(blackWhiteGray([0, 0, 0], defaults)).toBeCloseTo(0);
    expect(blackWhiteGray([1, 0, 0], defaults)).toBeCloseTo(0.4);
    expect(blackWhiteGray([1, 1, 0], defaults)).toBeCloseTo(0.6);
    expect(blackWhiteGray([0, 0, 1], defaults)).toBeCloseTo(0.2);
    expect(blackWhiteGray([1, 0, 1], defaults)).toBeCloseTo(0.8);
    expect(blackWhiteGray([0.5, 0.5, 0.5], defaults)).toBeCloseTo(0.5);
  });

  it("reads Levels' values in 0..1 or 0..255 and applies them", () => {
    expect(levelsFractions([0, 1, 0, 1])).toEqual([0, 1, 0, 1]);
    close(levelsFractions([0, 255, 51, 255]), [0, 1, 0.2, 1]);
    expect(levels(0.3, 0, 1, 1, 0, 1)).toBeCloseTo(0.3);
    expect(levels(0.3, 0, 1, 1, 1, 0)).toBeCloseTo(0.7);
    expect(levels(0.25, 0, 1, 2, 0, 1)).toBeCloseTo(0.5);
    expect(levels(0.5, 0.2, 0.8, 1, 0, 1)).toBeCloseTo(0.5);
    expect(levels(0.1, 0.2, 0.8, 1, 0.1, 0.9)).toBeCloseTo(0.1);
    expect(levels(0.1, 0.2, 0.8, 1, 0.1, 0.9, false)).toBeCloseTo(0);
  });

  it("posterizes to evenly spaced levels", () => {
    expect([0, 0.49, 0.5, 1].map((v) => posterize(v, 2))).toEqual([0, 0, 1, 1]);
    expect([0, 0.3, 0.6, 1].map((v) => posterize(v, 3))).toEqual([0, 0, 0.5, 1]);
  });

  it("sweeps Linear Wipe's edge across the layer and its feather", () => {
    const [lo, hi] = projectionRange({ x: 0, y: 0, width: 120, height: 90 }, directionVector(90));
    close([lo, hi], [0, 120]);
    expect(linearWipeEdge(lo, hi, 0, 10)).toBeCloseTo(-10);
    expect(linearWipeEdge(lo, hi, 1, 10)).toBeCloseTo(130);
    expect(linearWipeEdge(lo, hi, 0.5, 0)).toBeCloseTo(60);
  });

  it("counts popup choices without the separators the stored value counts", () => {
    const fractalTypes = ["Basic", "(-", "Turbulent Smooth", "Turbulent Basic", "Turbulent Sharp", "(-", "Dynamic"];
    expect([1, 3, 4, 5, 7].map((v) => popupChoice(v, fractalTypes))).toEqual([1, 2, 3, 4, 5]);
    expect(popupChoice(3, [])).toBe(3);
    expect(popupChoice(9, fractalTypes)).toBe(7);
    expect(popupChoice(0, fractalTypes)).toBe(1);
  });

  it("moves through noise planes with Evolution, seamlessly round a cycle", () => {
    expect(evolutionPlanes(0, false, 1)).toEqual({ planes: [0, 1], weight: 0 });
    // One plane per 4 radians.
    const mid = evolutionPlanes((6 * 180) / Math.PI, false, 1);
    expect(mid.planes).toEqual([1, 2]);
    expect(mid.weight).toBeCloseTo(0.5, 9);
    // Either side of a plane, the noise is that plane's.
    const plane = (4 * 180) / Math.PI;
    const before = evolutionPlanes(plane - 1e-3, false, 1);
    const after = evolutionPlanes(plane + 1e-3, false, 1);
    expect(before.planes).toEqual([0, 1]);
    expect(before.weight).toBeCloseTo(1, 4);
    expect(after.planes).toEqual([1, 2]);
    expect(after.weight).toBeCloseTo(0, 4);
    // A cycle of 2 revolutions closes on a whole number of planes, and its last plane blends into the first.
    const first = evolutionPlanes(30, true, 2);
    const again = evolutionPlanes(720 + 30, true, 2);
    expect(again.planes).toEqual(first.planes);
    expect(again.weight).toBeCloseTo(first.weight, 9);
    expect(evolutionPlanes(720 - 1e-3, true, 2).planes[1]).toBe(0);
  });

  it("places Fractal Noise's cells at Offset Turbulence, Scale wide, turned clockwise", () => {
    const m = noiseSpace([60, 45], [0.5, 0.5], 0, 1);
    close(applyPoint(m, [60, 45]), [0, 0]);
    close(applyPoint(m, [60 + NOISE_CELL / 2, 45]), [1, 0]);
    // At half resolution the same layer point is at half the image pixels.
    close(applyPoint(noiseSpace([60, 45], [0.5, 0.5], 0, 0.5), [30 + NOISE_CELL / 4, 22.5]), [1, 0]);
    // Turned 90 degrees clockwise, what was above the anchor shows to its right.
    close(applyPoint(noiseSpace([0, 0], [1, 1], 90, 1), [NOISE_CELL, 0]), [0, -1]);
    const sub = octaveTransform(50, 0, [0.25, 0]);
    close(applyPoint(sub, [1, 1]), [2.25, 2]);
  });

  it("bends Optics Compensation's lens at the layer's edge and undoes it in reverse", () => {
    const focals = opticsFocals(90, 100);
    close(focals, [100, 400 / Math.PI]);
    // The half extent stays where it is either way.
    expect(opticsSourceRadius(100, focals, false)).toBeCloseTo(100);
    expect(opticsSourceRadius(100, focals, true)).toBeCloseTo(100);
    // The fisheye magnifies the middle; reversed, it shrinks it.
    expect(opticsSourceRadius(20, focals, false)).toBeLessThan(20);
    expect(opticsSourceRadius(20, focals, true)).toBeGreaterThan(20);
    // The fisheye sees nothing past a quarter turn: radius 200 at this focal length.
    expect(opticsSourceRadius(199, focals, false)).toBeLessThan(Infinity);
    expect(opticsSourceRadius(201, focals, false)).toBe(Infinity);
    for (const r of [5, 40, 90]) for (const reverse of [false, true]) expect(opticsTargetRadius(opticsSourceRadius(r, focals, reverse), focals, reverse)).toBeCloseTo(r, 6);
    const rect = { x: 0, y: 0, width: 200, height: 100 };
    const grown = opticsBounds(rect, [100, 50], opticsFocals(120, 100), true, 2);
    expect(grown.x).toBeLessThan(0);
    expect(grown.width).toBeLessThanOrEqual(400);
    expect(grown.height).toBeLessThanOrEqual(200);
    const capped = opticsBounds(rect, [100, 50], opticsFocals(170, 100), true, 2);
    close([capped.x, capped.y, capped.width, capped.height], [-100, -50, 400, 200]);
  });

  it("bulges inside the ellipse only, leaving its rim in place", () => {
    expect(bulgeShape(0)).toBeNull();
    close(bulgeSource([0.3, 0.4], 0), [0.3, 0.4]);
    close(bulgeSource([1.2, 0], 2), [1.2, 0]);
    close(bulgeSource([0.9999, 0], 2), [0.9999, 0], 3);
    const out = bulgeSource([0.3, 0.4], 2);
    const pinched = bulgeSource([0.3, 0.4], -2);
    expect(Math.hypot(out[0], out[1])).toBeLessThan(0.5);
    expect(Math.hypot(pinched[0], pinched[1])).toBeGreaterThan(0.5);
    // Moves stay radial.
    expect(out[1] / out[0]).toBeCloseTo(0.4 / 0.3);
  });

  it("twirls fully at the centre and not at all from the radius out", () => {
    expect(twirlTurn(0, 50, 90)).toBeCloseTo(Math.PI / 2);
    expect(twirlTurn(25, 50, 90)).toBeCloseTo(Math.PI / 8);
    expect(twirlTurn(50, 50, 90)).toBe(0);
    expect(twirlTurn(10, 0, 90)).toBe(0);
  });

  it("draws Wave Warp's waves with a period of one", () => {
    expect(waveShape(1, 0.25)).toBeCloseTo(1);
    expect(waveShape(2, 0.1)).toBe(1);
    expect(waveShape(2, 0.6)).toBe(-1);
    close([0, 0.25, 0.5, 0.75].map((x) => waveShape(3, x)), [0, 1, 0, -1]);
    close([0, 0.25, 0.75].map((x) => waveShape(4, x)), [0, 0.5, -0.5]);
    close([0.25, 0.75, -0.25].map((x) => waveShape(5, x)), [1, -1, -1]);
    close([0, 0.5].map((x) => waveShape(6, x)), [-1, 1]);
    close([0, 0.5].map((x) => waveShape(7, x)), [1, -1]);
  });

  it("blends 4-Color Gradient's colours by inverse distance", () => {
    const points = [
      [0, 0],
      [100, 0],
      [0, 100],
      [100, 100],
    ];
    close(fourColorWeights([50, 50], points, 100), [0.25, 0.25, 0.25, 0.25]);
    close(fourColorWeights([100, 0], points, 100), [0, 1, 0, 0]);
    const near = fourColorWeights([10, 10], points, 100);
    expect(near.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(near[0]).toBeGreaterThan(0.9);
    // Less Blend gives the nearest colour more of the pixel.
    expect(fourColorWeights([30, 30], points, 20)[0]).toBeGreaterThan(fourColorWeights([30, 30], points, 100)[0]);
  });

  it("saturates the dullest colours most with Vibrance", () => {
    close(vibrance([0.2, 0.5, 0.8], 0, 0), [0.2, 0.5, 0.8]);
    close(vibrance([0.4, 0.4, 0.4], 1, 1), [0.4, 0.4, 0.4]);
    const l = 0.299 * 0.6 + 0.587 * 0.3 + 0.114 * 0.2;
    close(vibrance([0.6, 0.3, 0.2], 0, -1), [l, l, l]);
    const dull = vibrance([0.5, 0.45, 0.45], 0.5, 0);
    const vivid = vibrance([0.9, 0.1, 0.1], 0.5, 0);
    const gain = (before: number[], after: number[]) => (after[0] - after[1]) / (before[0] - before[1]);
    expect(gain([0.5, 0.45], dull)).toBeGreaterThan(gain([0.9, 0.1], vivid));
  });

  it("reads Displacement Map's channels as moves about mid grey", () => {
    expect(displacementFraction(DisplaceChannel.RED, [0.5, 1, 0], 1)).toBeCloseTo(0);
    expect(displacementFraction(DisplaceChannel.RED, [1, 0, 0], 1)).toBeCloseTo(1);
    expect(displacementFraction(DisplaceChannel.GREEN, [1, 0, 0], 1)).toBeCloseTo(-1);
    expect(displacementFraction(DisplaceChannel.GREEN, [1, 0, 0], 0)).toBeCloseTo(0);
    expect(displacementFraction(DisplaceChannel.ALPHA, [0, 0, 0], 0)).toBeCloseTo(-1);
    expect(displacementFraction(DisplaceChannel.LUMINANCE, [1, 1, 1], 0.5)).toBeCloseTo(0.5);
    expect(displacementFraction(DisplaceChannel.LIGHTNESS, [1, 1, 1], 0)).toBeCloseTo(1);
    expect(displacementFraction(DisplaceChannel.SATURATION, [0.5, 0.5, 0.5], 1)).toBeCloseTo(-1);
    expect(displacementFraction(DisplaceChannel.HUE, [0, 1, 1], 1)).toBeCloseTo(0);
    expect([DisplaceChannel.FULL, DisplaceChannel.HALF, DisplaceChannel.OFF].map((c) => displacementFraction(c, [0, 0, 0], 1))).toEqual([1, 0, -1]);
  });

  it("grows Radial Blur's layer to what the blur sweeps", () => {
    const rect = { x: 0, y: 0, width: 100, height: 100 };
    const zoom = radialBlurBounds(rect, [50, 50], true, 0.5);
    close([zoom.x, zoom.y, zoom.width, zoom.height], [-50 / 3, -50 / 3, 400 / 3, 400 / 3]);
    const spin = radialBlurBounds(rect, [50, 50], false, Math.PI / 2);
    // A quarter turn in all takes the corners through 45 degrees either way: as far out as the half-diagonal.
    const half = 50 * Math.SQRT2;
    expect(spin.x).toBeLessThanOrEqual(50 - half + 1e-6);
    expect(spin.width).toBeGreaterThanOrEqual(2 * half - 1e-6);
    expect(spin.width).toBeLessThan(2 * half + 2);
  });
});
