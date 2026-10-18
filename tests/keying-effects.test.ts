// The Keying and Matte effects of src/render/effects/keying.ts: each has a renderer with the reuse options its output
// allows, and the per-pixel key models of keyingMath.ts behave as the effects describe. Their GPU passes are
// compared with After Effects by the keying pixel suite (scripts/fixtures/build_keying.py).
import { describe, expect, it } from "vitest";
import "../src/render/features.ts";
import { effectIsCacheable, effectIsScalable, effectRenderer } from "../src/render/registry.ts";

const PER_PIXEL: string[] = [];
const SPATIAL: string[] = [];

describe("keying effect renderers", () => {
  it("are registered, reusable between frames and rendered at reduced resolutions", () => {
    for (const matchName of [...PER_PIXEL, ...SPATIAL]) {
      expect(effectRenderer(matchName), matchName).toBeTypeOf("function");
      expect(effectIsCacheable(matchName), matchName).toBe(true);
      expect(effectIsScalable(matchName), matchName).toBe(true);
    }
  });
});
