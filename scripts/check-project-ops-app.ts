// End-to-end check of the project operations in the running dev server's app
// (headless Edge): New Project, New Composition, Import File through the local
// footage browser, a folder, drag and drop, Replace Footage, Duplicate and
// Save As. Writes the saved project to refs/probe-projectops-ui.aep and
// screenshots to refs/probe-projectops-*.png, and checks the browse/identify
// endpoints' token protection. With --aerender, After Effects then opens the
// saved project and renders its composition.
//
//   node scripts/check-project-ops-app.ts [http://localhost:5173] [--aerender]
// Without a URL it starts its own dev server.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "vite";
import { parseProject } from "../src/aep/parse.ts";
import { probeMedia } from "../src/media/probe.ts";
import { aerender } from "./aerender.ts";

const args = process.argv.slice(2);
const withAerender = args.includes("--aerender");
const given = args.find((a) => !a.startsWith("--"));
const server = given ? undefined : await createServer({ server: { port: 0 }, logLevel: "error" });
if (server) await server.listen();
const base = given ?? server!.resolvedUrls!.local[0].replace(/\/$/, "");
const media = resolve("refs/media");
const checks: [string, boolean, string?][] = [];
const check = (what: string, ok: boolean, detail?: string) => {
  checks.push([what, ok, detail]);
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? `: ${detail}` : ""}`);
};

// ---------------------------------------------------------------- endpoints
const html = await (await fetch(base)).text();
const token = /name="aep-local-footage" content="([0-9a-f]+)"/.exec(html)?.[1];
if (!token) throw new Error("no local footage token in the served page");
const post = (endpoint: string, body: object) =>
  fetch(`${base}/__aep/footage/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
check("browse refuses a wrong token", (await post("browse", { token: "wrong", dir: media })).status === 403);
check("identify refuses a wrong token", (await post("identify", { token: "wrong", files: [] })).status === 403);
const listing = (await (await post("browse", { token, dir: media })).json()) as { entries: { name: string }[] };
check("browse lists the media folder", listing.entries.some((e) => e.name === "straight.png"), `${listing.entries.length} entries`);
const bmp = statSync(resolve(media, "still.bmp"));
const identified = (await (await post("identify", { token, files: [{ name: "still.bmp", size: bmp.size, lastModified: bmp.mtimeMs }] })).json()) as { paths: (string | null)[] };
check("identify finds a picked file's absolute path", identified.paths[0]?.toLowerCase() === resolve(media, "still.bmp").toLowerCase(), String(identified.paths[0]));
const wrongSize = (await (await post("identify", { token, files: [{ name: "still.bmp", size: 1, lastModified: bmp.mtimeMs }] })).json()) as { paths: (string | null)[] };
check("identify does not guess", wrongSize.paths[0] === null);
const unlisted = await fetch(`${base}/__aep/footage/file?token=${token}&file=${encodeURIComponent("C:\\Windows\\win.ini")}`);
check("files outside the listings stay unreadable", unlisted.status === 403);

// ---------------------------------------------------------------- the app
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("console error:", m.text()));
await page.goto(base);
await page.evaluate(() => localStorage.clear());
await page.reload();

const items = page.getByRole("tree", { name: "Project items" });
const row = (name: string) => items.locator(".proj-row", { has: page.locator(".cell-text", { hasText: new RegExp(`^${name.replace(/\./g, "\\.")}$`) }) });

await page.getByRole("button", { name: "New Project" }).click();
await items.waitFor({ state: "attached" });
check("New Project", (await page.title()) === "Untitled Project.aep - AEP Web", await page.title());

await page.keyboard.press("Control+n");
const dialog = page.getByRole("dialog", { name: "Composition Settings" });
await dialog.waitFor();
await dialog.getByLabel("Composition Name:").fill("ui_comp");
await dialog.getByLabel("Width:").fill("320");
await dialog.getByLabel("Frame Rate:").fill("24");
await dialog.getByLabel("Duration:").fill("200");
await page.screenshot({ path: "refs/probe-projectops-dialog.png" });
await dialog.getByRole("button", { name: "OK" }).click();
await row("ui_comp").waitFor();
check("New Composition", (await row("ui_comp").locator(".pc-size").innerText()) === "320 x 180", await row("ui_comp").locator(".pc-size").innerText());

