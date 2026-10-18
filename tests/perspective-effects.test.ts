// The Perspective and Time effects of src/render/effects/perspectiveTime.ts: each has a renderer, the Time effects
// (which read their layer at other times) are drawn anew every frame at full resolution, and the Perspective effects,
// whose output depends only on their input and parameters, are reused between frames and follow the resolution.
// Their pixels are checked against After Effects' renders by scripts/pixel-report.ts --suite perspective.
import { describe, expect, it } from "vitest";
import "../src/render/features.ts";
import { effectIsCacheable, effectIsScalable, effectRenderer } from "../src/render/registry.ts";

const TIME = ["ADBE Posterize Time", "ADBE Echo", "ADBE Difference", "ADBE Time Displacement", "CC Wide Time", "CC Force Motion Blur"];
const PERSPECTIVE = ["ADBE Radial Shadow", "CC Spotlight"];

describe("perspective and time effect renderers", () => {
  it("draw the Time effects every frame at full resolution", () => {
    for (const matchName of TIME) {
      expect(effectRenderer(matchName), matchName).toBeTypeOf("function");
      expect(effectIsCacheable(matchName), matchName).toBe(false);
      expect(effectIsScalable(matchName), matchName).toBe(false);
    }
  });

  it("reuse the Perspective effects between frames and render them at reduced resolutions", () => {
    for (const matchName of PERSPECTIVE) {
      expect(effectRenderer(matchName), matchName).toBeTypeOf("function");
      expect(effectIsCacheable(matchName), matchName).toBe(true);
      expect(effectIsScalable(matchName), matchName).toBe(true);
    }
  });
});
