// Opens a project in the running app, selects the Sound Keys layer of a comp and reads an Output in Effect
// Controls every few frames: first the keyframes the project holds (baked by After Effects), then, with its
// keyframes removed (the stopwatch), the value Sound Keys works out live from the audio. Reports both and how far
// apart they are, in percent of the output range.
//
//   node scripts/check-soundkeys-live.ts <project.aep> <comp> <sound keys layer> [output name] [http://localhost:5173]
import { chromium } from "playwright-core";

const [path, compName, layerName, outputName = "Output 1", base = "http://localhost:5173"] = process.argv.slice(2);
const SAMPLES = 24;
/** Shift+PageDown presses between samples (10 frames each). */
const STRIDE = Number(process.env.SK_STRIDE ?? 12);

const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=d3d11", "--enable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.goto(base);
await page.getByLabel("Open After Effects project").setInputFiles(path);
await page.waitForTimeout(3000);
for (let guard = 0; guard < 200; guard++) {
  const closed = page.locator(".proj-row .twirl:not(.open)");
  if (!(await closed.count())) break;
  await closed.first().click();
}
await page.locator(".proj-row", { has: page.locator(".cell-text", { hasText: new RegExp(`^${compName}$`) }) }).first().dblclick();
await page.waitForTimeout(1500);
const row = page.locator(".tl-layer", { has: page.locator(".c-name .cell-text", { hasText: new RegExp(`^${layerName}$`) }) }).first();
await row.click();
await page.waitForTimeout(500);
await page.getByText(/^Effect Controls/).first().click();
await page.waitForTimeout(500);
const range = `Range ${outputName.replace(/\D/g, "") || "1"}`;
await page.locator(".ec-row", { has: page.locator(".ec-name .cell-text", { hasText: new RegExp(`^${range}$`) }) }).first().click();
await page.waitForTimeout(300);

const output = page.locator(".ec-row", { has: page.locator(".ec-name .cell-text", { hasText: new RegExp(`^${outputName}$`) }) }).first().locator(".ec-value");
const read = async () => Number((await output.innerText()).replace(",", ".").replace(/[^\d.eE+-]/g, ""));

async function sweep(label: string): Promise<number[]> {
  await row.click();
  await page.keyboard.press("Home");
  const values: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    for (let j = 0; j < STRIDE; j++) await page.keyboard.press("Shift+PageDown");
    await page.waitForTimeout(150);
    values.push(await read());
  }
  console.log(`${label}:`, values.map((v) => v.toFixed(1)).join(" "));
  return values;
}

const baked = await sweep("baked");
const stopwatch = page.getByRole("button", { name: `Remove keyframing for ${outputName}` });
if (!(await stopwatch.count())) {
  console.log(`${outputName} has no keyframes to remove`);
  await browser.close();
  process.exit(1);
}
await stopwatch.first().click();
await page.waitForTimeout(3000);
const live = await sweep("live");
const apply = page.getByRole("button", { name: "Apply", exact: true }).first();
await apply.click();
const status = page.locator(".ec-status");
await status.waitFor({ timeout: 120_000 });
for (let i = 0; i < 240 && /Analysing/.test(await status.innerText()); i++) await page.waitForTimeout(500);
console.log("apply:", await status.innerText());
const applied = await sweep("applied");
const span = Math.max(...baked) - Math.min(...baked) || 1;
const report = (label: string, values: number[], against: number[]) => {
  const errors = against.map((b, i) => (Math.abs(values[i] - b) / span) * 100);
  const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
  console.log(`|${label}|: mean ${mean.toFixed(1)}%, max ${Math.max(...errors).toFixed(1)}% of the baked range`);
};
report("live - baked", live, baked);
report("live - applied", live, applied);
report("applied - baked", applied, baked);
await page.screenshot({ path: "refs/probe-soundkeys-live.png" });
await browser.close();
