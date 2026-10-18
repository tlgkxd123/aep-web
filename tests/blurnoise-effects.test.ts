// The Blur & Sharpen and Noise & Grain effects of src/render/effects/blurNoise.ts: each has a renderer with the
// reuse options its output allows. Their pixels are checked against After Effects by the blurnoise pixel suite.
import { describe, expect, it } from "vitest";
import "../src/render/features.ts";
import { effectIsCacheable, effectIsScalable, effectRenderer } from "../src/render/registry.ts";

/** Output from the layer's own pixels and parameters alone. */
const CACHEABLE = [
  "ADBE Channel Blur",
  "CC Radial Fast Blur",
  "CC Radial Blur",
  "CS CrossBlur",
  "ADBE Bilateral",
  "ADBE Smart Blur",
  "ADBE Median",
  "ADBE Dust & Scratches",
  "ADBE Camera Lens Blur",
  "ADBE AIF Perlin Noise 3D",
  "ADBE Noise HLS2",
];

/** Output that reads another layer or changes with the time itself. */
const PER_FRAME = ["ADBE Compound Blur", "CC Vector Blur", "ADBE Noise Alpha2", "ADBE Noise HLS Auto2", "VISINF Grain Implant"];

describe("blurNoise effects", () => {
  it("are registered, reusable between frames and rendered at reduced resolutions", () => {
    for (const matchName of CACHEABLE) {
      expect(effectRenderer(matchName), matchName).toBeTypeOf("function");
      expect(effectIsCacheable(matchName), matchName).toBe(true);
      expect(effectIsScalable(matchName), matchName).toBe(true);
    }
  });

  it("that read other layers or the time are drawn every frame, at reduced resolutions too", () => {
    for (const matchName of PER_FRAME) {
      expect(effectRenderer(matchName), matchName).toBeTypeOf("function");
      expect(effectIsCacheable(matchName), matchName).toBe(false);
      expect(effectIsScalable(matchName), matchName).toBe(true);
    }
  });
});
