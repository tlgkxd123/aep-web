// Renders reference frames for every comp in refs/fixtures/manifest.json with
// After Effects' aerender (render-only mode), as TIFF with alpha, into
// refs/frames/<comp>/frame_#####.tif. Comps whose frames already exist are skipped.
//
//   node scripts/render-refs.ts [--force] [--only name,name]
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { aerender } from "./aerender.ts";

// The render engine runs in the system locale; this is the Spanish name of "TIFF Sequence with Alpha".
const TIFF_TEMPLATE = process.env.AE_TIFF_TEMPLATE ?? "Secuencia TIFF con alfa";
const root = resolve("refs");
const manifest = JSON.parse(readFileSync(join(root, "fixtures", "manifest.json"), "utf8")) as {
  project: string;
  comps: { comp: string; frames: number[] }[];
};
const force = process.argv.includes("--force");
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? new Set(process.argv[onlyArg + 1].split(",")) : undefined;

export const framePath = (comp: string, frame: number) => join(root, "frames", comp, `frame_${String(frame).padStart(5, "0")}.tif`);

let rendered = 0;
let failed = 0;
for (const { comp, frames } of manifest.comps) {
  if (only && !only.has(comp)) continue;
  if (!force && frames.every((f) => existsSync(framePath(comp, f)))) continue;
  mkdirSync(join(root, "frames", comp), { recursive: true });
  const step = frames.length > 1 ? frames[1] - frames[0] : 1;
  const args = [
    "-project", join(root, "fixtures", manifest.project),
    "-comp", comp,
    "-s", String(frames[0]),
    "-e", String(frames[frames.length - 1]),
    "-i", String(step),
    "-OMtemplate", TIFF_TEMPLATE,
    "-output", join(root, "frames", comp, "frame_[#####].tif"),
    "-sound", "OFF",
  ];
  const started = Date.now();
  for (const f of frames) rmSync(framePath(comp, f), { force: true });
  const result = await aerender(args, 180_000);
  // With an increment, aerender numbers its outputs 0, 1, 2... rather than by comp frame.
  if (step > 1) {
    for (let k = frames.length - 1; k > 0; k--) {
      const written = framePath(comp, k);
      if (existsSync(written)) renameSync(written, framePath(comp, frames[k]));
    }
  }
  const missing = frames.filter((f) => !existsSync(framePath(comp, f)));
  if (result.timedOut || missing.length) {
    failed++;
    console.log(`FAIL ${comp}: ${result.timedOut ? "timed out" : `missing frames ${missing.join(",")}`}`);
    console.log(result.output.split("\n").filter((l) => /ERROR|Error|error/.test(l)).slice(0, 5).join("\n"));
  } else {
    rendered++;
    console.log(`ok ${comp} (${frames.length} frames, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
  }
}
console.log(`rendered ${rendered} comps, ${failed} failed`);
process.exit(failed ? 1 : 0);
