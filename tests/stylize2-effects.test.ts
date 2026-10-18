// The Stylize effects added in src/render/effects/stylizeExtra.ts: each has a renderer with the reuse options its
// output allows, and Strobe Light strobes on the frames After Effects does. Their pixels are checked against After
// Effects renders by scripts/pixel-report.ts --suite stylize2 (gates/stylize2.md).
import { describe, expect, it } from "vitest";
import "../src/render/features.ts";
import { strobeOn } from "../src/render/effects/stylizeExtra.ts";
import { effectIsCacheable, effectIsScalable, effectRenderer } from "../src/render/registry.ts";

/** Effects whose output depends only on their input image, their parameters and the layer. */
const CACHEABLE = [
  "CC Threshold",
  "CC Threshold RGB",
  "ADBE Find Edges",
  "ADBE Emboss",
  "ADBE Color Emboss",
  "CC RepeTile",
  "CC Kaleida",
  "CS HexTile",
  "CS BlockLoad",
  "ADBE Roughen Edges",
  "ADBE Brush Strokes",
  "CC Burn Film",
];

/** Effects that follow the time itself (Strobe Light, Scatter's Randomize Every Frame) or read another layer. */
const EVERY_FRAME = ["ADBE Strobe", "ADBE Texturize", "ADBE Scatter"];

describe("stylize2 effect renderers", () => {
  it("are registered, reusable between frames and rendered at reduced resolutions", () => {
    for (const matchName of CACHEABLE) {
      expect(effectRenderer(matchName), matchName).toBeTypeOf("function");
      expect(effectIsCacheable(matchName), matchName).toBe(true);
      expect(effectIsScalable(matchName), matchName).toBe(true);
    }
  });

  it("draw the effects that follow the time or read another layer every frame", () => {
    for (const matchName of EVERY_FRAME) {
      expect(effectRenderer(matchName), matchName).toBeTypeOf("function");
      expect(effectIsCacheable(matchName), matchName).toBe(false);
      expect(effectIsScalable(matchName), matchName).toBe(true);
    }
  });
});

describe("Strobe Light timing", () => {
  const fps = 25;
  const pattern = (duration: number, period: number, frames: number) =>
    Array.from({ length: frames }, (_, f) => (strobeOn((f + 0.5) / fps, duration / fps, period / fps) ? "#" : ".")).join("");

  it("strobes from the start of each period until Strobe Duration before its end", () => {
    expect(pattern(2, 4, 12)).toBe("##..##..##..");
    expect(pattern(1, 4, 12)).toBe("###.###.###.");
    expect(pattern(3, 6, 12)).toBe("###...###...");
  });

  it("never strobes with no period, and always strobes with no duration", () => {
    expect(pattern(2, 0, 6)).toBe("......");
    expect(pattern(0, 4, 6)).toBe("######");
  });

  it("rounds Duration and Period to 1/10000 s, which decides the frames on the boundaries", () => {
    expect(strobeOn(0.49998, 0.250049, 0.75)).toBe(true);
    expect(strobeOn(0.49998, 0.250051, 0.75)).toBe(false);
  });
});
