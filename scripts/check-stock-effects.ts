// Renders every stock effect renderer of src/render/effects/{colorCorrection,blurSharpen,distort,transitions,
// stylize,matte,generate,displace}.ts on a fixture layer in headless Chrome (any WebGL2, SwiftShader included): each must compile and
// draw without errors or "not rendered" warnings, change the frame when its parameters say so, and the per-pixel
// colour effects must match their formulas on the unchanged frame; at half resolution each must stay close to the
// full-resolution frame averaged down (parameters in layer pixels follow the scale). Not a comparison with After
// Effects.
//
// With --out, each frame is written there as <case>.png (base.png without the effect).
//
//   node scripts/check-stock-effects.ts [--chrome <path>] [--no-build] [--only name,name] [--out dir]
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { blackWhiteGray, levels, vibrance } from "../src/render/effects/stockMath.ts";
import { encodePng } from "./lib/png.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const only = option("--only")?.split(",");
const outDir = option("--out");
if (outDir) mkdirSync(outDir, { recursive: true });
const PROJECT = resolve("refs/fixtures/roundtrip.base.aep");
const COMP = "roundtrip_cs_vignette";
const LAYER = "roundtrip_card";

type Values = Record<number, number | number[]>;
type Rgba = [number, number, number, number];
/**
 * Mean error (of 255) allowed between the half-resolution frame and the full one averaged down, as a multiple of
 * that error without an effect (the fixture's hard edges alone give a few levels; contrast effects amplify them).
 */
const SCALE_ERROR_RATIO = 2;

/** Expected straight RGB (0..1) of an opaque pixel from its colour before the effect. */
type Expect = (rgb: [number, number, number]) => [number, number, number];

interface Case {
  name: string;
  matchName: string;
  values: Values;
  /** The parameters leave the frame as it was. */
  identity?: boolean;
  expect?: Expect;
  /** Samples single pixels that differ at another resolution by design (noise, sharp mosaic, small tiles). */
  noScaleCheck?: boolean;
}

