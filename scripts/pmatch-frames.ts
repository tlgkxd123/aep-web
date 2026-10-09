// A reference frame next to the model rendered over the reference's background at the same time:
//   node scripts/pmatch-frames.ts <time> [--model <file>] [--video <path>]
// Writes dist-tools/pmatch/frames/<time>-reference.png and <time>-model.png.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPmatch, PMATCH_OUT, REFERENCE } from "./lib/pmatch-browser.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const time = Number(args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? 150);
const model = readFileSync(option("--model") ?? join(PMATCH_OUT, "model.pmwm"));
const out = join(PMATCH_OUT, "frames");
mkdirSync(out, { recursive: true });

const browser = await openPmatch();
try {
  const url = browser.serve(option("--video") ?? REFERENCE, "reference.mp4");
  await browser.call("frames", url, browser.serveBytes(model, "model.pmwm"), time, "frame");
  for (const part of ["reference", "model"]) writeFileSync(join(out, `${time}-${part}.png`), browser.uploaded(`frame-${part}.png`));
  console.log(`wrote ${join(out, `${time}-reference.png`)} and ${time}-model.png`);
} finally {
  await browser.close();
}
