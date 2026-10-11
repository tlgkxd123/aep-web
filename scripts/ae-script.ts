// Runs ExtendScript in After Effects 2025 without its UI (AfterFX.com -noui -s, as aerender
// starts its engine), one After Effects process at a time machine-wide (scripts/lib/ae-lock.ts).
// The script is wrapped so that dialogs are suppressed and After Effects quits when it ends; it
// reports through the files it writes. Only this run's process tree is ever killed.
//
//   node scripts/ae-script.ts <script.jsx> [--timeout seconds]
import { spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withAfterEffects } from "./lib/ae-lock.ts";

export const AFTERFX = process.env.AFTERFX ?? "C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files\\AfterFX.com";

export interface ScriptResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export interface ScriptOptions {
  timeoutMs?: number;
  /** A file the script keeps writing to: After Effects is stopped when it is not written for `idleMs`. */
  progressFile?: string;
  idleMs?: number;
}

function killTree(pid: number): Promise<void> {
  return new Promise((done) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    killer.on("close", () => done());
    killer.on("error", () => done());
  });
}

/** Runs `source` (ExtendScript) in a new After Effects process, which quits when the script ends. */
export function runScript(source: string, { timeoutMs = 600_000, progressFile, idleMs = 180_000 }: ScriptOptions = {}): Promise<ScriptResult> {
  const wrapped = join(tmpdir(), `aep-web-script-${process.pid}.jsx`);
  writeFileSync(
    wrapped,
    `app.beginSuppressDialogs();\ntry {\n${source}\n} finally {\n  app.endSuppressDialogs(false);\n  try { app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); } catch (e) {}\n  app.quit();\n}\n`,
  );
  return withAfterEffects(
    () =>
      new Promise((done, fail) => {
        // Without -m (render-only), which leaves projects unmodifiable from scripts.
        const child = spawn(AFTERFX, ["-noui", "-s", `$.evalFile('${wrapped.replace(/\\/g, "/")}')`], { windowsHide: true });
        let output = "";
        child.stdout?.on("data", (d) => (output += d));
        child.stderr?.on("data", (d) => (output += d));
        const started = Date.now();
        const stop = async () => {
          clearInterval(watch);
          if (child.pid) await killTree(child.pid);
          done({ code: null, output, timedOut: true });
        };
        const watch = setInterval(() => {
          const written = progressFile ? (statSync(progressFile, { throwIfNoEntry: false })?.mtimeMs ?? started) : started;
          if (Date.now() - started > timeoutMs || (progressFile && Date.now() - Math.max(started, written) > idleMs)) void stop();
        }, 2000);
        child.on("error", (e) => {
          clearInterval(watch);
          fail(e);
        });
        child.on("close", (code) => {
          clearInterval(watch);
          done({ code, output, timedOut: false });
        });
      }),
  );
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--timeout");
  const timeoutMs = at >= 0 ? Number(args.splice(at, 2)[1]) * 1000 : 600_000;
  const result = await runScript(readFileSync(resolve(args[0]), "utf8"), { timeoutMs });
  console.log(result.output.trim());
  console.log(result.timedOut ? "After Effects timed out" : `After Effects exited with ${result.code}`);
  process.exit(result.timedOut ? 2 : 0);
}
