// Checks that reusing layer images between frames (src/render/layerKeys.ts) changes no pixel: renders runs of
// consecutive frames in headless Edge on the machine's GPU, each with the cache and with a renderer that renders
// every layer anew, and compares the premultiplied pixels exactly. Footage is located on disk like the dev server
// does.
//
//   node scripts/check-render-cache.ts <project.aep> "<comp>@<start seconds>:<frames>[,...]" [--require] [--discrete] [--no-build]
import { openHarness } from "./lib/harness-page.ts";

const args = process.argv.slice(2);
const [path, specArg] = args;
const runs = specArg.split(",").map((spec) => {
  const match = /^(.*)@([\d.]+):(\d+)$/.exec(spec.trim());
  if (!match) throw new Error(`expected <comp>@<start>:<frames>, got ${spec}`);
  return { comp: match[1], start: Number(match[2]), frames: Number(match[3]) };
});

const { browser, page } = await openHarness(path, { discrete: args.includes("--discrete"), build: !args.includes("--no-build") });
let failed = false;
for (const run of runs) {
  const result = (await page.evaluate(([c, s, n]) => (globalThis as any).aepHarness.compareReuse(c, s, n), [run.comp, run.start, run.frames] as const)) as {
    frames: number;
    different: { frame: number; bytes: number; worst: number }[];
    incomplete: number;
    hits: number;
    misses: number;
    cachedMs: number;
    freshMs: number;
  };
  const ok = result.different.length === 0 && result.incomplete === 0;
  if (!ok) failed = true;
  const timing = `${(result.cachedMs / result.frames).toFixed(1)} ms per frame with the cache, ${(result.freshMs / result.frames).toFixed(1)} without`;
  console.log(
    `${run.comp}: ${ok ? "CACHE-IDENTICAL" : "CACHE-DIFFERENT"} frames=${result.frames} hits=${result.hits} misses=${result.misses} incomplete=${result.incomplete}; ${timing}`,
  );
  for (const d of result.different.slice(0, 10)) console.log(`  frame ${d.frame}: ${d.bytes} bytes differ, by up to ${d.worst}`);
}
await browser.close();
if (args.includes("--require") && failed) process.exit(1);
