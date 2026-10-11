// Drives Effects & Presets in the running app (headless Edge, real pointer events and native drag and drop): opens a
// fixture project and one of its comps, searches the effects and drags them onto a layer's Timeline row, onto the layer
// in the Composition viewer (with no layer selected) and onto Effect Controls, from a category and from Used in This
// Project, and opens the Effect menu's longest category.
//   node scripts/check-effects-panel.ts [app url | --serve]
// --serve starts a dev server for the run. Prints EFFECTS-PANEL-PASSED when the library loads without page errors,
// searches list every effect After Effects has (unavailable when there is no template of it), each drop adds the
// effect to the layer it lands on, and the Effect menu's categories fit in the window.
import { resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";

const FIXTURE = resolve(import.meta.dirname, "../refs/fixtures/roundtrip.base.aep");
const COMP = "roundtrip_minimax";
const CARD = "roundtrip_card";

const args = process.argv.slice(2);
let server: ViteDevServer | undefined;
let url = args.find((a) => /^https?:/.test(a)) ?? "http://localhost:5173/";
if (args.includes("--serve")) {
  server = await createServer({ configFile: "vite.config.ts", logLevel: "error", server: { port: 5193, strictPort: false } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
}

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

const library = (page: Page) => page.getByRole("tree", { name: "Effects & Presets" });
const effectNames = (page: Page) => page.getByRole("tree", { name: "Effect Controls" }).locator(".ec-effect-name").allInnerTexts();
/** The names Effect Controls lists, once they are `expected` (or after three seconds). */
async function settledEffects(page: Page, expected: string[]): Promise<string[]> {
  const until = Date.now() + 3000;
  let names = await effectNames(page);
  while (names.join("|") !== expected.join("|") && Date.now() < until) {
    await page.waitForTimeout(100);
    names = await effectNames(page);
  }
  return names;
}

const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  page.on("response", (r) => r.status() >= 400 && !r.url().endsWith("/favicon.ico") && errors.push(`${r.status()} ${r.url()}`));
  await page.goto(url);
  await page.getByLabel("Open After Effects project").setInputFiles(FIXTURE);
  await page.getByRole("tree", { name: "Project items" }).waitFor();
  await page.getByLabel("Search project").fill(COMP);
  await page.getByRole("tree", { name: "Project items" }).getByRole("treeitem").filter({ hasText: COMP }).first().dblclick();
  const layerRow = page.getByRole("tree", { name: "Timeline layers" }).getByRole("treeitem", { name: CARD });
  await layerRow.getByText(CARD, { exact: true }).click();

  // Search: by name, by match name and by category; effects without a template are listed, unavailable.
  const search = page.getByLabel("Search effects and presets");
  const effect = (category: string, name: string) =>
    library(page).getByRole("treeitem", { name: category, exact: true }).getByRole("treeitem", { name, exact: true });
  for (const [query, category, name, available] of [
    ["blur", "Blur & Sharpen", "Fast Box Blur", true],
    ["mirr", "Distort", "Mirror", true],
    ["ADBE Ramp", "Generate", "Gradient Ramp", true],
    ["expression", "Expression Controls", "Slider Control", true],
    ["gaussian", "Blur & Sharpen", "Gaussian Blur", false],
    ["noise & grain", "Noise & Grain", "Fractal Noise", false],
  ] as const) {
    await search.fill(query);
    const row = effect(category, name);
    const found = await row.waitFor({ timeout: 5000 }).then(() => true, () => false);
    const disabled = found && (await row.getAttribute("aria-disabled")) === "true";
    check(found && disabled === !available, `searching "${query}" lists ${name} under ${category}${available ? "" : ", unavailable"}`);
  }

  /** Drags `from` to `to` (at `position` in it), then checks Effect Controls lists `expected`. */
  const drop = async (from: Locator, to: Locator, what: string, expected: string[], position?: { x: number; y: number }) => {
    const dragged = await from.dragTo(to, { timeout: 5000, targetPosition: position }).then(
      () => "",
      (e: Error) => e.message.split("\n")[0],
    );
    const names = await settledEffects(page, expected);
    check(!dragged && names.join("|") === expected.join("|"), `${what} (${dragged || `Effect Controls: ${names.join(", ") || "none"}`})`);
  };
  await search.fill("mirror");
  await drop(effect("Distort", "Mirror"), layerRow.getByText(CARD, { exact: true }), "dropping Mirror on the layer's Timeline row adds it", ["Mirror"]);

  // In the viewer, the layer under the pointer takes the effect, selected or not.
  const viewer = page.getByRole("img", { name: new RegExp(`^${COMP}, `) });
  const box = (await viewer.boundingBox())!;
  await viewer.click({ position: { x: box.width * 0.03, y: box.height * 0.03 } });
  const deselected = await page.getByText("Select a layer to apply effects to it.").waitFor({ timeout: 3000 }).then(() => true, () => false);
  check(deselected, "clicking the viewer outside the card deselects it");
  await search.fill("vignette");
  await drop(effect("Stylize", "CC Vignette"), viewer, "dropping CC Vignette on the card in the viewer, with no layer selected, adds it to the card", [
    "Mirror",
    "CC Vignette",
  ]);

  await search.fill("slider");
  await drop(effect("Expression Controls", "Slider Control"), page.getByRole("tree", { name: "Effect Controls" }), "dropping Slider Control on Effect Controls adds it", [
    "Mirror",
    "CC Vignette",
    "Slider Control",
  ]);

  await search.fill("mirror");
  const used = library(page).getByRole("treeitem", { name: "Used in This Project", exact: true }).getByRole("treeitem", { name: "Mirror", exact: true });
  await drop(used.locator(".fxp-row").first(), layerRow.getByText(CARD, { exact: true }), "dropping Mirror from Used in This Project on the Timeline row adds it", [
    "Mirror",
    "CC Vignette",
    "Slider Control",
    "Mirror",
  ]);

  // The Effect menu's longest category opens within the window.
  await page.getByRole("menuitem", { name: "Effect", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Distort/ }).click();
  const distort = page.getByRole("menu", { name: "Distort" });
  const menuBox = await distort.boundingBox();
  const items = await distort.getByRole("menuitem").count();
  check(!!menuBox && menuBox.y >= 0 && menuBox.y + menuBox.height <= 1000, `Effect > Distort (${items} effects) fits in the window (${menuBox ? `${Math.round(menuBox.y)}-${Math.round(menuBox.y + menuBox.height)} px` : "not shown"})`);
  await page.keyboard.press("Escape");
} finally {
  await browser.close();
  await server?.close();
}
check(!errors.length, `no page errors${errors.length ? `:\n  ${errors.join("\n  ")}` : ""}`);
if (failures.length) process.exit(1);
console.log("EFFECTS-PANEL-PASSED");
