// The stock After Effects effects added in src/render/effects/{colorCorrection,blurSharpen,distort,transitions,
// stylize,matte}.ts: each has a renderer with the reuse options its output allows, and the geometry and colour
// math they share (stockMath.ts) behaves as the effects describe. Their GPU passes are exercised in a browser by
// scripts/check-stock-effects.ts.
import { describe, expect, it } from "vitest";
import "../src/render/features.ts";
import {
  applyPoint,
  blackWhiteGray,
  blurrinessSigma,
  boxRadiusForSigma,
  cornerPinInverse,
  directionVector,
  geometryMatrix,
  invert,
  invert3,
  levels,
  levelsFractions,
  linearWipeEdge,
  posterize,
  project,
  projectionRange,
  squareToQuad,
  type Mat3,
} from "../src/render/effects/stockMath.ts";
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
});
