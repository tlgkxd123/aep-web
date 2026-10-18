// Lists After Effects' own effects (Effects & Presets, by category) without a registered renderer, and whether a
// project After Effects saved holds a definition fixtures can clone (refs/fixtures/donors/ae2025-effects.json,
// refs/fixtures/effect-donors.json).
//
//   node scripts/effect-coverage.ts [--json]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { catalogCategories } from "../src/edit/effectCatalog.ts";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const registered = new Set<string>();
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
for (const file of sources(join(root, "src"))) {
  // registerEffect and its wrappers (registerStock, registerColor...).
  for (const m of readFileSync(file, "utf8").matchAll(/register\w*\(\s*["']([^"']+)["']/g)) registered.add(m[1]);
}
// Effects registered over lists of match names (the expression controls).
for (const m of readFileSync(join(root, "src/render/effects/controls.ts"), "utf8").matchAll(/["'](ADBE [^"']+)["']/g)) registered.add(m[1]);
const donors = JSON.parse(readFileSync(join(root, "refs/fixtures/donors/ae2025-effects.json"), "utf8")) as { effects: Record<string, unknown> | string[] };
const donorNames = new Set(Array.isArray(donors.effects) ? donors.effects : Object.keys(donors.effects));
for (const name of Object.keys(JSON.parse(readFileSync(join(root, "refs/fixtures/effect-donors.json"), "utf8")))) donorNames.add(name);

const missing: { matchName: string; name: string; category: string; donor: boolean }[] = [];
let total = 0;
for (const category of catalogCategories()) {
  for (const effect of category.effects) {
    if (!/^(ADBE|CC|CS|APC|VISINF|Mettle|SYNTHAP)/.test(effect.matchName)) continue;
    total++;
    if (!registered.has(effect.matchName)) missing.push({ ...effect, donor: donorNames.has(effect.matchName) });
  }
}
if (process.argv.includes("--json")) console.log(JSON.stringify(missing, null, 1));
else {
  for (const m of missing) console.log(`${m.donor ? "donor" : "     "}  ${m.category.padEnd(22)} ${m.name.padEnd(30)} ${m.matchName}`);
  console.log(`${total - missing.length} of ${total} built-in effects render; ${missing.length} do not (${missing.filter((m) => m.donor).length} with a donor definition)`);
}
