// Machine-wide lock so only one After Effects render-only run happens at a
// time (several worktrees may render references concurrently, and they share
// the ae_render_only_node.txt flag in Documents).
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const LOCK = join(tmpdir(), "aep-web-after-effects.lock");
const FLAG = join(process.env.USERPROFILE ?? homedir(), "Documents", "ae_render_only_node.txt");
/** A lock older than this is assumed to belong to a crashed run. */
const STALE_MS = 20 * 60_000;

async function acquire(waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, "owner"), `${process.pid} ${new Date().toISOString()}`);
      return;
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) rmSync(LOCK, { recursive: true, force: true });
      } catch {
        // The lock was released between the attempts.
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${LOCK}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * Runs `task` holding the lock, with Adobe's render-only flag present for its
 * duration (it is removed afterwards so the full After Effects app is unaffected).
 */
export async function withAfterEffects<T>(task: () => Promise<T>, waitMs = 60 * 60_000): Promise<T> {
  await acquire(waitMs);
  const created = !existsSync(FLAG);
  if (created) writeFileSync(FLAG, "");
  try {
    return await task();
  } finally {
    if (created) rmSync(FLAG, { force: true });
    rmSync(LOCK, { recursive: true, force: true });
  }
}

export const RENDER_FLAG = FLAG;
