// Times the Render Queue's GPU frame source (MP4 at Ultra fast or Decent quality, encoder left out) on a project's
// comp at full resolution in headless Edge: frames per second and where each frame's time goes.
//
//   node scripts/bench-export.ts <project.aep> <comp> [start seconds=0] [frames=60] [--discrete] [--no-build]
import { openHarness } from "./lib/harness-page.ts";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const [path, comp, start = "0", frames = "60"] = positional;
const { browser, page } = await openHarness(path, { discrete: args.includes("--discrete"), build: !args.includes("--no-build") });
const result = (await page.evaluate(([c, s, n]) => (globalThis as any).aepHarness.exportFrames(c, s, n), [comp, Number(start), Number(frames)] as const)) as {
  fps: number;
  stats: string;
};
console.log(`${comp}: ${result.fps.toFixed(2)} frames per second; ${result.stats}`);
await browser.close();