await page.keyboard.press("Control+i");
const importer = page.getByRole("dialog", { name: "Import File" });
await importer.waitFor();
await importer.getByLabel("Folder").fill(media);
await importer.getByLabel("Folder").press("Enter");
await importer.getByRole("option", { name: /straight\.png/ }).click();
await importer.getByRole("option", { name: /photo\.jpg/ }).click({ modifiers: ["Control"] });
await page.screenshot({ path: "refs/probe-projectops-import.png" });
await importer.getByRole("button", { name: "Import" }).click();
await row("straight.png").waitFor();
const path = await row("straight.png").locator(".pc-path").innerText();
check("Import records the absolute path", path.toLowerCase() === resolve(media, "straight.png").toLowerCase(), path);
check("imported footage is located", (await items.locator(".proj-row.missing").count()) === 0);

await page.keyboard.press("Control+Alt+Shift+N");
const nameField = items.getByLabel("Item name");
await nameField.fill("Footage");
await nameField.press("Enter");
await row("Footage").waitFor();
await row("straight.png").dragTo(row("Footage"));
await row("straight.png").and(page.locator('[aria-level="2"]')).waitFor({ timeout: 10_000 }).catch(() => {});
check("drag into a folder", (await row("straight.png").getAttribute("aria-level")) === "2", `level ${await row("straight.png").getAttribute("aria-level")}`);

await row("photo.jpg").click();
await page.keyboard.press("Control+h");
const replacer = page.getByRole("dialog", { name: /Replace Footage File/ });
await replacer.waitFor();
await replacer.getByRole("option", { name: /big\.png/ }).dblclick();
await row("big.png").waitFor();
check("Replace Footage", (await row("big.png").locator(".pc-path").innerText()).toLowerCase() === resolve(media, "big.png").toLowerCase());

await row("ui_comp").click();
await page.keyboard.press("Control+d");
await row("ui_comp 2").waitFor();
check("Duplicate", true);

await page.keyboard.press("Control+z");
await row("ui_comp 2").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
check("Undo Duplicate", (await row("ui_comp 2").count()) === 0);

await page.screenshot({ path: "refs/probe-projectops-workspace.png" });

// Save As through a stand-in for the File System Access picker, which a headless browser cannot answer.
await page.evaluate(() => {
  const w = window as unknown as { showSaveFilePicker: unknown; savedProject?: number[] };
  w.showSaveFilePicker = async () => ({
    name: "projectops-ui.aep",
    createWritable: async () => ({
      write: async (data: Uint8Array) => {
        w.savedProject = Array.from(data);
      },
      close: async () => {},
    }),
  });
});
check("unsaved changes are marked", (await page.title()).includes(" *"), await page.title());
await page.keyboard.press("Control+s");
await page.waitForFunction(() => !document.title.includes(" *"));
check("Save", (await page.title()) === "projectops-ui.aep - AEP Web", await page.title());
const bytes = new Uint8Array(await page.evaluate(() => (window as unknown as { savedProject: number[] }).savedProject));
writeFileSync("refs/probe-projectops-ui.aep", bytes);
const saved = parseProject(bytes);
const summary = [...saved.items.values()].map((i) => `${i.kind}:${i.name}`).sort();
check("the saved project re-opens", summary.join(",") === "comp:ui_comp,folder:Footage,footage:big.png,footage:straight.png", summary.join(", "));
await browser.close();
await server?.close();

if (withAerender) {
  const out = resolve("refs/probe/projectops-ui");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const result = await aerender([
    "-project", resolve("refs/probe-projectops-ui.aep"),
    "-comp", "ui_comp",
    "-s", "0",
    "-e", "0",
    "-OMtemplate", process.env.AE_TIFF_TEMPLATE ?? "Secuencia TIFF con alfa",
    "-output", resolve(out, "ui_[#####].tif"),
    "-sound", "OFF",
  ]);
  const frame = resolve(out, "ui_00000.tif");
  let size = "no frame";
  try {
    const info = await probeMedia(new Blob([readFileSync(frame)]), "ui_00000.tif");
    size = `${info.width} x ${info.height}`;
  } catch {
    // Reported below as a failed check.
  }
  check("After Effects opens the saved project and renders its comp", result.code === 0 && size === "320 x 180", `exit ${result.code}, ${size}`);
}

const failed = checks.filter(([, ok]) => !ok);
console.log(failed.length ? `${failed.length} of ${checks.length} checks failed` : `PROJECT-OPS-APP-PASSED (${checks.length} checks)`);
process.exitCode = failed.length ? 1 : 0;
