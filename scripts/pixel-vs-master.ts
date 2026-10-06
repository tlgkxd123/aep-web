// Pixel regression against master: runs scripts/pixel-report.ts over every
// suite here and in a copy of master (extracted with `git archive` into the
// temp folder, sharing this checkout's node_modules), and fails when a frame
// that passes on master does not pass here.
//
//   node scripts/pixel-vs-master.ts [master-ref]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ref = process.argv[2] ?? "master";
const here = resolve(".");
const copy = join(tmpdir(), "aep-pixels-master");

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 256 << 20 });
  if (result.error) throw result.error;
  return `${result.stdout}${result.stderr}`;
}

/** Deletes the copy; the node_modules junction goes first, by itself, so nothing follows it into this checkout. */
function removeCopy(): void {
  if (existsSync(join(copy, "node_modules"))) run("cmd", ["/c", "rmdir", join(copy, "node_modules")], tmpdir());
  if (existsSync(join(copy, "node_modules"))) throw new Error(`could not unlink ${join(copy, "node_modules")}`);
  rmSync(copy, { recursive: true, force: true });
}

removeCopy();
mkdirSync(copy, { recursive: true });
run("git", ["archive", "--format=tar", "-o", join(copy, "master.tar"), ref], here);
run("tar", ["-xf", "master.tar"], copy);
rmSync(join(copy, "master.tar"));
run("cmd", ["/c", "mklink", "/J", join(copy, "node_modules"), join(here, "node_modules")], copy);
if (!existsSync(join(copy, "scripts", "pixel-report.ts"))) throw new Error(`${ref} has no scripts/pixel-report.ts`);

/** Frame results by `comp@frame`: whether each passes (plain or as a listed known approximation). */
function report(cwd: string): Map<string, boolean> {
  const out = run("node", ["scripts/pixel-report.ts"], cwd);
  const frames = new Map<string, boolean>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^(ok|known|DIFF|NO REF|FAIL|ERROR|MISS\w*)\s+(\S+@\d+)\s/.exec(line);
    if (m) frames.set(m[2], m[1] === "ok" || m[1] === "known");
  }
  if (!frames.size) throw new Error(`no frame results from pixel-report in ${cwd}:\n${out.slice(-2000)}`);
  return frames;
}

const master = report(copy);
const branch = report(here);
const regressed = [...master].filter(([frame, ok]) => ok && !branch.get(frame)).map(([frame]) => frame);
const newPassing = [...branch].filter(([frame, ok]) => ok && !master.has(frame)).length;
const count = (m: Map<string, boolean>) => [...m.values()].filter(Boolean).length;
console.log(`${ref}: ${count(master)}/${master.size} frames pass; this branch: ${count(branch)}/${branch.size} (${newPassing} passing frames not on ${ref})`);
for (const frame of regressed) console.log(`REGRESSED ${frame}`);
removeCopy();
if (regressed.length) process.exitCode = 1;
else console.log("NO-PIXEL-REGRESSION-VS-MASTER");
