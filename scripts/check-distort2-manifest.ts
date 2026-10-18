// Drops comps from refs/fixtures/distort2.manifest.json without rebuilding the project (whose bytes a rebuild
// changes, and with them aerender's record of what it rendered): the manifest build_distort2.py writes when the
// same comps are in its PENDING set.
//
//   node scripts/check-distort2-manifest.ts <comp> [comp...]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib/suites.ts";

const path = join(ROOT, "fixtures", "distort2.manifest.json");
const drop = new Set(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(path, "utf8")) as { project: string; comps: { comp: string }[] };
const before = manifest.comps.length;
manifest.comps = manifest.comps.filter((c) => !drop.has(c.comp));
writeFileSync(path, JSON.stringify(manifest, null, 1) + "\n");
console.log(`${before - manifest.comps.length} comps dropped, ${manifest.comps.length} left`);
