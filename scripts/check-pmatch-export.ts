// Drives Extra > Particle Match's Export to Particular in the running app (headless Edge on the
// high-performance GPU): a new project and comp, the reference video and a trained model in the Particle
// Match window, the learned particles playing, Export to Particular into the comp (the Timeline then lists
// the Particular layers and the composition viewer draws particles), Save, the window reopened with its
// session, and Export to Particular as a new .aep. With --aerender, After Effects opens both saved projects
// and renders a frame of each comp. Screenshots of every state, at 1600 x 1000 and 1100 x 760, go to
// dist-tools/pmatch/export-ui/.
//
//   node scripts/check-pmatch-export.ts [app url | --serve] [--model dist-tools/pmatch/model.pmwm] [--aerender] [--training]
//
// --training also starts a training run long enough to capture the window training, then cancels it.
// Prints PMATCH-EXPORT-PASSED when every check in the app passed, and PMATCH-EXPORT-AE-PASSED when After
// Effects also rendered particles in both projects.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import type { CompItem, Layer, PropertyGroup } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";
import { PARTICULAR } from "../src/extra/pmatch/particular.ts";
import { aerender } from "./aerender.ts";
import { PMATCH_OUT, REFERENCE } from "./lib/pmatch-browser.ts";
import { decodePng } from "./lib/pmatch-png.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const modelPath = resolve(option("model", join(PMATCH_OUT, "model.pmwm")));
const withAerender = args.includes("--aerender");
const withTraining = args.includes("--training");
const out = join(PMATCH_OUT, "export-ui");
const COMP = "pm_export";
/** Lit pixels a rendered frame needs to count as drawing particles. */
const MIN_LIT = 500;

