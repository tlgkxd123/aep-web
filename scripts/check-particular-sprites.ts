// Renders a hidden Texture layer selected through the editor, saved and reopened: PNG and PDF vector bytes
// must produce the same sprite colours and alpha. No private project or Illustrator artwork is needed.
//   node scripts/check-particular-sprites.ts [--no-build]
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Property, PropertyGroup } from "../src/aep/model.ts";
import { addEffects, newInstance, setInstanceNumber, setInstancePoint } from "../src/edit/effects.ts";
import { addLayer } from "../src/edit/layers.ts";
import { DEFAULT_COMP_SETTINGS, importFootage, newComposition, newProject } from "../src/edit/project.ts";
import { effectTemplates } from "../src/extra/pmatch/effectTemplates.ts";
import { encodePng } from "./lib/png.ts";

const COMP = "sprites";
const MATCH = "tc Particular";
const editor = newProject();
const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: COMP, width: 160, height: 120, duration: 3 });
const textures = importFootage(editor, ["raster.png", "vector.png"].map((path) => ({
  path, info: { kind: "png", format: "png!", width: 32, height: 32, duration: 0, frameRate: 0, hasAlpha: true },
})));
const sources = textures.map((item) => {
  const id = addLayer(editor, comp, { kind: "item", itemId: item.id });
  const layer = comp.layers.find((l) => l.id === id)!;
  editor.setLayerSwitch(comp, layer, "enabled", false);
  return id;
});
const id = addLayer(editor, comp, { kind: "solid", name: "Particles", color: [0, 0, 0], width: 160, height: 120 });
const template = (await effectTemplates()).get(MATCH)!;
const instance = newInstance(template);
for (const [n, value] of Object.entries({ 146: 1, 5: 1, 11: 0, 12: 0, 2: 10, 65: 0, 25: 1, 27: 16, 74: 0, 33: 100, 75: 0, 227: 0, 67: 7, 319: 1 })) {
  setInstanceNumber(instance, MATCH, Number(n), value);
}
setInstancePoint(instance, MATCH, 581, [0.5, 0.5, 0]);
addEffects(editor, comp, id, [{ template, instance }]);
const layerOf = (layerId = id) => comp.layers.find((l) => l.id === layerId)!;
const param = (n: number) => {
  const fx = layerOf().properties.find((p) => p.matchName === "ADBE Effect Parade") as PropertyGroup;
  const effect = fx.children.find((p) => p.matchName === MATCH) as PropertyGroup;
  return effect.children.find((p) => p.matchName === `${MATCH}-${String(n).padStart(4, "0")}`) as Property;
};

// Same two squares in both formats: opaque red at the top left, half-transparent blue at the bottom right.
const rgba = new Uint8Array(32 * 32 * 4);
for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
  const i = (y * 32 + x) * 4;
  if (x >= 4 && x < 12 && y >= 4 && y < 12) { rgba[i] = 255; rgba[i + 3] = 255; }
  if (x >= 20 && x < 28 && y >= 20 && y < 28) { rgba[i + 2] = 255; rgba[i + 3] = 128; }
}
const content = "1 0 0 rg 4 20 8 8 re f q /half gs 0 0 1 rg 20 4 8 8 re f Q";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 32 32] /Resources << /ExtGState << /half << /ca 0.5 >> >> >> /Contents 4 0 R >>",
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
objects.forEach((s, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${s}\nendobj\n`; });
const xref = pdf.length;
pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
// The decoder sniffs the bytes rather than relying on the filename or MIME type.
const files = [["raster.png", encodePng(32, 32, rgba)], ["vector.png", Buffer.from(pdf)]] as const;

if (!process.argv.includes("--no-build")) execSync("npx vite build -c vite.harness.config.ts --logLevel error", { stdio: "inherit" });
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const errors: string[] = [];
try {
  const page = await browser.newPage();
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ path: resolve(process.env.AEP_HARNESS_DIR ?? "dist-harness", "harness.js") });
  for (const [path, bytes] of files) await page.evaluate(([p, b]) => (globalThis as any).aepHarness.addFile(p, b), [path, bytes.toString("base64")]);

  async function render(type: number, source: number | null, time: number): Promise<Buffer> {
    editor.setValue(comp, layerOf(), param(26), type, 0);
    editor.setLayerReference(comp, layerOf(), param(66), source === null ? null : layerOf(source));
    await page.evaluate((b) => (globalThis as any).aepHarness.load(b), Buffer.from(editor.save()).toString("base64"));
    const r = await page.evaluate(([c, t]) => (globalThis as any).aepHarness.render(c, t), [COMP, time] as const);
    assert.equal(r.warnings.some((w: string) => /cannot be decoded|failed|not rendered|missing/i.test(w)), false, r.warnings.join(" | "));
    return Buffer.from(r.pixels, "base64");
  }
  const blank = await render(6, null, 0.5);
  for (const type of [6, 7, 8, 9, 10, 11]) {
    for (const time of [0.5, 1.5]) {
      const png = await render(type, sources[0], time);
      const vector = await render(type, sources[1], time);
      assert.notDeepEqual(png, blank, `type ${type} must draw`);
      let worst = 0;
      for (let i = 0; i < png.length; i++) worst = Math.max(worst, Math.abs(png[i] - vector[i]));
      assert.ok(worst <= 2, `type ${type} at ${time}: PNG/vector differ by ${worst}/255`);
      assert.equal(vector[3], 0, "transparent corners");
      console.log(`ok type ${type} at ${time}: hidden texture, saved selection, PNG/vector max ${worst}/255`);
    }
  }
  assert.deepEqual(errors, [], "browser errors");
  console.log("PARTICULAR-SPRITES-OK");
} finally {
  await browser.close();
}

