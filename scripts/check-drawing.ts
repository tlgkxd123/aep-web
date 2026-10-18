// Draws with the app's tools in headless Edge and checks what they write: the Rectangle tool makes a mask on
// the selected solid, the Selection, Add Vertex and Delete Vertex tools edit its path, the Timeline's Mode
// popup and Inverted switch change it; with nothing selected the Star tool and the Pen make shape layers, and
// on a selected shape layer the Rectangle tool adds a group. The project is then saved through File > Save
// and the saved file is read back here. Screenshot: refs/probe-drawing.png. Prints DRAWING-UI-PASSED when
// every check holds.
//
//   node scripts/check-drawing.ts [app url | --serve]
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import type { CompItem, Layer, Property, PropertyGroup, PropertyNode, Shape } from "../src/aep/model.ts";
import { projectFromRifx } from "../src/aep/parse.ts";
import { readRifx } from "../src/aep/riff.ts";
import { addLayer } from "../src/edit/layers.ts";
import { MaskMode } from "../src/edit/masks.ts";
import { DEFAULT_COMP_SETTINGS, newComposition, newProject } from "../src/edit/project.ts";

const W = 640;
const H = 360;
const args = process.argv.slice(2);
let server: ViteDevServer | undefined;
let url = args.find((a) => !a.startsWith("--")) ?? "http://localhost:5173";
if (args.includes("--serve")) {
  server = await createServer({ configFile: "vite.config.ts", logLevel: "error", server: { port: 5193, strictPort: false } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
}

const dir = mkdtempSync(join(tmpdir(), "aep-draw-"));
const projectPath = join(dir, "draw.aep");
{
  const editor = newProject();
  const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: "Draw", width: W, height: H, frameRate: 30, duration: 5 });
  addLayer(editor, comp, { kind: "solid", name: "Plate", color: [0.2, 0.6, 0.9], width: 400, height: 240 });
  writeFileSync(projectPath, editor.save());
}

const results: [string, boolean, string?][] = [];
const check = (name: string, ok: boolean, detail?: string) => results.push([name, ok, detail]);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
// Saving falls back to a download without the file pickers.
await page.addInitScript(() => {
  const w = window as unknown as Record<string, unknown>;
  delete w.showSaveFilePicker;
  delete w.showOpenFilePicker;
});
await page.goto(url);
await page.locator('input[aria-label="Open After Effects project"]').setInputFiles(projectPath);
await page.locator(".comp-frame").waitFor();
await page.waitForTimeout(1500);

const frame = page.locator(".comp-frame");
const at = async (x: number, y: number): Promise<[number, number]> => {
  const b = (await frame.boundingBox())!;
  return [b.x + (x / W) * b.width, b.y + (y / H) * b.height];
};
const drag = async (from: [number, number], to: [number, number], modifiers: string[] = []) => {
  const [x0, y0] = await at(...from);
  const [x1, y1] = await at(...to);
  for (const m of modifiers) await page.keyboard.down(m);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 6 });
  await page.mouse.up();
  for (const m of modifiers) await page.keyboard.up(m);
  await page.waitForTimeout(250);
};
const click = async (x: number, y: number) => {
  const [sx, sy] = await at(x, y);
  await page.mouse.click(sx, sy);
  await page.waitForTimeout(250);
};
const tool = async (name: string, flyoutOf?: string) => {
  if (flyoutOf) {
    await page.locator(`.toolbar button[aria-label="${flyoutOf}"]`).first().click({ button: "right" });
    await page.locator(".context-menu .menu-item", { hasText: name }).first().click();
  } else await page.locator(`.toolbar button[aria-label="${name}"]`).first().click();
  await page.waitForTimeout(100);
};
const vertices = () => page.locator(".path-overlay .path-vertex").count();
const layerRow = (name: string) => page.locator(".tl-layer", { hasText: name });

// The Rectangle tool on the selected solid draws a mask.
await layerRow("Plate").locator(".c-name").click();
await tool("Rectangle Tool");
await drag([200, 100], [400, 250]);
await tool("Selection Tool");
check("rectangle tool masks the selected solid", (await vertices()) === 4, `${await vertices()} vertices`);

// The Selection tool drags a vertex; undo puts it back.
const first = page.locator(".path-overlay .path-vertex").first();
const x0 = Number(await first.getAttribute("x"));
const vb = (await first.boundingBox())!;
await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
await page.mouse.down();
await page.mouse.move(vb.x + vb.width / 2 + 40, vb.y + vb.height / 2 + 10, { steps: 5 });
await page.mouse.up();
await page.waitForTimeout(250);
const x1 = Number(await page.locator(".path-overlay .path-vertex").first().getAttribute("x"));
check("selection tool drags a mask vertex", x1 - x0 > 20, `x ${x0.toFixed(1)} -> ${x1.toFixed(1)}`);
await page.keyboard.press("Control+z");
await page.waitForTimeout(250);
const x2 = Number(await page.locator(".path-overlay .path-vertex").first().getAttribute("x"));
check("undo puts the vertex back", Math.abs(x2 - x0) < 0.01, `x ${x2.toFixed(1)}`);

// With a vertex selected the arrow keys nudge it and Delete removes it, not the layer; Escape lets it go.
const vertexX = async (i: number) => Number(await page.locator(".path-overlay .path-vertex").nth(i).getAttribute("x"));
await page.locator(".path-overlay .path-vertex").nth(1).click();
const before = await vertexX(1);
await page.keyboard.press("Shift+ArrowRight");
await page.waitForTimeout(200);
check("shift+arrow nudges the selected vertex 10 px", Math.abs((await vertexX(1)) - before - 10) < 0.01, `x ${before} -> ${await vertexX(1)}`);
await page.keyboard.press("Delete");
await page.waitForTimeout(200);
check("delete removes the selected vertex and keeps the layer", (await vertices()) === 3 && (await layerRow("Plate").count()) === 1, `${await vertices()} vertices`);
await page.keyboard.press("Control+z");
await page.keyboard.press("Control+z");
await page.waitForTimeout(200);

