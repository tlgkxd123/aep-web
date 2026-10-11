// Checks rendering at reduced resolutions (Half, Third, Quarter): each frame rendered at 1/factor against the
// full-resolution render averaged over factor x factor blocks, with the time each took, in headless Edge on the
// machine's GPU. Footage is located on disk like the dev server does.
//
//   node scripts/check-render-scale.ts <project.aep> "<comp>@<seconds>[,...]" [--factors 2,4] [--max-mean 2]
//     [--max-gross 0.01] [--require] [--discrete] [--no-build]
//
// A frame passes when its mean error (of 255, premultiplied channels) is at most --max-mean and at most
// --max-gross of its pixels are off by more than 24 in a channel.
import { openHarness } from "./lib/harness-page.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const [path, specArg] = args;
const frames = specArg.split(",").map((spec) => {
  const match = /^(.*)@([\d.]+)$/.exec(spec.trim());
  if (!match) throw new Error(`expected <comp>@<seconds>, got ${spec}`);
  return { comp: match[1], time: Number(match[2]) };
});
const factors = opt("--factors", "2,4").split(",").map(Number);
const maxMean = Number(opt("--max-mean", "2"));
const maxGross = Number(opt("--max-gross", "0.01"));

const { browser, page } = await openHarness(path, { discrete: args.includes("--discrete"), build: !args.includes("--no-build") });
let failed = false;
for (const { comp, time } of frames) {
  for (const factor of factors) {
    const r = (await page.evaluate(([c, t, f]) => (globalThis as any).aepHarness.compareScale(c, t, f), [comp, time, factor] as const)) as {
      meanError: number;
      grossShare: number;
      scaledMs: number;
      fullMs: number;
    };
    const ok = r.meanError <= maxMean && r.grossShare <= maxGross;
    if (!ok) failed = true;
    console.log(
      `${comp}@${time} 1/${factor}: ${ok ? "SCALE-MATCH" : "SCALE-DIFFERENT"} mean error ${r.meanError.toFixed(2)}/255, ${(100 * r.grossShare).toFixed(2)}% of pixels off by more than 24; ${r.scaledMs.toFixed(1)} ms against ${r.fullMs.toFixed(1)} ms at full resolution`,
    );
  }
}
await browser.close();
if (!failed) console.log(`SCALE-ALL-MATCH frames=${frames.length} factors=${factors.join(",")}`);
if (args.includes("--require") && failed) process.exit(1);