for (const [what, path] of [
  ["reference video", REFERENCE],
  ["trained model", modelPath],
]) {
  if (!existsSync(path)) {
    console.log(`FAILED: the ${what} is missing: ${path}${what === "trained model" ? " (train one with node scripts/pmatch-train.ts)" : ""}`);
    process.exit(1);
  }
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

let server: ViteDevServer | undefined;
let url = args.find((a) => /^https?:/.test(a)) ?? "http://localhost:5173/";
if (args.includes("--serve")) {
  server = await createServer({ configFile: "vite.config.ts", logLevel: "error", server: { port: 5194, strictPort: false } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
}

const checks: [string, boolean, string?][] = [];
const check = (what: string, ok: boolean, detail?: string) => {
  checks.push([what, ok, detail]);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
};

/** Pixels of an element's screenshot brighter than `threshold` (sum of RGB). */
async function litPixels(locator: Locator, threshold = 150): Promise<number> {
  const png = decodePng(new Uint8Array(await locator.screenshot()));
  let lit = 0;
  for (let i = 0; i < png.rgba.length; i += 4) if (png.rgba[i] + png.rgba[i + 1] + png.rgba[i + 2] > threshold) lit++;
  return lit;
}

async function waitFor(what: string, test: () => Promise<boolean>, ms = 20_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await test().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`  (gave up waiting for ${what})`);
  return false;
}

const particularLayers = (comp: CompItem) =>
  comp.layers.filter((l: Layer) =>
    (l.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade")?.children ?? []).some((e) => e.matchName === PARTICULAR),
  );

/** Screenshots of the window at the workspace's size (1600 x 1000) and at a small laptop's (1100 x 760, `-narrow`). */
async function shoot(page: Page, dialog: Locator, name: string): Promise<void> {
  const reference = dialog.locator("video");
  if (await reference.count()) await waitFor("the reference video's picture", () => reference.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && !v.seeking), 20_000);
  await dialog.screenshot({ path: join(out, `${name}.png`) });
  await page.setViewportSize({ width: 1100, height: 760 });
  await page.waitForTimeout(300);
  await dialog.screenshot({ path: join(out, `${name}-narrow.png`) });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(300);
}

async function openParticleMatch(page: Page): Promise<Locator> {
  await page.getByRole("menuitem", { name: "Extra" }).click();
  await page.getByRole("menuitem", { name: "Particle Match..." }).click();
  const dialog = page.getByRole("dialog", { name: "Particle Match" });
  await dialog.waitFor();
  return dialog;
}

const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--force-high-performance-gpu"] });
const errors: string[] = [];
const saved: Record<string, Uint8Array> = {};
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && errors.push(m.text()));
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  // A stand-in for the File System Access save picker, which a headless browser cannot answer. The bytes cross
  // to this process as base64: as a JSON array of numbers a project of a few megabytes takes minutes.
  await page.exposeFunction("pmSaved", (name: string, base64: string) => void (saved[name] = new Uint8Array(Buffer.from(base64, "base64"))));
  await page.addInitScript(() => {
    const w = window as unknown as { showSaveFilePicker: unknown; pmSaved: (name: string, base64: string) => Promise<void> };
    w.showSaveFilePicker = async ({ suggestedName }: { suggestedName: string }) => ({
      name: suggestedName,
      createWritable: async () => ({
        write: async (data: Uint8Array) => {
          let binary = "";
          for (let i = 0; i < data.length; i += 0x8000) binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
          await w.pmSaved(suggestedName, btoa(binary));
        },
        close: async () => {},
      }),
    });
  });
  await page.reload();

  await page.getByRole("button", { name: "New Project" }).click();
  await page.getByRole("tree", { name: "Project items" }).waitFor({ state: "attached" });
  await page.keyboard.press("Control+n");
  const settings = page.getByRole("dialog", { name: "Composition Settings" });
  await settings.waitFor();
  await settings.getByLabel("Composition Name:").fill(COMP);
  await settings.getByLabel("Frame Rate:").fill("30");
  await settings.getByLabel("Duration:").fill("1000");
  await settings.getByRole("button", { name: "OK" }).click();
  await page.getByRole("tab", { name: COMP, exact: true }).waitFor();

  // ---------------------------------------------------------------- the window
  let dialog = await openParticleMatch(page);
  check("Analyze & Train needs a reference video", !(await dialog.getByRole("button", { name: "Analyze & Train" }).count()));
  await shoot(page, dialog, "1-empty");

  await dialog.getByLabel("Reference video").setInputFiles(REFERENCE);
  await dialog.getByLabel("Training start (seconds)").waitFor();
  const sound = await waitFor("the reference's sound", async () => (await dialog.getByText("with sound").count()) > 0, 60_000);
  check("the reference video's sound is read", sound);
  await dialog.getByLabel("Training start (seconds)").fill("50");
  await dialog.getByLabel("Training end (seconds)").fill("80");
  check("Analyze & Train is enabled with a valid window", await dialog.getByRole("button", { name: "Analyze & Train" }).isEnabled());
  await page.waitForTimeout(500);
  await shoot(page, dialog, "2-setup");

  if (withTraining) {
    await dialog.getByRole("button", { name: "Analyze & Train" }).click();
    await dialog.getByRole("button", { name: "Cancel Training" }).waitFor();
    await page.keyboard.press("Escape");
    check("Escape does not close the window while training", await dialog.isVisible());
    await page.waitForTimeout(6000);
    await shoot(page, dialog, "3-training");
    await dialog.getByRole("button", { name: "Cancel Training" }).click();
    await dialog.getByRole("button", { name: "Analyze & Train" }).waitFor();
  }

  await dialog.getByLabel("Trained model").setInputFiles(modelPath);
  await dialog.getByRole("button", { name: "Export to Particular…" }).waitFor();
  await dialog.getByRole("button", { name: "Play" }).click();
  await page.waitForTimeout(2500);
  const learned = await litPixels(dialog.getByLabel("Learned particles"));
  check("the learned particles play beside the reference", learned >= MIN_LIT, `${learned} lit pixels`);
  const report = await dialog.locator(".pm-report").innerText();
  check("the result names what trained the model", /PyTorch \S+ on /.test(report), report.split("\n").slice(0, 4).join(" | "));
  await dialog.getByRole("button", { name: "Pause" }).click();
  await shoot(page, dialog, "4-result");

  // ---------------------------------------------------------------- into the comp
  await dialog.getByRole("button", { name: "Export to Particular…" }).click();
  check("the export offers the open project's comp", (await dialog.getByLabel("Composition").locator("option").allInnerTexts()).some((t) => t.startsWith(COMP)));
  await dialog.getByLabel("Speed follows").selectOption("reference");
  const add = dialog.getByRole("button", { name: /^Add \d+ Layers?$/ });
  check("the export works out the layers", await waitFor("the export's settings", async () => await add.isEnabled(), 30_000), await add.innerText());
  await shoot(page, dialog, "5-export-comp");
  const count = Number(/\d+/.exec(await add.innerText())?.[0]);
  await add.click();
  await dialog.waitFor({ state: "hidden" });
  const timeline = page.getByRole("tree", { name: "Timeline layers" });
  const names = await timeline.getByText(/^Particles( \(\w+\))?$/).allInnerTexts();
  check("the Timeline lists the Particular layers", names.length === count && count > 0, names.join(", "));
  const frame = page.locator(".comp-frame");
  let viewerLit = 0;
  await waitFor("particles in the viewer", async () => (viewerLit = await litPixels(frame)) >= MIN_LIT, 30_000);
  check("the composition viewer draws particles", viewerLit >= MIN_LIT, `${viewerLit} lit pixels`);
  await page.screenshot({ path: join(out, "6-workspace.png") });

  await page.keyboard.press("Control+s");
  await waitFor("the saved project", async () => Object.keys(saved).some((n) => n.endsWith(".aep")), 15_000);
  const addedName = Object.keys(saved).find((n) => n.endsWith(".aep"));
  if (addedName) {
    writeFileSync(join(out, "added.aep"), saved[addedName]);
    const comp = [...Editor.fromBytes(saved[addedName]).project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === COMP);
    check("the saved project re-opens with the Particular layers", !!comp && particularLayers(comp).length === count, `${comp ? particularLayers(comp).length : 0} layers`);
  } else check("the project with the added layers saves", false);

  // ---------------------------------------------------------------- as a new project
  dialog = await openParticleMatch(page);
  check("the window reopens with its session", await dialog.getByRole("button", { name: "Export to Particular…" }).isVisible());
  await dialog.getByRole("button", { name: "Export to Particular…" }).click();
  await dialog.getByLabel("Save as a new project (.aep)").check();
  await dialog.getByLabel("Speed follows").selectOption("reference");
  const include = dialog.getByLabel("Include the reference video (hidden, with its sound)");
  if (!(await include.isChecked())) await include.check();
  const save = dialog.getByRole("button", { name: "Save .aep…" });
  check("the new project's export works out the layers", await waitFor("the export's settings", async () => await save.isEnabled(), 30_000));
  await shoot(page, dialog, "7-export-file");
  const before = new Set(Object.keys(saved));
  await save.click();
  const reported = async () => (await dialog.getByRole("status").allInnerTexts()).some((t) => t.trim().startsWith("Saved"));
  check("Save .aep reports the saved project", await waitFor("the exported project", reported, 60_000));
  const exportedName = Object.keys(saved).find((n) => !before.has(n));
  if (exportedName) {
    writeFileSync(join(out, "standalone.aep"), saved[exportedName]);
    const project = Editor.fromBytes(saved[exportedName]).project;
    const comps = [...project.items.values()].filter((i): i is CompItem => i.kind === "comp");
    const comp = comps[0];
    const footage = comp && project.items.get(comp.layers.at(-1)?.sourceId ?? -1);
    const path = footage?.kind === "footage" && footage.mainSource.sourceType === "FileSource" ? footage.mainSource.file : "";
    check("the exported project holds one comp with the Particular layers", comps.length === 1 && particularLayers(comp).length === count, `${exportedName}: ${comp?.layers.map((l) => l.name).join(", ")}`);
    check("the exported project's reference video is at its path on disk", path.toLowerCase() === REFERENCE.toLowerCase() && comp.layers.at(-1)?.enabled === false, path);
  } else check("Save .aep writes a project", false);
  await shoot(page, dialog, "8-exported");
} finally {
  await browser.close();
  await server?.close();
}

