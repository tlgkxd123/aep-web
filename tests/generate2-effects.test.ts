// The Generate effects added in src/render/effects/generateExtra.ts: each has a renderer reused between frames and
// drawn at reduced resolutions. Their pixels are checked against aerender by the generate2 pixel suite.
import { describe, expect, it } from "vitest";
import "../src/render/features.ts";
import { effectIsCacheable, effectIsScalable, effectRenderer } from "../src/render/registry.ts";

const GENERATE2 = ["ADBE Checkerboard", "ADBE Circle", "ADBE ELLIPSE", "ADBE Grid", "ADBE Laser", "ADBE Eyedropper Fill", "CC Light Sweep"];

describe("generate2 effect renderers", () => {
  it("are registered, reusable between frames and rendered at reduced resolutions", () => {
    for (const matchName of GENERATE2) {
      expect(effectRenderer(matchName), matchName).toBeTypeOf("function");
      expect(effectIsCacheable(matchName), matchName).toBe(true);
      expect(effectIsScalable(matchName), matchName).toBe(true);
    }
  });
});
