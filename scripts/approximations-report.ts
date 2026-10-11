// Measures the comps a suite lists in refs/fixtures/<suite>.approximations.json, whose
// renderers only approximate After Effects, against their After Effects references.
// They are not part of the pixel gate: the report runs scripts/pixel-report.ts on a
// temporary refs root holding only them, prints its rows with the reasons, and prints
// APPROXIMATIONS-MEASURED when every listed frame has a reference and was measured.
//
//   node scripts/approximations-report.ts <suite> [--no-build]
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";

const suite = process.argv[2];
if (!suite || suite.startsWith("--")) throw new Error("usage: node scripts/approximations-report.ts <suite> [--no-build]");
const approx = JSON.parse(readFileSync(join(ROOT, "fixtures", `${suite}.approximations.json`), "utf8")) as {
  project: string;
  comps: { comp: string; frames: number[]; fps?: number }[];
  reasons: Record<string, string>;
};
const temp = mkdtempSync(join(tmpdir(), `${suite}-approx-`));
let missing = 0;
try {
  mkdirSync(join(temp, "fixtures"));
  copyFileSync(join(ROOT, "fixtures", approx.project), join(temp, "fixtures", approx.project));
  writeFileSync(join(temp, "fixtures", "approx.manifest.json"), JSON.stringify({ project: approx.project, comps: approx.comps }));
  for (const { comp, frames } of approx.comps) {
    mkdirSync(join(temp, "frames", comp), { recursive: true });
    for (const frame of frames) {
      if (!existsSync(framePath(comp, frame))) {
        missing++;
        console.log(`NO REF ${comp}@${frame}`);
        continue;
      }
      copyFileSync(framePath(comp, frame), join(temp, "frames", comp, `frame_${String(frame).padStart(5, "0")}.tif`));
    }
  }
  const args = ["scripts/pixel-report.ts", "--suite", "approx"];
  if (process.argv.includes("--no-build")) args.push("--no-build");
  let output = "";
  try {
    output = execFileSync(process.execPath, args, { env: { ...process.env, AEP_REFS: temp }, encoding: "utf8" });
  } catch (error) {
    output = (error as { stdout?: string }).stdout ?? String(error);
  }
  const rows = output.split("\n").filter((l) => /^(ok|DIFF|known|NO REF)\s/.test(l));
  for (const { comp, frames } of approx.comps) {
    for (const frame of frames) {
      const row = rows.find((l) => l.split(/\s+/)[1] === `${comp}@${frame}`);
      if (!row || row.startsWith("NO REF")) missing++;
      console.log(`${row ?? `NOT MEASURED ${comp}@${frame}`}  - ${approx.reasons[comp]}`);
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
if (missing) process.exit(1);
console.log("APPROXIMATIONS-MEASURED");
