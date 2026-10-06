// Runs After Effects' aerender in Adobe's documented non-royalty render-only
// mode, one run at a time machine-wide (see scripts/lib/ae-lock.ts).
//
//   node scripts/aerender.ts <aerender arguments...>
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { RENDER_FLAG, withAfterEffects } from "./lib/ae-lock.ts";

export const AERENDER = process.env.AERENDER ?? "C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files\\aerender.exe";

export interface AerenderResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/** Kills a process and its children (aerender runs the engine as a child AfterFX.com), waiting until done. */
function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    killer.on("close", () => resolve());
    killer.on("error", () => resolve());
  });
}

export function aerender(args: string[], timeoutMs = 300_000): Promise<AerenderResult> {
  return withAfterEffects(
    () =>
      new Promise((resolve, reject) => {
        const child = spawn(AERENDER, args, { windowsHide: true });
        let output = "";
        child.stdout.on("data", (d) => (output += d));
        child.stderr.on("data", (d) => (output += d));
        // Only this run's process tree is killed: the user's own After Effects must never be touched.
        const timer = setTimeout(async () => {
          if (child.pid) await killTree(child.pid);
          resolve({ code: null, output, timedOut: true });
        }, timeoutMs);
        child.on("error", reject);
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, output, timedOut: false });
        });
      }),
  );
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const result = await aerender(process.argv.slice(2));
  console.log(result.output.trim());
  if (result.timedOut) console.log("aerender timed out");
  console.log(`flag left behind: ${existsSync(RENDER_FLAG)}`);
  process.exit(result.code ?? 2);
}
