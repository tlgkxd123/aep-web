// Imports a native project through the editor, then compares its saved nested composition against the original
// in WebGL and After Effects 2025. All files stay under dist-tools/project-import.
//   node scripts/check-project-import.ts
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CompItem } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";
import { importProject } from "../src/edit/import-project.ts";
import { addLayer } from "../src/edit/layers.ts";
import { DEFAULT_COMP_SETTINGS, newComposition, newFolder, newProject } from "../src/edit/project.ts";
import { aerender } from "./aerender.ts";
import { openHarness } from "./lib/harness-page.ts";
import { readTiff } from "./lib/tiff.ts";

const out = resolve("dist-tools/project-import");
mkdirSync(out, { recursive: true });
const settings = (name: string) => ({ ...DEFAULT_COMP_SETTINGS, name, width: 160, height: 120, frameRate: 24, duration: 1 });
const source = newProject();
const art = newFolder(source, 0, "Art");
const nested = newComposition(source, settings("Imported Nested"), art.id);
addLayer(source, nested, { kind: "solid", name: "Background", color: [0.1, 0.2, 0.3], width: 160, height: 120 });
addLayer(source, nested, { kind: "solid", name: "Card", color: [1, 0.25, 0], width: 72, height: 48 });
const main = newComposition(source, settings("Imported Main"));
addLayer(source, main, { kind: "item", itemId: nested.id });
const sourcePath = join(out, "source.aep");
writeFileSync(sourcePath, source.save());

const destination = newProject();
newComposition(destination, settings("Keep Existing"));
const stock = Editor.fromBytes(new Uint8Array(readFileSync("refs/fixtures/stockfx.aep")));
importProject(destination, stock.project, "stockfx.aep");
const folder = importProject(destination, source.project, "source.aep");
const importedMain = [...destination.project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === main.name)!;
assert.equal(importedMain.parentFolderId, folder.id);
const host = newComposition(destination, settings("project_import_result"));
addLayer(destination, host, { kind: "item", itemId: importedMain.id });
const mergedPath = join(out, "merged.aep");
writeFileSync(mergedPath, destination.save());

const { browser, page } = await openHarness(sourcePath);
try {
  const a = await page.evaluate((name) => (globalThis as any).aepHarness.render(name, 0), main.name);
  await page.evaluate((bytes) => (globalThis as any).aepHarness.load(bytes), Buffer.from(destination.save()).toString("base64"));
  const b = await page.evaluate((name) => (globalThis as any).aepHarness.render(name, 0), host.name);
  assert.deepEqual(a.warnings, []);
  assert.deepEqual(b.warnings, []);
  assert.equal(b.pixels, a.pixels, "saved imported composition must render identically in WebGL");
  const pixels = Buffer.from(b.pixels, "base64");
  assert.ok(pixels.some((v, i) => i % 4 < 3 && v > 128), "positive pixel control");
  console.log("WebGL: original and saved imported composition are pixel-identical");
} finally {
  await browser.close();
}

const rendered: Uint8Array[] = [];
for (const [project, comp, prefix] of [
  [sourcePath, main.name, "source"], [mergedPath, host.name, "merged"],
  [resolve("refs/fixtures/stockfx.aep"), "stockfx_fill", "effect-source"], [mergedPath, "stockfx_fill", "effect-merged"],
]) {
  const result = await aerender([
    "-project", project, "-comp", comp, "-s", "0", "-e", "0",
    "-OMtemplate", process.env.AE_TIFF_TEMPLATE ?? "Secuencia TIFF con alfa",
    "-output", join(out, `${prefix}_[#####].tif`), "-sound", "OFF",
  ]);
  assert.equal(result.timedOut, false, result.output);
  assert.equal(result.code, 0, result.output);
  assert.ok(!/aerender Error|missing effect|no existe|error al/i.test(result.output), `${project}: ${result.output}`);
  const image = readTiff(new Uint8Array(readFileSync(join(out, `${prefix}_00000.tif`))));
  assert.equal(image.width, 160);
  assert.equal(image.height, 120);
  rendered.push(image.data);
}
assert.deepEqual(rendered[0], rendered[1], "After Effects must render the saved imported project identically");
console.log("After Effects 2025: original and saved imported composition are pixel-identical");
assert.deepEqual(rendered[2], rendered[3], "imported shape layer with Fill must match its original After Effects render");
assert.ok(rendered[2].some((value, index) => index % 4 < 3 && value > 128), "Fill must draw coloured pixels");
console.log("After Effects 2025: imported shapes and effect definitions match the original reference");
console.log("PROJECT-IMPORT-PASSED");
