// Runs an ExtendScript file in After Effects (AfterFX.exe -r) under Adobe's
// documented render-only mode, with the same scoped ae_render_only_node.txt
// flag as scripts/aerender.ts.
//
//   node scripts/afterfx.ts <script.jsx> [timeoutSeconds]
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const AFTERFX = process.env.AFTERFX ?? "C:\\Program Files\\Adobe\\Adobe After Effects 2025\\Support Files\\AfterFX.exe";
const FLAG = join(process.env.USERPROFILE ?? homedir(), "Documents", "ae_render_only_node.txt");

export async function runScript(script: string, timeoutMs = 600_000): Promise<{ code: number | null; timedOut: boolean }> {
  const created = !existsSync(FLAG);
  if (created) writeFileSync(FLAG, "");
  try {
    return await new Promise((done, reject) => {
      const child = spawn(AFTERFX, ["-r", resolve(script)], { windowsHide: true });
      const timer = setTimeout(() => {
        child.kill();
        spawn("taskkill", ["/IM", "AfterFX.exe", "/F"], { windowsHide: true });
        done({ code: null, timedOut: true });
      }, timeoutMs);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code, timedOut: false });
      });
    });
  } finally {
    if (created) rmSync(FLAG, { force: true });
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  const result = await runScript(process.argv[2], Number(process.argv[3] ?? 600) * 1000);
  console.log(`AfterFX exited ${result.timedOut ? "after timeout" : `with code ${result.code}`}; flag left behind: ${existsSync(FLAG)}`);
}