const library = (e: string) => /effect library could not be loaded|effect-library\.json|Expected a JSON module script/.test(e);
if (errors.some(library)) console.log(`not Particle Match's (the effect library's JSON import under the dev server):\n${errors.filter(library).join("\n")}`);
check("no page errors", !errors.some((e) => !library(e)), errors.filter((e) => !library(e)).join("\n"));

const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `${failed.length} of ${checks.length} checks failed` : `PMATCH-EXPORT-PASSED (${checks.length} checks)`);
if (failed.length) process.exit(1);

if (withAerender) {
  const renders: [string, string, number][] = [
    [join(out, "added.aep"), COMP, 150],
    [join(out, "standalone.aep"), "Particle Match", 300],
  ];
  const results: boolean[] = [];
  for (const [project, comp, frameIndex] of renders) {
    const dir = join(out, `ae-${comp.replace(/\W+/g, "_")}`);
    mkdirSync(dir, { recursive: true });
    const result = await aerender(["-project", project, "-comp", comp, "-s", String(frameIndex), "-e", String(frameIndex), "-OMtemplate", process.env.AE_TIFF_TEMPLATE ?? "Secuencia TIFF con alfa", "-output", join(dir, "f_[#####].tif"), "-sound", "OFF"], 300_000);
    const problems = result.output.split(/\r?\n/).filter((l) => /error|no encontrad|not found|missing|falta|ausente/i.test(l));
    const tif = join(dir, `f_${String(frameIndex).padStart(5, "0")}.tif`);
    let lit = 0;
    if (existsSync(tif)) {
      const image = readTiff(new Uint8Array(readFileSync(tif)));
      for (let i = 0; i < image.data.length; i += 4) if (image.data[i + 3] > 64 && image.data[i] + image.data[i + 1] + image.data[i + 2] > 150) lit++;
    }
    const ok = result.code === 0 && !result.timedOut && !problems.length && lit >= MIN_LIT;
    results.push(ok);
    console.log(`${ok ? "ok  " : "FAIL"} After Effects renders "${comp}" of ${project}: exit ${result.code}, ${lit} lit pixels${problems.length ? `, ${problems.slice(0, 4).join(" | ")}` : ""}`);
  }
  if (results.every(Boolean)) console.log("PMATCH-EXPORT-AE-PASSED");
  else process.exit(1);
}