const luma = ([r, g, b]: number[]) => 0.299 * r + 0.587 * g + 0.114 * b;
const cases: Case[] = [
  { name: "tint", matchName: "ADBE Tint", values: { 1: [0, 0, 0, 1], 2: [1, 1, 1, 1], 3: 100 }, expect: (c) => [luma(c), luma(c), luma(c)] },
  { name: "tint_zero", matchName: "ADBE Tint", values: { 1: [1, 0, 0, 1], 2: [0, 0, 1, 1], 3: 0 }, identity: true },
  { name: "tritone", matchName: "ADBE Tritone", values: { 1: [1, 1, 1, 1], 2: [0.8, 0.4, 0.1, 1], 3: [0, 0, 0, 1], 4: 0 } },
  { name: "brightness_contrast", matchName: "ADBE Brightness & Contrast 2", values: { 1: 30, 2: 20, 3: 0 } },
  { name: "brightness_contrast_legacy", matchName: "ADBE Brightness & Contrast", values: { 1: 0, 2: 0 }, identity: true },
  { name: "exposure", matchName: "ADBE Exposure2", values: { 1: 1, 3: 1, 4: 0, 5: 1, 22: 0 } },
  { name: "exposure_bypass_identity", matchName: "ADBE Exposure2", values: { 1: 1, 3: 0, 4: 0, 5: 1, 22: 1 }, identity: true },
  { name: "hue_saturation", matchName: "ADBE HUE SATURATION", values: { 2: 1, 4: 120, 5: 0, 6: 0, 7: 0 }, expect: ([r, g, b]) => [b, r, g] },
  { name: "hue_saturation_colorize", matchName: "ADBE HUE SATURATION", values: { 2: 1, 7: 1, 8: 200, 9: 60, 10: 0 } },
  { name: "color_balance_hls", matchName: "ADBE Color Balance (HLS)", values: { 1: -120, 2: 0, 3: 0 }, expect: ([r, g, b]) => [g, b, r] },
  { name: "channel_mixer", matchName: "ADBE CHANNEL MIXER", values: { 1: 0, 2: 100, 3: 0, 4: 0, 5: 0, 6: 0, 7: 100, 8: 0, 9: 100, 10: 0, 11: 0, 12: 0, 13: 0 }, expect: ([r, g, b]) => [g, b, r] },
  {
    name: "black_white",
    matchName: "ADBE Black&White",
    values: { 1: 40, 2: 60, 3: 40, 4: 60, 5: 20, 6: 80, 7: 0 },
    expect: (c) => {
      const g = blackWhiteGray(c, [0.4, 0.6, 0.4, 0.6, 0.2, 0.8]);
      return [g, g, g];
    },
  },
  { name: "levels", matchName: "ADBE Easy Levels2", values: { 1: 1, 3: 0, 4: 1, 5: 1, 6: 0, 7: 1, 8: 1, 9: 1 }, identity: true },
  { name: "levels_8bpc", matchName: "ADBE Easy Levels2", values: { 1: 1, 3: 0, 4: 255, 5: 1, 6: 255, 7: 0, 8: 1, 9: 1 }, expect: (c) => c.map((v) => levels(v, 0, 1, 1, 1, 0)) as [number, number, number] },
  { name: "levels_gamma", matchName: "ADBE Easy Levels2", values: { 1: 1, 3: 0.1, 4: 0.9, 5: 2, 6: 0.05, 7: 0.95, 8: 1, 9: 1 }, expect: (c) => c.map((v) => levels(v, 0.1, 0.9, 2, 0.05, 0.95)) as [number, number, number] },
  { name: "invert", matchName: "ADBE Invert", values: { 1: 1, 2: 0 }, expect: ([r, g, b]) => [1 - r, 1 - g, 1 - b] },
  { name: "invert_hue", matchName: "ADBE Invert", values: { 1: 6, 2: 0 } },
  { name: "invert_yiq", matchName: "ADBE Invert", values: { 1: 9, 2: 0 } },
  { name: "posterize", matchName: "ADBE Posterize", values: { 1: 2 }, expect: (c) => c.map((v) => (v >= 0.5 ? 1 : 0)) as [number, number, number] },
  { name: "threshold", matchName: "ADBE Threshold2", values: { 1: 128 }, expect: (c) => (luma(c) * 255 >= 128 ? [1, 1, 1] : [0, 0, 0]) },
  { name: "shift_channels", matchName: "ADBE Shift Channels", values: { 1: 1, 2: 3, 3: 4, 4: 2 }, expect: ([r, g, b]) => [g, b, r] },
  { name: "gaussian_blur", matchName: "ADBE Gaussian Blur 2", values: { 1: 12, 2: 1, 3: 0 } },
  { name: "gaussian_blur_large", matchName: "ADBE Gaussian Blur 2", values: { 1: 90, 2: 2, 3: 1 } },
  { name: "gaussian_blur_legacy", matchName: "ADBE Gaussian Blur", values: { 1: 6, 2: 3 } },
  { name: "fast_blur", matchName: "ADBE Fast Blur", values: { 1: 6, 2: 1, 3: 1 } },
  { name: "directional_blur", matchName: "ADBE Motion Blur", values: { 1: 45, 2: 20 } },
  { name: "sharpen", matchName: "ADBE Sharpen", values: { 1: 60 } },
  { name: "unsharp_mask", matchName: "ADBE Unsharp Mask2", values: { 1: 150, 2: 3, 3: 0 } },
  { name: "transform", matchName: "ADBE Geometry2", values: { 1: [60, 45], 2: [70, 40], 11: 1, 3: 80, 4: 80, 5: 10, 6: 0, 7: 30, 8: 80, 9: 1, 10: 0, 12: 1 } },
  { name: "transform_identity", matchName: "ADBE Geometry2", values: { 1: [60, 45], 2: [60, 45], 11: 1, 3: 100, 4: 100, 5: 0, 6: 0, 7: 0, 8: 100 }, identity: true },
  { name: "offset", matchName: "ADBE Offset", values: { 1: [90, 60], 2: 0 } },
  { name: "corner_pin", matchName: "ADBE Corner Pin", values: { 1: [10, 5], 2: [130, 0], 3: [0, 95], 4: [110, 80] } },
  { name: "corner_pin_identity", matchName: "ADBE Corner Pin", values: { 1: [0, 0], 2: [120, 0], 3: [0, 90], 4: [120, 90] }, identity: true },
  { name: "motion_tile", matchName: "ADBE Tile", values: { 1: [60, 45], 2: 50, 3: 50, 4: 150, 5: 150, 6: 1, 7: 90, 8: 0 }, noScaleCheck: true },
  { name: "linear_wipe", matchName: "ADBE Linear Wipe", values: { 1: 50, 2: 90, 3: 10 } },
  { name: "radial_wipe", matchName: "ADBE Radial Wipe", values: { 1: 40, 2: 30, 3: [60, 45], 4: 3, 5: 5 } },
  { name: "venetian_blinds", matchName: "ADBE Venetian Blinds", values: { 1: 50, 2: 30, 3: 12, 4: 2 } },
  { name: "drop_shadow", matchName: "ADBE Drop Shadow", values: { 1: [0, 0, 0, 1], 2: 200, 3: 135, 4: 12, 5: 10, 6: 0 } },
  { name: "drop_shadow_only", matchName: "ADBE Drop Shadow", values: { 1: [1, 0, 0, 1], 2: 255, 3: 45, 4: 6, 5: 0, 6: 1 } },
  { name: "glow", matchName: "ADBE Glo2", values: { 1: 2, 2: 100, 3: 15, 4: 1.5, 5: 2, 6: 3, 7: 1, 14: 1 } },
  { name: "glow_ab", matchName: "ADBE Glo2", values: { 1: 1, 2: 50, 3: 10, 4: 1, 5: 1, 6: 6, 7: 2, 12: [1, 1, 0, 1], 13: [1, 0, 0, 1], 14: 2 } },
  { name: "mosaic", matchName: "ADBE Mosaic", values: { 1: 8, 2: 6, 3: 0 } },
  { name: "mosaic_sharp", matchName: "ADBE Mosaic", values: { 1: 5, 2: 5, 3: 1 }, noScaleCheck: true },
  { name: "noise", matchName: "ADBE Noise2", values: { 1: 40, 2: 1, 3: 1 }, noScaleCheck: true },
  { name: "fill", matchName: "ADBE Fill", values: { 1: 0, 7: 0, 2: [0, 1, 0, 1], 6: 0, 5: 1 }, expect: () => [0, 1, 0] },
  { name: "set_matte_self_luma", matchName: "ADBE Set Matte3", values: { 1: 0, 2: 5, 3: 0, 4: 1, 5: 1, 6: 1 } },
  { name: "simple_choker", matchName: "ADBE Simple Choker", values: { 1: 1, 2: 4 } },
  { name: "simple_choker_spread", matchName: "ADBE Simple Choker", values: { 1: 1, 2: -20 } },
  { name: "vibrance", matchName: "ADBE Vibrance", values: { 1: 60, 2: 20 }, expect: (c) => vibrance(c, 0.6, 0.2) },
  { name: "vibrance_identity", matchName: "ADBE Vibrance", values: { 1: 0, 2: 0 }, identity: true },
  { name: "radial_blur_spin", matchName: "ADBE Radial Blur", values: { 1: 20, 2: [60, 45], 3: 1, 4: 1 } },
  { name: "radial_blur_zoom", matchName: "ADBE Radial Blur", values: { 1: 30, 2: [40, 30], 3: 2, 4: 2 } },
  { name: "fractal_noise", matchName: "ADBE Fractal Noise", values: { 1: 1, 2: 3, 3: 0, 4: 100, 5: 0, 6: 4, 8: 0, 9: 1, 10: 40, 13: [60, 45], 15: 3, 17: 70, 18: 56, 23: 90, 29: 100, 30: 2 } },
  { name: "fractal_noise_turbulent_blend", matchName: "ADBE Fractal Noise", values: { 1: 4, 2: 4, 3: 1, 4: 150, 5: 10, 6: 3, 8: 30, 9: 0, 11: 60, 12: 30, 15: 2.5, 23: 400, 25: 1, 26: 2, 27: 7, 29: 70, 30: 8 } },
  { name: "fractal_noise_block", matchName: "ADBE Fractal Noise", values: { 1: 3, 2: 1, 10: 50, 15: 1, 30: 1 }, noScaleCheck: true },
  { name: "four_color_gradient", matchName: "ADBE 4ColorGradient", values: { 1: [10, 10], 2: [1, 1, 0, 1], 3: [110, 10], 4: [0, 1, 1, 1], 5: [10, 80], 6: [1, 0, 1, 1], 7: [110, 80], 8: [0, 0, 1, 1], 9: 100, 10: 0, 13: 100, 14: 1 } },
  { name: "four_color_gradient_multiply", matchName: "ADBE 4ColorGradient", values: { 1: [20, 30], 2: [1, 0.5, 0, 1], 3: [100, 20], 4: [0.2, 1, 0.4, 1], 5: [30, 70], 6: [0.8, 0.8, 1, 1], 7: [90, 85], 8: [1, 1, 1, 1], 9: 40, 13: 70, 14: 5 } },
  { name: "turbulent_displace", matchName: "ADBE Turbulent Displace", values: { 1: 1, 2: 40, 3: 30, 4: [60, 45], 5: 2, 6: 45, 12: 1, 13: 0 } },
  { name: "turbulent_displace_twist", matchName: "ADBE Turbulent Displace", values: { 1: 3, 2: 80, 3: 40, 4: [50, 40], 5: 1.5, 6: 0, 12: 3, 13: 1 } },
  { name: "turbulent_displace_cross", matchName: "ADBE Turbulent Displace", values: { 1: 9, 2: 50, 3: 25, 5: 1, 12: 1, 13: 1 } },
  { name: "wave_warp", matchName: "ADBE Wave Warp", values: { 1: 1, 2: 8, 3: 30, 4: 90, 5: 0, 6: 1, 7: 0 } },
  { name: "wave_warp_triangle_pinned", matchName: "ADBE Wave Warp", values: { 1: 3, 2: 6, 3: 25, 4: 45, 5: 0, 6: 2, 7: 30 } },
  { name: "wave_warp_identity", matchName: "ADBE Wave Warp", values: { 1: 1, 2: 0, 3: 30, 4: 90, 5: 1 }, identity: true },
  { name: "bulge", matchName: "ADBE Bulge", values: { 1: 40, 2: 30, 3: [60, 45], 4: 2, 5: 0, 7: 0 } },
  { name: "bulge_pinch_pinned", matchName: "ADBE Bulge", values: { 1: 70, 2: 50, 3: [50, 40], 4: -1.5, 5: 0, 7: 1 } },
  { name: "bulge_identity", matchName: "ADBE Bulge", values: { 1: 40, 2: 30, 3: [60, 45], 4: 0 }, identity: true },
  { name: "twirl", matchName: "ADBE Twirl", values: { 1: 180, 2: 40, 3: [60, 45] } },
  { name: "twirl_identity", matchName: "ADBE Twirl", values: { 1: 0, 2: 50, 3: [60, 45] }, identity: true },
  { name: "optics_compensation", matchName: "ADBE Optics Compensation", values: { 1: 90, 2: 0, 3: 1, 4: [60, 45], 5: 0, 6: 1 } },
  { name: "optics_compensation_reverse_resize", matchName: "ADBE Optics Compensation", values: { 1: 100, 2: 1, 3: 3, 4: [60, 45], 5: 0, 6: 3 } },
  { name: "optics_compensation_identity", matchName: "ADBE Optics Compensation", values: { 1: 0, 2: 1, 4: [60, 45] }, identity: true },
  { name: "displacement_map_self", matchName: "ADBE Displacement Map", values: { 1: 0, 2: 1, 3: 10, 4: 2, 5: 10, 6: 1, 7: 0, 8: 1 } },
  { name: "displacement_map_wrap", matchName: "ADBE Displacement Map", values: { 1: 0, 2: 5, 3: -15, 4: 6, 5: 8, 6: 3, 7: 1, 8: 0 } },
];

