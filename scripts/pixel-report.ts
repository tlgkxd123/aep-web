// Renders every fixture frame of every suite (refs/fixtures/*manifest.json)
// with the WebGL renderer in headless Edge and compares it with After Effects'
// reference TIFF (refs/frames). Writes side-by-side diff images for
// mismatching frames to refs/diff.
//
//   node scripts/pixel-report.ts [--only name,name] [--suite manifestBaseName] [--require] [--no-build] [--dump]
//
// A suite manifest may list accepted approximations as
//   "known": { "comp@frame": "reason" }
// which must still keep a mean error of at most 1/255.
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { encodePng } from "./lib/png.ts";
import { loadSuites, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2);
const onlyArg = args.indexOf("--only");
const only = onlyArg >= 0 ? new Set(args[onlyArg + 1].split(",")) : undefined;
const suiteArg = args.indexOf("--suite");
const root = ROOT;
const suites = loadSuites(suiteArg >= 0 ? args[suiteArg + 1] : undefined);
const DEFAULT_FPS = 24;
/** A pixel counts as different when any premultiplied channel is off by more than this (of 255). */
const CHANNEL_TOLERANCE = 3;
/**
 * AE's rasterizer spreads edge coverage slightly differently from the
 * browser's, so differences on hard edges are measured separately: a pixel is
 * an edge pixel when the reference changes by more than EDGE_CONTRAST within
 * its 3x3 neighbourhood. Gradients and feathers stay below that contrast.
 */
const EDGE_CONTRAST = 48;
/** A frame passes when at most this share of its non-edge pixels differ... */
const INTERIOR_TOLERANCE = 0.001;
/** ...and its mean error over all pixels stays within this (of 255). */
const MEAN_TOLERANCE = 1;
/**
 * Frames whose remaining difference is understood and accepted for now. They
 * must still keep a mean error of at most 1/255, so a regression shows up.
 */
const KNOWN_APPROXIMATIONS: Record<string, string> = {
  "mask_feather@0": "AE's feather falls off ~0.01 faster inside the edge than a Gaussian; outside it matches exactly",
};
for (const suite of suites) Object.assign(KNOWN_APPROXIMATIONS, suite.known);
const KNOWN_MEAN_LIMIT = 1;

if (!args.includes("--no-build")) execSync("npx vite build -c vite.harness.config.ts --logLevel error", { stdio: "inherit" });

const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
await page.setContent("<!doctype html><html><body></body></html>");
await page.addScriptTag({ path: resolve("dist-harness/harness.js") });
const diffDir = join(root, "diff");
rmSync(diffDir, { recursive: true, force: true });
mkdirSync(diffDir, { recursive: true });

type Row = {
  name: string;
  badShare: number;
  interiorShare: number;
  maxDiff: number;
  meanDiff: number;
  warnings: string[];
  missingRef: boolean;
};
const rows: Row[] = [];
const premul = (d: Uint8Array, i: number, c: number) => (c === 3 ? d[i + 3] : (d[i + c] * d[i + 3]) / 255);

