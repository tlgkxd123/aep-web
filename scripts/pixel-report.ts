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
import { CHANNEL_TOLERANCE, compareFrames, diffSheet, INTERIOR_TOLERANCE, KNOWN_MEAN_LIMIT, MEAN_TOLERANCE, worthASheet } from "./lib/pixel-criterion.ts";
import { readTiff } from "./lib/tiff.ts";

const args = process.argv.slice(2);
const onlyArg = args.indexOf("--only");
const only = onlyArg >= 0 ? new Set(args[onlyArg + 1].split(",")) : undefined;
const suiteArg = args.indexOf("--suite");
const root = ROOT;
const suites = loadSuites(suiteArg >= 0 ? args[suiteArg + 1] : undefined);
const DEFAULT_FPS = 24;
/**
 * Frames whose remaining difference is understood and accepted for now. They
 * must still keep a mean error of at most 1/255, so a regression shows up.
 */
const KNOWN_APPROXIMATIONS: Record<string, string> = {
  "mask_feather@0": "AE's feather falls off ~0.01 faster inside the edge than a Gaussian; outside it matches exactly",
};
for (const suite of suites) Object.assign(KNOWN_APPROXIMATIONS, suite.known);

if (!args.includes("--no-build")) execSync("npx vite build -c vite.harness.config.ts --logLevel error", { stdio: "inherit" });

const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
// WebCodecs (footage video) is only exposed to secure contexts, so the page gets an https origin.
const ORIGIN = "https://aep-harness.test/";
await page.route(`${ORIGIN}**`, (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }));
await page.goto(ORIGIN);
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

const jobs = suites.flatMap((suite) =>
  suite.comps.filter((c) => !only || only.has(c.comp)).map((c) => ({ ...c, project: suite.project, media: suite.media ?? [] })),
);
let loaded = "";
for (const { comp, frames, project, media, fps = DEFAULT_FPS } of jobs) {
  if (project !== loaded) {
    const projectBytes = readFileSync(join(root, "fixtures", project)).toString("base64");
    await page.evaluate((b64) => (globalThis as any).aepHarness.load(b64), projectBytes);
    for (const path of media) {
      const fileBytes = readFileSync(join(root, path)).toString("base64");
      await page.evaluate(([p, b64]) => (globalThis as any).aepHarness.addFile(p, b64), [path, fileBytes] as const);
    }
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
    const { badShare, interiorShare, maxDiff, meanDiff, diff } = compareFrames(ref.data, ours, width, height);
    rows.push({ name, badShare, interiorShare, maxDiff, meanDiff, warnings: result.warnings, missingRef: false });
    if (worthASheet({ badShare, interiorShare, meanDiff })) {
      writeFileSync(join(diffDir, `${comp}_f${frame}.png`), encodePng(width * 3, height, diffSheet(ref.data, ours, diff, width, height)));
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
