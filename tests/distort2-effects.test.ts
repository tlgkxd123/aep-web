// The Distort effects of src/render/effects/distortExtra.ts: each has a renderer with the reuse options its output
// allows (Ripple moves with the time, so it is drawn every frame), and CC Split's opening grows with Split. Their GPU
// passes are checked against After Effects by the distort2 pixel suite (gates/distort2.md).
import { describe, expect, it } from "vitest";
import "../src/render/features.ts";
import { SPLIT_REACH, splitPull } from "../src/render/effects/distortExtra.ts";
import { effectIsCacheable, effectIsScalable, effectRenderer } from "../src/render/registry.ts";

const STILL = ["ADBE Spherize", "ADBE Magnify", "CC Lens", "CC Slant", "CC Tiler", "CC Power Pin", "CC Split", "CC Split 2", "ADBE BEZMESH"];

describe("distort2 effect renderers", () => {
  it("are registered, reusable between frames and rendered at reduced resolutions", () => {
    for (const matchName of STILL) {
      expect(effectRenderer(matchName), matchName).toBeTypeOf("function");
      expect(effectIsCacheable(matchName), matchName).toBe(true);
      expect(effectIsScalable(matchName), matchName).toBe(true);
    }
  });

  it("draw Ripple, whose waves travel with the time, every frame", () => {
    expect(effectRenderer("ADBE Ripple")).toBeTypeOf("function");
    expect(effectIsCacheable("ADBE Ripple")).toBe(false);
    expect(effectIsScalable("ADBE Ripple")).toBe(true);
  });

  it("pull CC Split's sides in proportion to Split, and not at all below zero", () => {
    expect(splitPull(0)).toBe(0);
    expect(splitPull(-10)).toBe(0);
    expect(splitPull(40)).toBeCloseTo(2 * splitPull(20));
    // Split 100 pulls the middle of the line 0.6 of the distance from A to B: the tear opens where the pull reaches
    // past the line, m / (1 + m / reach) to each side.
    const m = splitPull(100);
    expect(m / (1 + m / SPLIT_REACH)).toBeCloseTo(0.6 / (1 + 0.6 / 0.86));
  });
});
