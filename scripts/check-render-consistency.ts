// Compares a composition's exported frames with its preview frames in the running dev server's
// app (headless Edge, real GPU): renders the first `frames` frames through the Render Queue,
// steps the viewer over the same frames (waiting for footage to finish loading), and reports
// each frame's mean difference at a small size. Codec noise stays at a few levels; a stale,
// blank or shifted video frame stands out.
//
//   node scripts/check-render-consistency.ts <project.aep> <comp> [frames=60] [fast|good|high|png] [http://localhost:5173]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { unzipSync } from "fflate";
import { chromium } from "playwright-core";
import { encodePng } from "./lib/png.ts";

const [path, compName, framesArg = "60", quality = "high", base = "http://localhost:5173"] = process.argv.slice(2);
const count = Number(framesArg);
const W = Number(process.env.CMP_W ?? 192);
const H = Math.round((W * 9) / 16);
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.goto(base);
await page.evaluate(() => delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker);
await page.locator('input[type="file"][accept=".aep"]').setInputFiles(path);
for (let i = 0; i < 120; i++) {
  await page.waitForTimeout(1000);
  if (i > 5 && (await page.evaluate(() => !!(window as any).aepFootage && !(window as any).aepFootage.busy))) break;
}
for (let guard = 0; guard < 300; guard++) {
  const closed = page.locator(".proj-row .twirl:not(.open)");
  if (!(await closed.count())) break;
  await closed.first().click();
}
await page.locator(".proj-row", { has: page.locator(".cell-text", { hasText: new RegExp(`^${compName}$`) }) }).first().dblclick();
await page.waitForTimeout(1500);

// START is a timecode such as 0:00:15:00; without it the comparison starts at the comp's start.
const start = process.env.START;
const goToStart = async () => {
  if (!start) return page.keyboard.press("Home");
  await page.locator(".tl-timecode").first().click();
  await page.locator(".tl-timecode-input").fill(start);
  await page.keyboard.press("Enter");
};

// Work area: B at the start, N after `count` frames.
await goToStart();
await page.keyboard.press("b");
for (let i = 0; i < count; i++) await page.keyboard.press("PageDown");
await page.keyboard.press("n");
await goToStart();

await page.keyboard.press("Control+m");
await page.waitForTimeout(500);
const png = quality === "png";
if (png) await page.locator(".rq-field", { hasText: "Format" }).locator("select").first().selectOption("png");
else await page.locator(".rq-field", { hasText: "Quality" }).locator("select").first().selectOption(quality);
const download = page.waitForEvent("download", { timeout: 30 * 60_000 });
await page.getByRole("button", { name: "Render", exact: true }).click();
const file = await download;
mkdirSync("refs/probe", { recursive: true });
const out = `refs/probe/consistency-${quality}.${png ? "zip" : "mp4"}`;
await file.saveAs(out);
console.log(`rendered ${out}; ${(await page.locator(".rq-status").allInnerTexts()).join(" | ")}`);
const log = await page.locator(".rq-panel, .render-queue").first().innerText().catch(() => "");
console.log(`render queue panel: ${log.replace(/\s+/g, " ").slice(0, 700)}`);

// Back to the Composition panel: the viewer at each frame, once its footage has loaded.
await page.keyboard.press("Escape");
await page.locator(".proj-row", { has: page.locator(".cell-text", { hasText: new RegExp(`^${compName}$`) }) }).first().dblclick();
await page.waitForTimeout(800);
await goToStart();
const preview: Uint8Array[] = [];
const loadingFrames: number[] = [];
for (let f = 0; f < count; f++) {
  if (f > 0) await page.keyboard.press("PageDown");
  let loading = true;
  for (let wait = 0; wait < 60 && loading; wait++) {
    await page.waitForTimeout(wait ? 100 : 60);
    loading = await page.evaluate(() => (window as any).aepFootage.busy);
  }
  // Settled: one more frame of time for the viewer to draw what arrived.
  await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 150));
  if (loading) loadingFrames.push(f);
  if (f === 0 || f === count - 1) console.log(`preview notes at frame ${f}: ${(await page.locator(".render-notes").allInnerTexts()).join(" ").slice(0, 500)}`);
  // Over the comp's background colour (what the viewer shows behind it), as an export flattens it.
  const url: string = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".comp-canvas")!;
    const probe = document.createElement("canvas");
    probe.width = canvas.width;
    probe.height = canvas.height;
    const ctx = probe.getContext("2d")!;
    ctx.fillStyle = getComputedStyle(canvas.parentElement!).backgroundColor || "#000";
    ctx.fillRect(0, 0, probe.width, probe.height);
    ctx.drawImage(canvas, 0, 0);
    return probe.toDataURL("image/png");
  });
  const dir = "refs/probe/consistency-preview";
  if (f === 0) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(`${dir}/f_${String(f).padStart(5, "0")}.png`, Buffer.from(url.slice(url.indexOf(",") + 1), "base64"));
}
await browser.close();

