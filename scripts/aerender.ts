// Runs After Effects' aerender in Adobe's documented non-royalty render-only mode.
// The ae_render_only_node.txt flag in Documents is created only for the duration
// of a run and removed afterwards: while it exists, launching the full After
// Effects app would also start it as a render engine.
//
//   node scripts/aerender.ts <aerender arguments...>
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AERENDER = process.env.AERENDER ?? "C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files\\aerender.exe";
const FLAG = join(process.env.USERPROFILE ?? homedir(), "Documents", "ae_render_only_node.txt");

export interface AerenderResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export async function aerender(args: string[], timeoutMs = 300_000): Promise<AerenderResult> {
  const created = !existsSync(FLAG);
  if (created) writeFileSync(FLAG, "");
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(AERENDER, args, { windowsHide: true });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      const timer = setTimeout(() => {
        child.kill();
        spawn("taskkill", ["/IM", "AfterFX.exe", "/F"], { windowsHide: true });
        resolve({ code: null, output, timedOut: true });
      }, timeoutMs);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output, timedOut: false });
      });
    });
  } finally {
    if (created) rmSync(FLAG, { force: true });
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const result = await aerender(process.argv.slice(2));
  console.log(result.output.trim());
  if (result.timedOut) console.log("aerender timed out");
  console.log(`flag left behind: ${existsSync(FLAG)}`);
  process.exit(result.code ?? 2);
}
