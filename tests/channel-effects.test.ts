// The Channel and Utility effects of src/render/effects/channelUtility.ts: each has a renderer with the reuse options
// its output allows. Their GPU passes are checked against aerender by the channel pixel suite (gates/channel.md).
import { describe, expect, it } from "vitest";
import "../src/render/features.ts";
import { effectIsCacheable, effectIsScalable, effectRenderer } from "../src/render/registry.ts";

/** Effects whose output depends only on their input image and parameters. */
const PURE = ["ADBE Arithmetic", "ADBE Solid Composite", "ADBE GROW BOUNDS", "ADBE Cineon Converter2", "CC Overbrights", "ADBE Compander", "ADBE HDR ToneMap"];

/** Effects that read other layers, or the layer's own source under its masks and effects. */
const LAYER_READING = ["ADBE Set Channels", "ADBE Channel Combiner", "ADBE Compound Arithmetic", "ADBE Blend", "ADBE Calculations", "CC Composite"];

describe("channel and utility effect renderers", () => {
  it("are reusable between frames when they read only their input, and rendered at reduced resolutions", () => {
    for (const matchName of PURE) {
      expect(effectRenderer(matchName), matchName).toBeTypeOf("function");
      expect(effectIsCacheable(matchName), matchName).toBe(true);
      expect(effectIsScalable(matchName), matchName).toBe(true);
    }
  });

  it("draw anew every frame when they read another layer or the layer's source", () => {
    for (const matchName of LAYER_READING) {
      expect(effectRenderer(matchName), matchName).toBeTypeOf("function");
      expect(effectIsCacheable(matchName), matchName).toBe(false);
      expect(effectIsScalable(matchName), matchName).toBe(true);
    }
  });
});
