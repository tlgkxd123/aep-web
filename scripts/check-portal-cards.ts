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
import { PORTAL_CARDS, PORTAL_CARD_PARAMS } from "../src/edit/portalCards.ts";
import { encodePng } from "./lib/png.ts";

const out = resolve("refs/probe/portal-cards");
mkdirSync(out, { recursive: true });
const editor = newProject();
const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: "Portal Cards", width: 960, height: 540, frameRate: 30, duration: 180 });
const [source] = importFootage(editor, [{ path: resolve(out, "portal-source.png"), info: { kind: "png", format: "PNG ", width: 960, height: 540, duration: 0, frameRate: 0, hasAlpha: true } }]);
if (source.mainSource.sourceType !== "FileSource") throw new Error("the check needs a file-source footage item");
const sourcePath = source.mainSource.file;
const id = addLayer(editor, editor.project.items.get(comp.id) as CompItem, { kind: "item", itemId: source.id });
const baseBytes = Buffer.from(editor.save()).toString("base64");
const effect = (await effectLibrary()).find((e) => e.matchName === PORTAL_CARDS)!;
applyLibraryEffect(editor, editor.project.items.get(comp.id) as CompItem, [id], effect);
const portrait = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: "Portal Cards Portrait", width: 540, height: 720, frameRate: 30, duration: 180 });
const [portraitSource] = importFootage(editor, [{ path: resolve(out, "portal-portrait.png"), info: { kind: "png", format: "PNG ", width: 540, height: 720, duration: 0, frameRate: 0, hasAlpha: true } }]);
if (portraitSource.mainSource.sourceType !== "FileSource") throw new Error("the portrait check needs a file-source footage item");
const portraitPath = portraitSource.mainSource.file;
const portraitId = addLayer(editor, editor.project.items.get(portrait.id) as CompItem, { kind: "item", itemId: portraitSource.id });
applyLibraryEffect(editor, editor.project.items.get(portrait.id) as CompItem, [portraitId], effect);
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
  const portraitPng = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const canvas = document.createElement("canvas"); canvas.width = 540; canvas.height = 720;
    canvas.getContext("2d")!.drawImage(img, 140, 0, 405, 540, 0, 0, 540, 720);
    return canvas.toDataURL("image/png").split(",")[1];
  }, png);
  writeFileSync(resolve(out, "portal-portrait.png"), Buffer.from(portraitPng, "base64"));
  const load = async (project: string) => {
    await page.evaluate((b64) => (globalThis as any).aepHarness.load(b64), project);
    await page.evaluate(([path, image]) => (globalThis as any).aepHarness.addFile(path, image), [sourcePath, png]);
    await page.evaluate(([path, image]) => (globalThis as any).aepHarness.addFile(path, image), [portraitPath, portraitPng]);
  };
  const render = async (name: string, time: number, compName = "Portal Cards") => {
    const r = await page.evaluate(([name, t]) => (globalThis as any).aepHarness.render(name, t), [compName, time] as const);
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
  assert(a.equals(await render("cards-repeat", 0)), "scrubbing backwards must be deterministic");
  await render("cards-portrait-0", 0, "Portal Cards Portrait");
  await render("cards-portrait-1", 1, "Portal Cards Portrait");
  await render("cards-portrait-3", 3, "Portal Cards Portrait");
  const half = await page.evaluate(() => (globalThis as any).aepHarness.compareScale("Portal Cards", 1, 2));
  assert(half.meanError < 2, `half resolution mean error: ${half.meanError}`);
  const defaults = Object.fromEntries(PORTAL_CARD_PARAMS.map(([, value], i) => [i + 1, value]));
  const controls = { ...defaults };
  const set = (values: Record<number, number>) => {
    Object.assign(controls, values);
    return page.evaluate(([name, params]) => (globalThis as any).aepHarness.setEffect("Portal Cards", "portal-source.png", name, params), [PORTAL_CARDS, controls] as const);
  };
  await set({ 3: 0, 17: 271 });
  const seeded = await render("cards-seed-271", 0);
  assert(difference(seeded, a) > 2, "seed must change the generated layout");
  assert(seeded.equals(await render("cards-seed-stopped", 7)), "zero speed must freeze the random layout");
  await set({ 17: 1 });
  assert(a.equals(await render("cards-seed-restored", 0)), "restoring the seed must reproduce the layout");
  await set({ 16: 0 });
  const regular = await render("cards-regular", 0);
  assert(difference(regular, a) > 2, "randomness must vary the tilt and offsets of the nested stack");
  await set({ 17: 271 });
  assert(regular.equals(await render("cards-regular-seed", 0)), "seed must have no effect at zero randomness");
  await set({ ...defaults, 1: 1, 3: 0, 4: 90, 14: 0 });
  const single = await render("cards-single", 0);
  assert(single.some((v, i) => i % 4 === 3 && v > 250), "one stationary random card must remain visible");
  await set({ ...defaults, 3: 20 });
  for (let frame = 0; frame < 20; frame++) {
    const time = frame / 4;
    const current = await render(`cards-spawn-${String(frame).padStart(2, "0")}`, time);
    const next = await render("cards-spawn-next", time + 0.001);
    assert(difference(current, next) < 0.15, `card spawn and departure must not pop at ${time}s`);
  }
  assert(difference(a, await render("cards-single-next-spawn", 5)) > 1, "new planes must choose new seeded tilt and offsets");
  await set({ ...defaults, 3: 20 });
  for (const amount of [0, 100]) {
    await set({ 16: amount });
    const endpoint = await render(`cards-randomness-${amount}`, 1);
    await set({ 16: amount === 0 ? 0.001 : 99.999 });
    assert(difference(endpoint, await render(`cards-randomness-near-${amount}`, 1)) < 0.05, "animated randomness must be continuous at both endpoints");
  }
  await set({ ...defaults, 3: 0, 5: 0, 6: 0, 7: 0 });
  const flat = await render("cards-flat", 0);
  for (const [index, name] of [[5, "yaw"], [6, "pitch"], [7, "roll"]] as const) {
    await set({ 5: 0, 6: 0, 7: 0, [index]: 70 });
    assert(difference(await render(`cards-${name}`, 0), flat) > 0.5, `${name} must independently rotate the cards`);
  }
  await set({ ...defaults, 3: 20 });
  const loop = await render("cards-loop-start", 1.25);
  assert(difference(loop, await render("cards-next-cycle", 6.25)) > 1, "successive cycles must spawn new seeded cards");
  assert(loop.equals(await render("cards-loop-repeat", 161.25)), "the seeded sequence must repeat after 32 lifetimes");
  await set({ 4: -32 * 360 });
  assert(loop.equals(await render("cards-loop-negative", 1.25)), "negative evolution must use the same deterministic loop");
  await set({ 4: 0 });
  const before = await render("cards-loop-before", 159.9999);
  const after = await render("cards-loop-after", 160.0001);
  assert(difference(before, after) < 0.1, "random layout must be continuous across a loop boundary");
  await set({ 16: 50 });
  assert(difference(await render("cards-loop-mixed-before", 159.9999), await render("cards-loop-mixed-after", 160.0001)) < 0.1, "partial randomness must also remain continuous across a loop boundary");
  await set({ 16: 0 });
  assert((await render("cards-regular-loop", 1.25)).equals(await render("cards-regular-loop-repeat", 6.25)), "the regular stack must keep its five-second loop");
  await set({ 16: 100 });
  await set({ 3: -20 });
  assert((await render("cards-reverse", 1.25)).equals(await render("cards-reverse-repeat", 161.25)), "reverse travel must repeat deterministically");
  await set({ ...defaults });
  await set({ 15: 100 });
  assert(difference(await render("cards-pulse", 1), b) > 1, "pulse must affect geometry");
  // Two unrotated cards (count = Cards + 1 = 3): the first fades out and the last is still
  // zero, so the card over the centre is i = 1 at depth 1. Its size is zoom * spacing, which is
  // the source exactly at Zoom = 100 / 0.62. Pulse is cleared: it scales the zoom.
  const IDENTITY = { ...defaults, 1: 2, 3: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 100 / 0.62, 12: 0, 13: 0, 14: 0, 15: 0, 16: 0 };
  await set(IDENTITY);
  assert(difference(await render("identity", 0), base) < 0.1, "source coordinates and row order must be preserved");
  const flipped = (horizontal: boolean, vertical: boolean) => {
    const result = Buffer.alloc(base.length);
    for (let y = 0; y < 540; y++) for (let x = 0; x < 960; x++) {
      const from = ((vertical ? 539 - y : y) * 960 + (horizontal ? 959 - x : x)) * 4;
      result.set(base.subarray(from, from + 4), (y * 960 + x) * 4);
    }
    return result;
  };
  for (const [index, horizontal, vertical] of [[5, true, false], [7, true, true]] as const) {
    const amount = index === 5 ? 180 / Math.sin(1.45) : 180 / Math.sin(1.45 * 0.61);
    await set({ ...IDENTITY, [index]: amount });
    assert(difference(await render(`cards-back-${index}`, 0), flipped(horizontal, vertical)) < 0.15, "back-facing cards must preserve the mirrored source instead of disappearing");
  }
  await set({ ...IDENTITY, 6: 360 });
  const backPitch = await render("cards-back-pitch", 0);
  assert(backPitch.filter((v, i) => i % 4 === 3 && v > 250).length > 960 * 540 * 0.2, "back-facing pitched cards must remain visible");
  // At full zoom the nearest portal covers the frame even with no background.
  await set({ ...defaults, 9: 55, 14: 0 });
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
  await load(Buffer.from(bytes).toString("base64"));
  await page.evaluate(([path, image]) => (globalThis as any).aepHarness.addFile(path, image), [sourcePath, alphaPng]);
  await set(IDENTITY);
  const alphaInput = await render("alpha-input", 0);
  assert.equal(alphaInput[(100 * 960 + 500) * 4 + 3], 0, "transparent input must stay transparent");
  assert.equal(alphaInput[(400 * 960 + 500) * 4 + 3], 255, "opaque input must stay opaque");
  await set({ ...defaults, 1: 16, 2: 90, 4: -1234, 5: 360, 6: -360, 7: 360, 9: 400 });
  await render("cards-extreme", 1);
  assert.deepEqual(errors, []);
  console.log(`half resolution mean error: ${half.meanError.toFixed(3)}/255`);
  console.log("Portal Cards GPU checks passed");
} finally {
  await browser.close();
}
