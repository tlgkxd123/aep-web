// No-regression check for feat/layer-ops against master. A frame's result is
// a function of the harness bundle (src/render/harness.ts and everything it
// imports), the pixel tooling and the frame's refs. This script proves all of
// those are byte-identical to master except the layerops suite's own refs,
// then runs the full pixel report: every failing frame then fails identically
// on master, and every layerops frame must pass.
// Usage: node scripts/check-layerops-regression.ts [base-ref]
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const BASE = process.argv[2] ?? "master";
const ROOT = resolve(import.meta.dirname, "..");
const rel = (path: string) => relative(ROOT, path).replaceAll("\\", "/");
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
const fail = (message: string): never => {
  console.error(`REGRESSION CHECK FAILED: ${message}`);
  process.exit(1);
};

const IMPORT = /(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;
function closure(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [resolve(ROOT, entry)];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const spec = (match[1] ?? match[2] ?? match[3]).replace(/\?.*$/, "");
      if (!spec.startsWith(".")) continue;
      const base = resolve(dirname(file), spec);
      const target = [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")].find((path) => existsSync(path) && statSync(path).isFile());
      if (!target) fail(`unresolved import ${spec} in ${rel(file)}`);
      queue.push(target!);
    }
  }
  return [...seen].map(rel).sort();
}

const harness = closure("src/render/harness.ts");
const tooling = closure("scripts/pixel-report.ts");
const inputs = [...new Set([...harness, ...tooling, "vite.harness.config.ts", "package.json", "package-lock.json"])];
const changedInputs = git("diff", "--name-only", BASE, "--", ...inputs).split("\n").filter(Boolean);
if (changedInputs.length) fail(`harness/tooling inputs differ from ${BASE}: ${changedInputs.join(", ")}`);
const untracked = git("ls-files", "--others", "--exclude-standard", "--", ...inputs).split("\n").filter(Boolean);
if (untracked.length) fail(`untracked harness inputs: ${untracked.join(", ")}`);

const changedRefs = [
  ...git("diff", "--name-only", BASE, "--", "refs").split("\n"),
  ...git("ls-files", "--others", "--exclude-standard", "--", "refs").split("\n"),
].filter(Boolean);
const foreignRefs = changedRefs.filter((path) => !/^refs\/(fixtures\/layerops\.|frames\/layerops_)/.test(path));
if (foreignRefs.length) fail(`refs outside the layerops suite differ from ${BASE}: ${foreignRefs.slice(0, 10).join(", ")}`);

const run = spawnSync(process.execPath, ["scripts/pixel-report.ts"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });
const output = `${run.stdout}\n${run.stderr}`;
if (run.status !== 0) fail(`pixel-report exited ${run.status}\n${output.slice(-2000)}`);
const frames = [...output.matchAll(/^(ok|known|[A-Z][A-Z ]*?)\s+(\S+@\d+)\s+interior/gm)].map(([, status, frame]) => ({ status, frame }));
if (frames.length === 0) fail("no frame lines parsed from pixel-report output");
const summary = /frames: (\d+), passing: (\d+)/.exec(output);
if (!summary || Number(summary[1]) !== frames.length) fail(`parsed ${frames.length} frame lines but the report summary says ${summary?.[1]}`);
const failing = frames.filter((frame) => frame.status !== "ok" && frame.status !== "known");
const layerops = frames.filter((frame) => frame.frame.startsWith("layerops_"));
const layeropsFailing = failing.filter((frame) => frame.frame.startsWith("layerops_"));
if (layerops.length === 0) fail("the layerops suite produced no frames");
if (layeropsFailing.length) fail(`layerops frames fail: ${layeropsFailing.map((frame) => frame.frame).join(", ")}`);

console.log(`harness inputs identical to ${BASE}: ${harness.length} renderer files, ${tooling.length} tooling files`);
console.log(`refs changed vs ${BASE}: ${changedRefs.length}, all in the layerops suite`);
console.log(`frames ${frames.length}, passing ${frames.length - failing.length}, layerops ${layerops.length}/${layerops.length} passing`);
for (const frame of failing) console.log(`  unchanged from ${BASE} (inputs identical): ${frame.status} ${frame.frame}`);
console.log(`NO-REGRESSION-VS-${BASE.toUpperCase()} OK`);
