// Checks that every frame passing the pixel criterion on a base revision still
// passes here: exports the base with `git archive` (the checkout of that branch
// is never touched), links this tree's node_modules into it, runs
// pixel-report.ts in both and compares.
//   node scripts/pixel-regression.ts [--base master] [--merge]
// --merge compares against the result of merging HEAD (committed work only) into
// the base, computed with `git merge-tree`, instead of this working tree.
// Prints PIXELS-NOT-REGRESSED when no frame was lost.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const baseArg = args.indexOf("--base");
const base = baseArg >= 0 ? args[baseArg + 1] : "master";
const here = resolve(".");

function run(command: string, argv: string[], cwd: string): { out: string; status: number | null } {
  const result = spawnSync(command, argv, { cwd, encoding: "utf8", maxBuffer: 1 << 28 });
  if (result.error) throw result.error;
  return { out: `${result.stdout}${result.stderr}`, status: result.status };
}

function results(log: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const line of log.split(/\r?\n/)) {
    const m = /^(ok|known|DIFF|NO REF|FAIL|ERROR)\s+(\S+@\d+)/.exec(line);
    if (m) out.set(m[2], m[1] === "ok" || m[1] === "known");
  }
  return out;
}

/** Every suite of a tree whose project file is there, one report each: a missing project stops a whole run. */
function report(dir: string): Map<string, boolean> {
  const fixtures = join(dir, "refs", "fixtures");
  const out = new Map<string, boolean>();
  let first = true;
  for (const file of readdirSync(fixtures).filter((f) => f.endsWith("manifest.json")).sort()) {
    const { project } = JSON.parse(readFileSync(join(fixtures, file), "utf8")) as { project: string };
    if (!existsSync(join(fixtures, project))) {
      console.log(`skipped ${file} in ${dir}: ${project} is missing`);
      continue;
    }
    const suite = file === "manifest.json" ? "fixtures" : file.replace(/\.manifest\.json$/, "");
    for (const [frame, pass] of results(run("node", ["scripts/pixel-report.ts", "--suite", suite, ...(first ? [] : ["--no-build"])], dir).out)) out.set(frame, pass);
    first = false;
  }
  return out;
}

/** A temp directory holding the tree of `object`, with this tree's node_modules linked in. */
function exportTree(object: string): string {
  const dir = join(tmpdir(), `aep-pixel-${object.slice(0, 12)}`);
  if (existsSync(join(dir, "scripts", "pixel-report.ts"))) return dir;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tar = `${dir}.tar`;
  run("git", ["archive", "--format=tar", "-o", tar, object], here);
  run("tar", ["-xf", tar, "-C", dir], here);
  rmSync(tar, { force: true });
  symlinkSync(join(here, "node_modules"), join(dir, "node_modules"), "junction");
  return dir;
}

const commit = run("git", ["rev-parse", base], here).out.trim();
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error(`cannot resolve ${base}: ${commit}`);
  process.exit(2);
}
let candidate = here;
let label = "here";
if (args.includes("--merge")) {
  const merge = run("git", ["merge-tree", "--write-tree", "HEAD", commit], here);
  const tree = merge.out.split(/\r?\n/)[0].trim();
  if (merge.status !== 0 || !/^[0-9a-f]{40}$/.test(tree)) {
    console.error(`HEAD does not merge cleanly into ${base}:\n${merge.out}`);
    process.exit(2);
  }
  candidate = exportTree(tree);
  label = `HEAD merged into ${base}`;
}

const before = report(exportTree(commit));
const after = report(candidate);
if (!before.size || !after.size) {
  console.error(`no report rows (base ${before.size}, candidate ${after.size})`);
  process.exit(2);
}
const passing = (m: Map<string, boolean>) => [...m.values()].filter(Boolean).length;
const lost = [...before].filter(([frame, pass]) => pass && !after.get(frame)).map(([frame]) => frame);
const gained = [...after].filter(([frame, pass]) => pass && !before.get(frame)).length;
console.log(`${base} ${commit.slice(0, 7)}: ${before.size} frames, ${passing(before)} passing`);
console.log(`${label}: ${after.size} frames, ${passing(after)} passing (${gained} newly passing, ${lost.length} lost)`);
for (const frame of lost) console.log(`LOST ${frame}`);
if (lost.length) process.exit(1);
console.log("PIXELS-NOT-REGRESSED");