// Add Vertex splits the top edge; Delete Vertex removes a vertex.
await tool("Add Vertex Tool", "Pen Tool");
await click(300, 100);
check("add vertex tool splits a segment", (await vertices()) === 5, `${await vertices()} vertices`);
await tool("Delete Vertex Tool", "Add Vertex Tool");
const last = page.locator(".path-overlay .path-vertex").nth(2);
await last.click();
await page.waitForTimeout(250);
check("delete vertex tool removes a vertex", (await vertices()) === 4, `${await vertices()} vertices`);
await tool("Selection Tool");

// The Timeline's Mode popup and Inverted switch.
await layerRow("Plate").locator('button[aria-label^="Expand"]').first().click();
await page.locator('.tl-prop button[aria-label="Expand Masks"]').click();
await page.locator('.tl-prop button[aria-label^="Mask Mode"]').first().click();
await page.locator(".context-menu .menu-item", { hasText: /^\s*Subtract/ }).click();
await page.waitForTimeout(200);
check("mask mode popup sets Subtract", (await page.locator('.tl-prop button[aria-label^="Mask Mode"]').first().getAttribute("aria-label"))?.includes("Subtract") ?? false);
await page.locator('.tl-prop button[aria-label="Inverted"]').first().click();
await page.waitForTimeout(200);
check("inverted switch turns on", (await page.locator('.tl-prop button[aria-label="Inverted"]').first().getAttribute("aria-checked")) === "true");

// Nothing selected: the Star tool makes a shape layer, and so does the Pen (a closed path).
await click(20, 20);
await tool("Star Tool", "Rectangle Tool");
await drag([560, 180], [600, 180]);
check("star tool with nothing selected makes a shape layer", (await layerRow("Shape Layer 1").count()) === 1);
await tool("Selection Tool");
await click(20, 20);
// A shape layer is picked by what it draws, not by a comp-sized box from its anchor.
await click(555, 175);
check("clicking the star selects its layer", (await layerRow("Shape Layer 1").getAttribute("aria-selected")) === "true");
await click(20, 20);
await click(630, 300);
check("clicking beside the star selects nothing", (await layerRow("Shape Layer 1").getAttribute("aria-selected")) === "false");
await click(20, 20);
await tool("Pen Tool", "Delete Vertex Tool");
await click(60, 250);
await drag([110, 320], [140, 320]);
await click(30, 340);
await click(60, 250);
check("pen with nothing selected makes a shape layer", (await layerRow("Shape Layer 2").count()) === 1);
await tool("Selection Tool");
check("the pen's path shows its three vertices", (await vertices()) === 3, `${await vertices()} vertices`);

// On the selected shape layer, the Rectangle tool adds a group.
await tool("Rectangle Tool", "Star Tool");
await drag([40, 40], [120, 90]);
await tool("Selection Tool");
await page.screenshot({ path: "refs/probe-drawing.png" });

// File > Save, then read the saved project back.
const download = page.waitForEvent("download", { timeout: 15000 });
await page.keyboard.press("Control+s");
const saved = join(dir, "saved.aep");
try {
  await (await download).saveAs(saved);
  const project = projectFromRifx(readRifx(new Uint8Array(readFileSync(saved))));
  const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === "Draw")!;
  const layer = (name: string): Layer | undefined => comp.layers.find((l) => l.name === name);
  const find = (nodes: readonly PropertyNode[], matchName: string): PropertyNode | undefined => {
    for (const n of nodes) {
      if (n.matchName === matchName) return n;
      const found = n.kind === "group" ? find(n.children, matchName) : undefined;
      if (found) return found;
    }
    return undefined;
  };
  const plate = layer("Plate");
  const parade = plate && (find(plate.properties, "ADBE Mask Parade") as PropertyGroup | undefined);
  const mask = parade?.children.find((n): n is PropertyGroup => n.kind === "group" && !!n.mask);
  const maskPath = mask && ((find(mask.children, "ADBE Mask Shape") as Property).value as Shape);
  check("saved mask: Subtract, inverted, 4 vertices", mask?.mask?.maskMode === MaskMode.SUBTRACT && !!mask.mask.inverted && maskPath?.vertices.length === 4);
  const star = layer("Shape Layer 1");
  check("saved star shape layer", !!star && (find(star.properties, "ADBE Vector Star Type") as Property | undefined)?.value === 1);
  const pen = layer("Shape Layer 2");
  const penPath = pen && ((find(pen.properties, "ADBE Vector Shape") as Property | undefined)?.value as Shape | undefined);
  const groups = (pen && (find(pen.properties, "ADBE Root Vectors Group") as PropertyGroup).children.map((n) => n.name)) ?? [];
  check("saved pen path: closed, 3 vertices, then a Rectangle group on top", !!penPath?.closed && penPath.vertices.length === 3 && groups[0] === "Rectangle 1", `groups ${groups.join(", ")}`);
} catch (e) {
  check("File > Save writes the project", false, (e as Error).message);
}

await browser.close();
await server?.close();
rmSync(dir, { recursive: true, force: true });
for (const [name, ok, detail] of results) console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
if (errors.length) console.log(`page errors:\n${errors.join("\n")}`);
const passed = results.every(([, ok]) => ok) && !errors.length;
console.log(passed ? "DRAWING-UI-PASSED" : "DRAWING-UI-FAILED");
process.exit(passed ? 0 : 1);