if (!args.includes("--no-build")) execSync("npx vite build -c vite.harness.config.ts --logLevel error", { stdio: "inherit" });
const executablePath = option("--chrome") ?? process.env.CHROME_PATH;
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : { channel: process.platform === "win32" ? "msedge" : "chrome" }),
  headless: true,
  args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage();
const consoleErrors: string[] = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ path: resolve("dist-harness/harness.js") });
await page.evaluate((b64) => (globalThis as any).aepHarness.load(b64), readFileSync(PROJECT).toString("base64"));

const render = async (name: string): Promise<{ pixels: Uint8Array; warnings: string[] }> => {
  const r = await page.evaluate(([comp]) => (globalThis as any).aepHarness.render(comp, 0), [COMP] as const);
  const pixels = new Uint8Array(Buffer.from(r.pixels, "base64"));
  if (outDir) writeFileSync(join(outDir, `${name}.png`), encodePng(r.width, r.height, pixels));
  return { pixels, warnings: r.warnings };
};

await page.evaluate(([comp, layer]) => (globalThis as any).aepHarness.setEffect(comp, layer, "ADBE Tint", { 3: 0 }), [COMP, LAYER] as const);
const base = await render("base");
const compareScale = async (): Promise<number> => (await page.evaluate(([comp]) => (globalThis as any).aepHarness.compareScale(comp, 0, 2), [COMP] as const)).meanError;
// The first reduced-resolution render warms caches the later ones reuse.
await compareScale();
const baseScaleError = await compareScale();
console.log(`half resolution without an effect: mean error ${baseScaleError.toFixed(2)}/255`);
const at = (px: Uint8Array, i: number): Rgba => [px[i], px[i + 1], px[i + 2], px[i + 3]];