let input = out;
if (png) {
  const dir = "refs/probe/consistency-png";
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const names = Object.entries(unzipSync(readFileSync(out))).sort(([a], [b]) => a.localeCompare(b));
  names.forEach(([, data], i) => writeFileSync(`${dir}/f_${String(i).padStart(5, "0")}.png`, data));
  input = `${dir}/f_%05d.png`;
}
// Both sides scaled by the same filter, so sampling differences cancel.
const frames = (source: string) => {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", source, "-vf", `scale=${W}:${H}:flags=area`, "-pix_fmt", "rgba", "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
  return Array.from({ length: Math.floor(raw.length / (W * H * 4)) }, (_, i) => raw.subarray(i * W * H * 4, (i + 1) * W * H * 4));
};
const size = W * H * 4;
const exported = frames(input);
preview.push(...frames("refs/probe/consistency-preview/f_%05d.png"));
console.log(`${exported.length} exported frames, ${preview.length} preview frames; preview frames still loading: ${loadingFrames.join(",") || "none"}`);
const diff = (a: Uint8Array, b: Uint8Array) => {
  let sum = 0;
  for (let i = 0; i < size; i += 4) for (let c = 0; c < 3; c++) sum += Math.abs(a[i + c] - b[i + c]);
  return sum / (W * H * 3);
};
const rows: string[] = [];
let bad = 0;
for (let f = 0; f < Math.min(exported.length, preview.length); f++) {
  const d = diff(exported[f], preview[f]);
  // Which preview frame the exported one looks most like: a stale or shifted frame matches a neighbour.
  let best = f;
  for (let g = Math.max(0, f - 20); g <= Math.min(preview.length - 1, f + 20); g++) if (diff(exported[f], preview[g]) < diff(exported[f], preview[best])) best = g;
  if (d > 4) bad++;
  const near = (g: number) => (g >= 0 && g < preview.length ? diff(exported[f], preview[g]).toFixed(1) : "-");
  rows.push(`${f}: ${d.toFixed(2)}${best !== f ? ` (closest preview frame ${best})` : ""}${process.env.NEIGHBOURS ? ` [${near(f - 1)}|${near(f + 1)}]` : ""}`);
}
console.log(rows.join("  "));
console.log(`${bad} frames differ by more than 4/255 on average`);
const level = (f: Uint8Array) => f.reduce((sum, v, i) => (i % 4 === 3 ? sum : sum + v), 0) / ((f.length * 3) / 4);
console.log(`mean exported level ${(exported.reduce((sum, f) => sum + level(f), 0) / exported.length).toFixed(1)}/255 (near 0: nothing on screen to compare)`);
// The worst frame side by side (export | preview), for looking at.
const worst = rows.map((r) => Number(r.split(": ")[1].split(" ")[0])).reduce((w, d, i, all) => (d > all[w] ? i : w), 0);
const sheet = new Uint8Array(W * 3 * H * 4);
for (let y = 0; y < H; y++) {
  sheet.set(exported[worst].subarray(y * W * 4, (y + 1) * W * 4), y * W * 12);
  sheet.set(preview[worst].subarray(y * W * 4, (y + 1) * W * 4), y * W * 12 + W * 4);
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const d = Math.min(255, 4 * Math.max(...[0, 1, 2].map((c) => Math.abs(exported[worst][i + c] - preview[worst][i + c]))));
    sheet.set([d, d, d], y * W * 12 + W * 8 + x * 4);
  }
}
for (let i = 3; i < sheet.length; i += 4) sheet[i] = 255;
writeFileSync(`refs/probe/consistency-worst.png`, encodePng(W * 3, H, sheet));
console.log(`worst frame ${worst}: refs/probe/consistency-worst.png (export | preview | difference x4)`);
