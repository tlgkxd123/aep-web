// Renders the Sapphire look-alikes (sapphire.ts, sapphireLight.ts) and the Trapcode Form look-alike (form.ts) on a
// fixture layer in headless Chrome (any WebGL2, SwiftShader included): each must compile and draw without errors or
// "not rendered" warnings and change the frame; with View > Render Sapphire effects off the Sapphire ones must leave
// the frame as it was (After Effects skips them); the scalable ones must stay close to the full-resolution frame at
// half resolution. Not a comparison with the plugins, which are not installed here.
//
//   node scripts/check-plugin-lookalikes.ts [--chrome <path>] [--no-build] [--only name,name] [--out dir]
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
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
/** Mean error (of 255) allowed at half resolution, as a multiple of that error without an effect. */
const SCALE_ERROR_RATIO = 2.5;

type Value = number | number[] | null;
interface Named {
  name: string;
  value: Value;
  controlType?: number;
  options?: string[];
}
interface Case {
  name: string;
  matchName: string;
  values?: Record<number, Value>;
  named?: Named[];
  sapphire?: boolean;
  scalable?: boolean;
  time?: number;
}

const WHITE = [1, 1, 1, 1];
const glow = (extra: Record<number, Value>): Record<number, Value> => ({
  50: 1, 51: WHITE, 52: 0.3, 53: [0, 0, 0, 1], 54: 40, 55: 1, 56: 1, 57: 1, 58: 1, 59: 1,
  100: 1, 101: 3, 102: 2, 61: 1, 62: 0, 63: 1, 65: 1, 68: 0, 69: 2, 103: 0, ...extra,
});
const directional = (extra: Record<number, Value>): Record<number, Value> => ({
  50: 12, 51: 30, 52: 0, 53: 0.5, 54: 1, 55: 1, 56: 1, 57: 1, 58: 1, 59: 1, 60: 1, 61: 0, 62: 0, 63: 3, 64: 1, 67: 1, ...extra,
});
const topic = (name: string, params: Named[]): Named[] => [{ name, value: null, controlType: 13 }, ...params, { name: "", value: null, controlType: 14 }];
const popup = (name: string, options: string[], value: number): Named => ({ name, value, controlType: 7, options });
const BASE_FORMS = ["Box - Grid", "Box - Strings", "Sphere - Layered", "OBJ Model", "Text/Mask Layer"];
const TYPES = ["Sphere", "Glow Sphere (No DOF)", "Star (No DOF)", "Cloudlet", "Streaklet", "Sprite"];
const MODES = ["Normal", "Add", "Screen", "Lighten"];
const form = (base: number, size: number[], counts: number[], particle: Named[], more: Named[] = []): Named[] => [
  ...topic("Base Form", [
    popup("Base Form", BASE_FORMS, base),
    { name: "Size X", value: size[0] },
    { name: "Size Y", value: size[1] },
    { name: "Size Z", value: size[2] },
    { name: "Particles in X", value: counts[0] },
    { name: "Particles in Y", value: counts[1] },
    { name: "Particles in Z", value: counts[2] },
    { name: "Sphere Layers", value: counts[2] },
    { name: "X Rotation", value: 20 },
    { name: "Y Rotation", value: 30 },
    { name: "Z Rotation", value: 0 },
  ]),
  ...topic("Particle", particle),
  ...more,
  ...topic("World Transform", [{ name: "X Rotation", value: 0 }, { name: "X Offset", value: 0 }]),
];

