// Copies the keying comps' diff sheets out of refs/diff (which every pixel-report run empties) into
// %TEMP%/keying-diff as they are written, for `seconds` (default 300).
//
//   node scripts/check-keying-grab.ts [seconds]
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";

const from = join(ROOT, "diff");
const to = join(tmpdir(), "keying-diff");
mkdirSync(to, { recursive: true });
const until = Date.now() + Number(process.argv[2] ?? 300) * 1000;
const timer = setInterval(() => {
  if (existsSync(from))
    for (const name of readdirSync(from)) {
      if (!name.startsWith("keying_")) continue;
      try {
        copyFileSync(join(from, name), join(to, name));
      } catch {
        // written or removed meanwhile; the next poll retries
      }
    }
  if (Date.now() > until) clearInterval(timer);
}, 100);
console.log(`copying keying sheets to ${to}`);