const jobs = suites.flatMap((suite) =>
  suite.comps.filter((c) => !only || only.has(c.comp)).map((c) => ({ ...c, project: suite.project })),
);
let loaded = "";
for (const { comp, frames, project, fps = DEFAULT_FPS } of jobs) {
  if (project !== loaded) {
    const projectBytes = readFileSync(join(root, "fixtures", project)).toString("base64");
    await page.evaluate((b64) => (globalThis as any).aepHarness.load(b64), projectBytes);
    loaded = project;
  }
  for (const frame of frames) {
    const name = `${comp}@${frame}`;
    const refPath = join(root, "frames", comp, `frame_${String(frame).padStart(5, "0")}.tif`);
    if (!existsSync(refPath)) {
      rows.push({ name, badShare: 1, interiorShare: 1, maxDiff: 255, meanDiff: 255, warnings: [], missingRef: true });
      continue;
    }
    const ref = readTiff(new Uint8Array(readFileSync(refPath)));
    const result = await page.evaluate(
      ([c, t]) => (globalThis as any).aepHarness.render(c, t),
      [comp, frame / fps] as const,
    );
    const ours = new Uint8Array(Buffer.from(result.pixels, "base64"));
    if (args.includes("--dump")) {
      mkdirSync(join(root, "ours"), { recursive: true });
      writeFileSync(join(root, "ours", `${comp}_f${frame}_${result.width}x${result.height}.rgba`), ours);
    }
    if (result.width !== ref.width || result.height !== ref.height) {
      rows.push({
        name,
        badShare: 1,
        interiorShare: 1,
        maxDiff: 255,
        meanDiff: 255,
        warnings: [`size ${result.width}x${result.height} vs ${ref.width}x${ref.height}`],
        missingRef: false,
      });
      continue;
    }
    const { width, height } = ref;
    const isEdge = (p: number) => {
      const x = p % width;
      const y = Math.floor(p / width);
      for (let c = 0; c < 4; c++) {
        let lo = 255;
        let hi = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.min(width - 1, Math.max(0, x + dx));
            const ny = Math.min(height - 1, Math.max(0, y + dy));
            const v = premul(ref.data, (ny * width + nx) * 4, c);
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
        }
        if (hi - lo > EDGE_CONTRAST) return true;
      }
      return false;
    };
    let bad = 0;
    let interiorBad = 0;
    let maxDiff = 0;
    let sum = 0;
    const diff = new Uint8Array(width * height * 4);
    for (let p = 0; p < width * height; p++) {
      let worst = 0;
      for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(premul(ours, p * 4, c) - premul(ref.data, p * 4, c)));
      if (worst > CHANNEL_TOLERANCE) {
        bad++;
        if (!isEdge(p)) interiorBad++;
      }
      maxDiff = Math.max(maxDiff, worst);
      sum += worst;
      const v = Math.min(255, Math.round(worst * 8));
      diff.set([v, v, v, 255], p * 4);
    }
    const badShare = bad / (width * height);
    const interiorShare = interiorBad / (width * height);
    const meanDiff = sum / (width * height);
    rows.push({ name, badShare, interiorShare, maxDiff, meanDiff, warnings: result.warnings, missingRef: false });
    if (interiorShare > INTERIOR_TOLERANCE || meanDiff > MEAN_TOLERANCE || badShare > 0.01) {
      const sheet = new Uint8Array(width * 3 * height * 4);
      for (let y = 0; y < height; y++) {
        sheet.set(ref.data.subarray(y * width * 4, (y + 1) * width * 4), (y * width * 3) * 4);
        sheet.set(ours.subarray(y * width * 4, (y + 1) * width * 4), (y * width * 3 + width) * 4);
        sheet.set(diff.subarray(y * width * 4, (y + 1) * width * 4), (y * width * 3 + 2 * width) * 4);
      }
      writeFileSync(join(diffDir, `${comp}_f${frame}.png`), encodePng(width * 3, height, sheet));
    }
  }
}
await browser.close();

rows.sort((a, b) => b.interiorShare - a.interiorShare || b.badShare - a.badShare);
const strict = (r: Row) => !r.missingRef && r.interiorShare <= INTERIOR_TOLERANCE && r.meanDiff <= MEAN_TOLERANCE;
const known = (r: Row) => !r.missingRef && r.name in KNOWN_APPROXIMATIONS && r.meanDiff <= KNOWN_MEAN_LIMIT;
const passing = rows.filter((r) => strict(r) || known(r));
console.log(
  `frames: ${rows.length}, passing: ${passing.length} (${rows.filter(strict).length} with <= ${INTERIOR_TOLERANCE * 100}% of non-edge pixels off by more than ${CHANNEL_TOLERANCE}/255 and mean error <= ${MEAN_TOLERANCE}/255, ${rows.filter((r) => !strict(r) && known(r)).length} known approximations)`,
);
for (const [name, reason] of Object.entries(KNOWN_APPROXIMATIONS)) console.log(`  known: ${name}: ${reason}`);
for (const r of rows) {
  const status = r.missingRef ? "NO REF" : strict(r) ? "ok  " : known(r) ? "known" : "DIFF";
  const note = r.warnings.length ? `  [${r.warnings.join("; ")}]` : "";
  console.log(
    `${status} ${r.name.padEnd(36)} interior ${(r.interiorShare * 100).toFixed(2).padStart(5)}%  all ${(r.badShare * 100).toFixed(2).padStart(5)}%  max ${String(Math.round(r.maxDiff)).padStart(3)}  mean ${r.meanDiff.toFixed(2)}${note}`,
  );
}
if (args.includes("--require")) {
  if (rows.length && passing.length === rows.length) console.log("PIXELS-PASSED");
  else {
    console.log("pixel requirement not met");
    process.exit(1);
  }
}
