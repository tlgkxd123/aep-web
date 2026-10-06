// Opens a project in the running dev server's app (headless Edge), starts preview
// playback with Space and reports the Web Audio sources the app started (offset into
// the file, duration, rate) against the playhead, to check preview audio and its sync.
//
//   node scripts/check-preview-audio.ts <project.aep> [http://localhost:5173]
import { chromium } from "playwright-core";

const [path, base = "http://localhost:5173"] = process.argv.slice(2);
const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (e) => console.log("page error:", e.message));
await page.addInitScript(() => {
  const log: unknown[] = [];
  (window as any).audioLog = log;
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when?: number, offset?: number, duration?: number) {
    log.push({ when: (when ?? 0) - this.context.currentTime, offset, duration, rate: this.playbackRate.value, buffer: this.buffer?.duration, state: this.context.state });
    return start.call(this, when, offset, duration);
  };
});
await page.goto(base);
await page.locator('input[type="file"][accept=".aep"]').setInputFiles(path);
await page.waitForTimeout(8000);
const timecode = async () => (await page.locator(".tl-timecode, .timecode, [class*='timecode']").first().innerText().catch(() => "?")).trim();
console.log("before play, playhead:", await timecode());
await page.keyboard.press("Space");
await page.waitForTimeout(4000);
console.log("after 4 s of playback, playhead:", await timecode());
await page.keyboard.press("Space");
const log = (await page.evaluate(() => (window as any).audioLog)) as { when: number; offset: number; duration: number; rate: number; buffer: number; state: string }[];
console.log(`audio sources started: ${log.length}`);
for (const e of log.slice(0, 12)) console.log(`  in ${e.when.toFixed(3)} s, from ${e.offset.toFixed(3)} s for ${e.duration.toFixed(2)} s at rate ${e.rate} (file ${e.buffer.toFixed(1)} s, context ${e.state})`);
await browser.close();
