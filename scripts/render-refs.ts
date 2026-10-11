// Renders reference frames for every comp of every fixture suite
// (refs/fixtures/*manifest.json and *.approximations.json) with After Effects'
// aerender in render-only mode, as TIFF with alpha, into
// refs/frames/<comp>/frame_#####.tif. Comps whose frames already exist are
// skipped. Runs are serialized machine-wide.
//
// With --strict, a comp also fails when After Effects reports an unavailable
// effect or an error while opening or rendering it, and each comp rendered
// cleanly is recorded in refs/fixtures/<suite>.rendered.json against the
// SHA-256 of the project file it was rendered from; a comp counts as rendered
// only while that record matches the project. ALL-COMPS-RENDERED is printed
// when every selected comp is.
//
//   node scripts/render-refs.ts [--force] [--strict] [--only name,name] [--suite manifestBaseName]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aerender } from "./aerender.ts";
import { framePath, loadSuites, ROOT } from "./lib/suites.ts";

// The render engine runs in the system locale; this is the Spanish name of "TIFF Sequence with Alpha".
const TIFF_TEMPLATE = process.env.AE_TIFF_TEMPLATE ?? "Secuencia TIFF con alfa";
const root = ROOT;
const force = process.argv.includes("--force");
const strict = process.argv.includes("--strict");
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg >= 0 ? new Set(process.argv[onlyArg + 1].split(",")) : undefined;
const suiteArg = process.argv.indexOf("--suite");

/** After Effects' report of effects it cannot find (English and Spanish engines). */
const UNAVAILABLE_EFFECT = /unavailable effect|missing effect|efectos? no disponibles?/i;

interface RenderRecord {
  /** SHA-256 of the project file the comps were rendered from. */
  project: string;
  comps: string[];
}

let rendered = 0;
let failed = 0;
let current = 0;
let selected = 0;
for (const suite of loadSuites(suiteArg >= 0 ? process.argv[suiteArg + 1] : undefined, true)) {
  const projectPath = join(root, "fixtures", suite.project);
  const recordPath = join(root, "fixtures", suite.file.replace(/(manifest|approximations)\.json$/, "rendered.json"));
  const sha = strict && existsSync(projectPath) ? createHash("sha256").update(readFileSync(projectPath)).digest("hex") : "";
  let record: RenderRecord = { project: sha, comps: [] };
  if (strict && existsSync(recordPath)) {
    const previous = JSON.parse(readFileSync(recordPath, "utf8")) as RenderRecord;
    if (previous.project === sha) record = previous;
  }
  const done = new Set(record.comps);
  for (const { comp, frames } of suite.comps) {
    if (only && !only.has(comp)) continue;
    selected++;
    const present = frames.every((f) => existsSync(framePath(comp, f)));
    if (!force && present && (!strict || done.has(comp))) {
      current++;
      continue;
    }
    mkdirSync(join(root, "frames", comp), { recursive: true });
    const step = frames.length > 1 ? frames[1] - frames[0] : 1;
    // aerender takes one increment, so an uneven list would save the wrong frames under its numbers.
    if (frames.some((f, k) => f !== frames[0] + k * step)) {
      failed++;
      console.log(`FAIL ${comp}: frames ${frames.join(",")} are not evenly spaced`);
      continue;
    }
    const args = [
      "-project", projectPath,
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
    // With an increment, aerender numbers its outputs consecutively from the start frame rather than by comp frame.
    if (step > 1) {
      for (let k = frames.length - 1; k > 0; k--) {
        const written = framePath(comp, frames[0] + k);
        if (existsSync(written)) renameSync(written, framePath(comp, frames[k]));
      }
    }
    const missing = frames.filter((f) => !existsSync(framePath(comp, f)));
    const lines = result.output.split("\n");
    const complaints = strict ? lines.filter((l) => /^ERROR/i.test(l.trim()) || (/^WARNING/i.test(l.trim()) && UNAVAILABLE_EFFECT.test(l))) : [];
    if (result.timedOut || missing.length || complaints.length) {
      failed++;
      done.delete(comp);
      console.log(`FAIL ${comp}: ${result.timedOut ? "timed out" : missing.length ? `missing frames ${missing.join(",")}` : "After Effects reported a problem"}`);
      console.log((complaints.length ? complaints : lines.filter((l) => /ERROR|Error|error/.test(l))).slice(0, 5).join("\n"));
    } else {
      rendered++;
      done.add(comp);
      console.log(`ok ${comp} (${frames.length} frames, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
    }
    if (strict) writeFileSync(recordPath, JSON.stringify({ project: sha, comps: [...done].sort() }, null, 1) + "\n");
  }
}
console.log(`rendered ${rendered} comps, ${failed} failed${strict ? `, ${current} already rendered from the same project` : ""}`);
if (strict && !failed && rendered + current === selected && selected > 0) console.log("ALL-COMPS-RENDERED");
process.exit(failed ? 1 : 0);