let failures = 0;
for (const c of cases) {
  if (only && !only.includes(c.name)) continue;
  const problems: string[] = [];
  let maxDiff = 0;
  let changed = 0;
  let scaleError = 0;
  try {
    await page.evaluate(([comp, layer, matchName, values]) => (globalThis as any).aepHarness.setEffect(comp, layer, matchName, values), [COMP, LAYER, c.matchName, c.values] as const);
    const out = await render(c.name);
    for (const w of out.warnings) if (/not rendered yet|failed|error/i.test(w)) problems.push(`warning: ${w}`);
    let worstExpect = 0;
    for (let i = 0; i < out.pixels.length; i += 4) {
      const d = Math.max(...[0, 1, 2, 3].map((k) => Math.abs(out.pixels[i + k] - base.pixels[i + k])));
      maxDiff = Math.max(maxDiff, d);
      if (d > 2) changed++;
      if (c.expect) {
        const [r, g, b, a] = at(base.pixels, i);
        if (a !== 255 || out.pixels[i + 3] !== 255) continue;
        const want = c.expect([r / 255, g / 255, b / 255]);
        for (let k = 0; k < 3; k++) worstExpect = Math.max(worstExpect, Math.abs(out.pixels[i + k] - Math.round(want[k] * 255)));
      }
    }
    if (c.identity && maxDiff > 2) problems.push(`identity parameters changed the frame (max ${maxDiff}/255)`);
    if (!c.identity && changed === 0) problems.push("the frame did not change");
    if (c.expect && worstExpect > 3) problems.push(`differs from its formula by up to ${worstExpect}/255`);
    if (!c.noScaleCheck) {
      scaleError = await compareScale();
      if (scaleError > SCALE_ERROR_RATIO * baseScaleError) problems.push(`half resolution is off by a mean ${scaleError.toFixed(2)}/255`);
    }
  } catch (e) {
    problems.push(String(e instanceof Error ? e.message : e).split("\n")[0]);
  }
  if (consoleErrors.length) problems.push(...consoleErrors.splice(0).map((m) => `console: ${m}`));
  if (problems.length) failures++;
  console.log(`${problems.length ? "FAIL" : "ok  "} ${c.name.padEnd(28)} ${c.matchName.padEnd(30)} changed ${String(changed).padStart(6)} px, max ${String(maxDiff).padStart(3)}, half res ${scaleError.toFixed(2)}${problems.length ? `\n     ${problems.join("\n     ")}` : ""}`);
}
await browser.close();
console.log(failures ? `STOCK-EFFECTS-FAILED: ${failures}` : "STOCK-EFFECTS-OK");
process.exit(failures ? 1 : 0);
