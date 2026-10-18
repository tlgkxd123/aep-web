// Exercises an actual saved project in WebGL2. Generated media is only a test image;
// the effect samples user footage in the same way. Outputs stay under ignored refs/.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { CompItem } from "../src/aep/model.ts";
import { applyLibraryEffect, effectLibrary } from "../src/edit/effectLibrary.ts";
import { addLayer } from "../src/edit/layers.ts";
import { DEFAULT_COMP_SETTINGS, importFootage, newComposition, newProject } from "../src/edit/project.ts";
import { PORTAL_CARDS } from "../src/edit/portalCards.ts";
import { encodePng } from "./lib/png.ts";

const out = resolve("refs/probe/portal-cards");
mkdirSync(out, { recursive: true });
const editor = newProject();
const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: "Portal Cards", width: 960, height: 540, frameRate: 30, duration: 20 });
const [source] = importFootage(editor, [{ path: resolve(out, "portal-source.png"), info: { kind: "png", format: "PNG ", width: 960, height: 540, duration: 0, frameRate: 0, hasAlpha: true } }]);
if (source.mainSource.sourceType !== "FileSource") throw new Error("the check needs a file-source footage item");
const sourcePath = source.mainSource.file;
const id = addLayer(editor, editor.project.items.get(comp.id) as CompItem, { kind: "item", itemId: source.id });
const baseBytes = Buffer.from(editor.save()).toString("base64");
const effect = (await effectLibrary()).find((e) => e.matchName === PORTAL_CARDS)!;
applyLibraryEffect(editor, editor.project.items.get(comp.id) as CompItem, [id], effect);
const bytes = editor.save();
writeFileSync(resolve(out, "portal-cards.aep"), bytes);
execSync("npx vite build -c vite.harness.config.ts --logLevel error", { stdio: "inherit" });
const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true, args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent("<!doctype html><html><body></body></html>");
  await page.addScriptTag({ path: resolve("dist-harness/harness.js") });
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 960; c.height = 540;
    const g = c.getContext("2d")!;
    const sky = g.createLinearGradient(0, 0, 0, 540);
    sky.addColorStop(0, "#050918"); sky.addColorStop(0.58, "#244e74"); sky.addColorStop(0.62, "#a5d8eb"); sky.addColorStop(1, "#071023");
    g.fillStyle = sky; g.fillRect(0, 0, 960, 540);
    let seed = 124;
    const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 | 0) >>> 0) / 4294967296;
    for (let i = 0; i < 450; i++) {
      const x = random() * 960, y = random() * 540, size = random() * 1.5 + 0.3;
      g.globalAlpha = 0.25 + random() * 0.65;
      g.fillStyle = "#dcf4ff"; g.beginPath(); g.arc(x, y, size, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
    const planet = g.createRadialGradient(240, 115, 30, 310, 140, 160);
    planet.addColorStop(0, "#070e20"); planet.addColorStop(0.92, "#213f59"); planet.addColorStop(0.98, "#acdcf6"); planet.addColorStop(1, "#4e7594");
    g.fillStyle = planet; g.beginPath(); g.arc(310, 140, 160, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#050b1a"; g.beginPath(); g.moveTo(0, 540);
    for (let x = 0; x <= 960; x += 40) g.lineTo(x, 430 + random() * 85);
    g.lineTo(960, 540); g.fill();
    return c.toDataURL("image/png").split(",")[1];
  });
  writeFileSync(resolve(out, "portal-source.png"), Buffer.from(png, "base64"));
  const load = async (project: string) => {
    await page.evaluate((b64) => (globalThis as any).aepHarness.load(b64), project);
    await page.evaluate(([path, image]) => (globalThis as any).aepHarness.addFile(path, image), [sourcePath, png]);
  };
  const render = async (name: string, time: number) => {
    const r = await page.evaluate((t) => (globalThis as any).aepHarness.render("Portal Cards", t), time);
    assert.deepEqual(r.warnings, [], `${name}: warnings`);
    const pixels = Buffer.from(r.pixels, "base64");
    writeFileSync(resolve(out, `${name}.png`), encodePng(r.width, r.height, pixels));
    return pixels;
  };
  const difference = (a: Uint8Array, b: Uint8Array) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
  await load(baseBytes);
  const base = await render("source", 0);
  await load(Buffer.from(bytes).toString("base64"));
  const a = await render("cards-0", 0);
  const b = await render("cards-1", 1);
  const c = await render("cards-3", 3);
  assert(difference(a, base) > 3, "cards must change the source");
  assert(difference(a, b) > 1 && difference(b, c) > 1, "time must animate the cards even with frame reuse enabled");
  assert.deepEqual(await render("cards-repeat", 0), a, "scrubbing backwards must be deterministic");
  const half = await page.evaluate(() => (globalThis as any).aepHarness.compareScale("Portal Cards", 1, 2));
  assert(half.meanError < 2, `half resolution mean error: ${half.meanError}`);
  const set = (values: Record<number, number>) => page.evaluate(([name, params]) => (globalThis as any).aepHarness.setEffect("Portal Cards", "portal-source.png", name, params), [PORTAL_CARDS, values] as const);
  await set({ 15: 100 });
  assert(difference(await render("cards-pulse", 1), b) > 1, "pulse must affect geometry");
  // Two unrotated cards (count = Cards + 1 = 3): the first fades out and the last is still
  // zero, so the card over the centre is i = 1 at depth 1. Its size is zoom * spacing, which is
  // the source exactly at Zoom = 100 / 0.62. Pulse is cleared: it scales the zoom.
  const IDENTITY = { 1: 2, 3: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 100 / 0.62, 12: 0, 13: 0, 14: 0, 15: 0 };
  await set(IDENTITY);
  assert(difference(await render("identity", 0), base) < 0.1, "source coordinates and row order must be preserved");
  await set({ 14: 0 });
  const transparent = await render("cards-transparent", 1);
  assert(transparent.some((v, i) => i % 4 === 3 && v < 5), "empty space must stay transparent");
  assert(transparent.some((v, i) => i % 4 === 3 && v > 200), "card interiors must remain visible");
  for (let i = 0; i < transparent.length; i += 4) {
    if (transparent[i + 3] === 0) assert.equal(transparent[i] + transparent[i + 1] + transparent[i + 2], 0, "transparent output must have no hidden RGB");
  }
  const alphaPng = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 540;
    const ctx = canvas.getContext("2d")!; ctx.drawImage(img, 0, 0);
    ctx.clearRect(0, 0, 960, 270);
    return canvas.toDataURL("image/png").split(",")[1];
  }, png);
  await page.evaluate(([path, image]) => (globalThis as any).aepHarness.addFile(path, image), [sourcePath, alphaPng]);
  await set(IDENTITY);
  const alphaInput = await render("alpha-input", 0);
  assert.equal(alphaInput[(100 * 960 + 500) * 4 + 3], 0, "transparent input must stay transparent");
  assert.equal(alphaInput[(400 * 960 + 500) * 4 + 3], 255, "opaque input must stay opaque");
  await set({ 1: 16, 2: 90, 4: -1234, 5: 85, 6: -85, 9: 400 });
  await render("cards-extreme", -1);
  assert.deepEqual(errors, []);
  console.log(`half resolution mean error: ${half.meanError.toFixed(3)}/255`);
  console.log("Portal Cards GPU checks passed");
} finally {
  await browser.close();
}
