// Machine-wide lock so only one After Effects render-only run happens at a
// time (several worktrees may render references concurrently, and they share
// the ae_render_only_node.txt flag in Documents).
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const LOCK = join(tmpdir(), "aep-web-after-effects.lock");
const OWNER = join(LOCK, "owner");
const FLAG = join(process.env.USERPROFILE ?? homedir(), "Documents", "ae_render_only_node.txt");
/** A lock older than this is assumed to belong to a crashed run (single renders time out well before). */
const STALE_MS = 20 * 60_000;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Takes the lock; returns the token that proves ownership. */
async function acquire(waitMs: number): Promise<string> {
  const deadline = Date.now() + waitMs;
  const token = `${process.pid} ${Date.now()} ${Math.random().toString(36).slice(2)}`;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(OWNER, token);
      return token;
    } catch {
      try {
        const ownerPid = Number(readFileSync(OWNER, "utf8").split(" ")[0]);
        const stale = Date.now() - statSync(LOCK).mtimeMs > STALE_MS || (ownerPid > 0 && !processAlive(ownerPid));
        if (stale) rmSync(LOCK, { recursive: true, force: true });
      } catch {
        // The lock was released between the attempts, or its owner file is not written yet.
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${LOCK}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function release(token: string): void {
  try {
    if (readFileSync(OWNER, "utf8") !== token) return;
  } catch {
    return;
  }
  rmSync(LOCK, { recursive: true, force: true });
}

/**
 * Runs `task` holding the lock, with Adobe's render-only flag present for its
 * duration (it is removed afterwards so the full After Effects app is unaffected).
 */
export async function withAfterEffects<T>(task: () => Promise<T>, waitMs = 60 * 60_000): Promise<T> {
  const token = await acquire(waitMs);
  const created = !existsSync(FLAG);
  if (created) writeFileSync(FLAG, "");
  try {
    return await task();
  } finally {
    if (created) rmSync(FLAG, { force: true });
    release(token);
  }
}

export const RENDER_FLAG = FLAG;
