// The hand-written fitting that the PyTorch world model (ml/pmatch) replaced is gone from the app
// (gates/pmatch-torch.md T8):
//   node scripts/pmatch-torch-audit.ts
// As its positive control it first finds every name in the committed fit.ts and sprites.ts (git HEAD).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const NAMES = ["fitClock", "fitDynamics", "buildPopulation", "stitchTracks", "depthExponents", "learnSprites"];
const pattern = new RegExp(`\\b(${NAMES.join("|")})\\b`, "g");

const committed = ["src/extra/pmatch/fit.ts", "src/extra/pmatch/sprites.ts"].map((path) => execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8" })).join("\n");
const controls = new Set(committed.match(pattern) ?? []);
const unseen = NAMES.filter((name) => !controls.has(name));
if (unseen.length) {
  console.log(`FAILED: the positive control does not find ${unseen.join(", ")} in the committed sources`);
  process.exit(1);
}

const found: string[] = [];
const walk = (dir: string) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx)$/.test(entry)) for (const m of readFileSync(path, "utf8").matchAll(pattern)) found.push(`${path}: ${m[1]}`);
  }
};
walk("src");
if (found.length) {
  console.log(`FAILED: the replaced fitting is still in the app:\n${found.join("\n")}`);
  process.exit(1);
}
console.log(`positive control: ${NAMES.length} names found in the committed sources; none remain under src/`);
console.log("PMATCH-TS-FIT-REMOVED");
