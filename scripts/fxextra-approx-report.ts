// Measures the plugin look-alikes listed in refs/fixtures/fxextra.approximations.json
// (Sound Keys, Particular) against their After Effects references. These frames are
// not part of the pixel gate: the report runs scripts/pixel-report.ts on a temporary
// refs root holding copies of only them, then adds the error over the pixels either
// image draws over the background.
//
//   node scripts/fxextra-approx-report.ts [--no-build]
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const approx = JSON.parse(readFileSync(join(ROOT, "fixtures", "fxextra.approximations.json"), "utf8")) as {
  project: string;
  comps: { comp: string; frames: number[] }[];
  reasons: Record<string, string>;
};
const temp = mkdtempSync(join(tmpdir(), "fxextra-approx-"));
try {
  mkdirSync(join(temp, "fixtures"));
  copyFileSync(join(ROOT, "fixtures", approx.project), join(temp, "fixtures", approx.project));
  writeFileSync(join(temp, "fixtures", "fxextra-approx.manifest.json"), JSON.stringify({ project: approx.project, comps: approx.comps }));
  for (const { comp, frames } of approx.comps) {
    mkdirSync(join(temp, "frames", comp), { recursive: true });
    for (const frame of frames) {
      const name = `frame_${String(frame).padStart(5, "0")}.tif`;
      copyFileSync(framePath(comp, frame), join(temp, "frames", comp, name));
    }
  }
  const args = ["scripts/pixel-report.ts", "--suite", "fxextra-approx", "--dump"];
  if (process.argv.includes("--no-build")) args.push("--no-build");
  let output = "";
  try {
    output = execFileSync(process.execPath, args, { env: { ...process.env, AEP_REFS: temp }, encoding: "utf8" });
  } catch (error) {
    output = (error as { stdout?: string }).stdout ?? String(error);
  }
  console.log(output.split("\n").filter((l) => !l.startsWith("  known:")).join("\n").trim());
  const premul = (d: Uint8Array, i: number, c: number) => (c === 3 ? d[i + 3] : (d[i + c] * d[i + 3]) / 255);
  // Every approximation comp is drawn over the fixture background (aepfix.BG in 8 bits).
  const BG = [31, 41, 77];
  const drawn = (d: Uint8Array, i: number) => [0, 1, 2].some((c) => Math.abs(premul(d, i, c) - BG[c]) > 3);
  for (const { comp, frames } of approx.comps) {
    for (const frame of frames) {
      const ref = readTiff(new Uint8Array(readFileSync(framePath(comp, frame))));
      const dump = readdirSync(join(temp, "ours")).find((f) => f.startsWith(`${comp}_f${frame}_`));
      if (!dump) continue;
      const ours = new Uint8Array(readFileSync(join(temp, "ours", dump)));
      let covered = 0;
      let sum = 0;
      let refDrawn = 0;
      let ourDrawn = 0;
      for (let p = 0; p < ref.width * ref.height; p++) {
        const i = p * 4;
        const inRef = drawn(ref.data, i);
        const inOurs = drawn(ours, i);
        refDrawn += Number(inRef);
        ourDrawn += Number(inOurs);
        if (!inRef && !inOurs) continue;
        covered++;
        let d = 0;
        for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(premul(ours, i, c) - premul(ref.data, i, c)));
        sum += d;
      }
      console.log(
        `${comp}@${frame}: drawn px ref ${refDrawn} ours ${ourDrawn}; mean error over either ${(covered ? sum / covered : 0).toFixed(1)}/255 - ${approx.reasons[comp]}`,
      );
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
