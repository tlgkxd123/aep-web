// Regenerates src/aep/data/match-names.json from py-aep's MIT-licensed
// MATCH_NAME_TO_AUTO_NAME table (https://github.com/forticheprod/py-aep), and
// src/aep/data/effect-categories.json, the Effects & Presets category of each
// first-party effect, from the table's "First-Party Effect > <category>" sections.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PY_AEP } from "./lib/paths.ts";

const source = resolve(process.argv[2] ?? join(PY_AEP, "src/py_aep/data/match_names.py"));
const text = readFileSync(source, "utf8");
const start = text.indexOf("MATCH_NAME_TO_AUTO_NAME = {");
if (start < 0) throw new Error(`MATCH_NAME_TO_AUTO_NAME not found in ${source}`);
const body = text.slice(start, text.indexOf("\n}", start));

const table: Record<string, string> = {};
const categories: Record<string, string> = {};
const entry = /^\s*"((?:[^"\\]|\\.)+)":\s*"((?:[^"\\]|\\.)*)",?/;
let category: string | undefined;
for (const line of body.split(/\r?\n/)) {
  const comment = /^\s*#\s*(.*)$/.exec(line);
  if (comment) {
    category = /^First-Party Effect > (.+)$/.exec(comment[1].trim())?.[1];
    continue;
  }
  const match = entry.exec(line);
  if (!match) continue;
  const matchName = JSON.parse(`"${match[1]}"`);
  table[matchName] = JSON.parse(`"${match[2]}"`);
  if (category) categories[matchName] = category;
}

writeFileSync(resolve("src/aep/data/match-names.json"), JSON.stringify(table, null, 1) + "\n");
writeFileSync(resolve("src/aep/data/effect-categories.json"), JSON.stringify(categories, null, 1) + "\n");
console.log(`wrote ${Object.keys(table).length} match names, ${Object.keys(categories).length} effect categories`);