const cases: Case[] = [
  { name: "s_blur_directional", matchName: "S_BlurDirectional", values: directional({}), sapphire: true, scalable: true },
  { name: "s_blur_directional_rgb", matchName: "S_BlurDirectional", values: directional({ 52: 4, 54: 0.5, 56: 2, 63: 1, 64: 3 }), sapphire: true, scalable: true },
  { name: "s_glow", matchName: "S_Glow", values: glow({}), sapphire: true, scalable: true },
  { name: "s_glow_rgb_expand", matchName: "S_Glow", values: glow({ 57: 1.5, 59: 0.6, 68: 1, 102: 1, 101: 2 }), sapphire: true, scalable: true },
  { name: "s_glow_threshold", matchName: "S_Glow", values: glow({ 100: 2 }), sapphire: true, scalable: true },
  {
    name: "s_zglow",
    matchName: "S_ZGlow",
    values: {
      1: 0, 50: 1, 51: WHITE, 52: 4, 53: 40, 54: 0.3, 55: [0, 0, 0, 1], 56: 1, 57: 0, 58: 1, 59: 5, 60: 1, 61: WHITE, 62: 1, 63: 1, 64: 1,
      65: 1, 66: [1, 0.5, 0.2, 1], 67: 1, 68: 1, 69: 1, 70: 1, 71: 1, 72: 1, 73: 1.2, 74: 1.4, 75: 1, 76: 1, 77: 1, 78: 0, 79: 2,
    },
    sapphire: true,
    scalable: true,
  },
  {
    name: "s_flicker",
    matchName: "S_Flicker",
    values: { 50: 0.5, 51: 1, 52: 0.3, 53: 6, 54: 1, 55: 2, 56: 0, 57: 0.3, 58: 0.6, 59: 1, 60: 1, 61: 1, 62: 1.2, 63: 0.1 },
    sapphire: true,
    time: 0.3,
  },
  {
    name: "form_grid",
    matchName: "tc Form",
    named: form(1, [120, 80, 20], [24, 16, 1], [
      popup("Particle Type", TYPES, 1),
      { name: "Size", value: 4 },
      { name: "Opacity", value: 100 },
      { name: "Color", value: [1, 0.8, 0.4, 1] },
      popup("Transfer Mode", MODES, 1),
    ]),
  },
  {
    name: "form_sphere_glow_add",
    matchName: "tc Form",
    named: form(3, [90, 90, 20], [40, 20, 2], [popup("Particle Type", TYPES, 2), { name: "Size", value: 3 }, { name: "Size Random", value: 50 }, { name: "Color", value: [1, 0.3, 0.1, 1] }, popup("Transfer Mode", MODES, 2)]),
  },
  {
    name: "form_strings_fractal",
    matchName: "tc Form",
    time: 0.5,
    named: form(
      2,
      [130, 90, 0],
      [10, 8, 1],
      [{ name: "Size", value: 1.5 }, { name: "Color", value: [0.4, 0.8, 1, 1] }, popup("Transfer Mode", MODES, 3)],
      [
        ...topic("Disperse & Twist", [{ name: "Disperse", value: 4 }, { name: "Twist", value: 1 }]),
        ...topic("Fractal Field", [
          { name: "Affect Size", value: 5 },
          { name: "Affect Opacity", value: 3 },
          popup("Displacement Mode", ["XYZ Linked", "XYZ Individual"], 1),
          { name: "Displace", value: 12 },
          { name: "Flow X", value: 50 },
          { name: "Flow Evolution", value: 1 },
          { name: "F Scale", value: 10 },
          { name: "Complexity", value: 3 },
        ]),
      ],
    ),
  },
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
page.on("pageerror", (e) => consoleErrors.push(e.message));
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ path: resolve("dist-harness/harness.js") });
await page.evaluate((b64) => (globalThis as any).aepHarness.load(b64), readFileSync(PROJECT).toString("base64"));

const setOptions = (sapphireLookalikes: boolean) => page.evaluate((on) => (globalThis as any).aepHarness.setOptions({ sapphireLookalikes: on }), sapphireLookalikes);
const render = async (name: string, time: number): Promise<{ pixels: Uint8Array; warnings: string[] }> => {
  const r = await page.evaluate(([comp, t]) => (globalThis as any).aepHarness.render(comp, t), [COMP, time] as const);
  const pixels = new Uint8Array(Buffer.from(r.pixels, "base64"));
  if (outDir) writeFileSync(join(outDir, `${name}.png`), encodePng(r.width, r.height, pixels));
  return { pixels, warnings: r.warnings };
};
const compareScale = async (time: number): Promise<number> =>
  (await page.evaluate(([comp, t]) => (globalThis as any).aepHarness.compareScale(comp, t, 2), [COMP, time] as const)).meanError;
const maxDiff = (a: Uint8Array, b: Uint8Array) => {
  let worst = 0;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    worst = Math.max(worst, d);
    if (d > 2) changed++;
  }
  return { worst, changed };
};

await page.evaluate(([comp, layer]) => (globalThis as any).aepHarness.setEffect(comp, layer, "ADBE Tint", { 3: 0 }), [COMP, LAYER] as const);
const bases = new Map<number, Uint8Array>();
const baseAt = async (time: number) => {
  if (!bases.has(time)) bases.set(time, (await render(`base_${time}`, time)).pixels);
  return bases.get(time)!;
};
await compareScale(0);
const baseScaleError = await compareScale(0);
console.log(`half resolution without an effect: mean error ${baseScaleError.toFixed(2)}/255`);

let failures = 0;
for (const c of cases) {
  if (only && !only.includes(c.name)) continue;
  const problems: string[] = [];
  const time = c.time ?? 0;
  let changed = 0;
  let scaleError = 0;
  try {
    await page.evaluate(([comp, layer]) => (globalThis as any).aepHarness.setEffect(comp, layer, "ADBE Tint", { 3: 0 }), [COMP, LAYER] as const);
    const base = await baseAt(time);
    if (c.named) {
      await page.evaluate(([comp, layer, matchName, named]) => (globalThis as any).aepHarness.setNamedEffect(comp, layer, matchName, named), [COMP, LAYER, c.matchName, c.named] as const);
    } else {
      await page.evaluate(([comp, layer, matchName, values]) => (globalThis as any).aepHarness.setEffect(comp, layer, matchName, values), [COMP, LAYER, c.matchName, c.values!] as const);
    }
    if (c.sapphire) {
      await setOptions(false);
      const skipped = await render(`${c.name}_skipped`, time);
      if (maxDiff(skipped.pixels, base).worst > 2) problems.push("with the look-alikes off the frame changed");
      if (!skipped.warnings.some((w) => /plugin is not installed; After Effects skips it/.test(w))) problems.push(`no skip warning: ${skipped.warnings.join(" | ")}`);
      await setOptions(true);
    }
    const out = await render(c.name, time);
    for (const w of out.warnings) if (/not rendered yet|failed|error/i.test(w)) problems.push(`warning: ${w}`);
    const diff = maxDiff(out.pixels, base);
    changed = diff.changed;
    if (!changed) problems.push("the frame did not change");
    if (c.scalable) {
      scaleError = await compareScale(time);
      if (scaleError > SCALE_ERROR_RATIO * Math.max(baseScaleError, 0.5)) problems.push(`half resolution is off by a mean ${scaleError.toFixed(2)}/255`);
    }
  } catch (e) {
    problems.push(String(e instanceof Error ? e.message : e).split("\n")[0]);
  }
  if (c.sapphire) await setOptions(false);
  if (consoleErrors.length) problems.push(...consoleErrors.splice(0).map((m) => `console: ${m}`));
  if (problems.length) failures++;
  console.log(`${problems.length ? "FAIL" : "ok  "} ${c.name.padEnd(26)} ${c.matchName.padEnd(18)} changed ${String(changed).padStart(7)}, half res ${scaleError.toFixed(2)}${problems.length ? `\n     ${problems.join("\n     ")}` : ""}`);
}
await browser.close();
console.log(failures ? `PLUGIN-LOOKALIKES-FAILED: ${failures}` : "PLUGIN-LOOKALIKES-OK");
process.exit(failures ? 1 : 0);
