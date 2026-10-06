// Regenerates src/aep/data/match-names.json from py-aep's MIT-licensed
// MATCH_NAME_TO_AUTO_NAME table (https://github.com/forticheprod/py-aep).
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PY_AEP } from "./lib/paths.ts";

const source = resolve(process.argv[2] ?? join(PY_AEP, "src/py_aep/data/match_names.py"));
const text = readFileSync(source, "utf8");
const start = text.indexOf("MATCH_NAME_TO_AUTO_NAME = {");
if (start < 0) throw new Error(`MATCH_NAME_TO_AUTO_NAME not found in ${source}`);
const body = text.slice(start, text.indexOf("\n}", start));

const table: Record<string, string> = {};
const entry = /^\s*"((?:[^"\\]|\\.)+)":\s*"((?:[^"\\]|\\.)*)",?/gm;
for (const match of body.matchAll(entry)) {
  table[JSON.parse(`"${match[1]}"`)] = JSON.parse(`"${match[2]}"`);
}

writeFileSync(resolve("src/aep/data/match-names.json"), JSON.stringify(table, null, 1) + "\n");
console.log(`wrote ${Object.keys(table).length} match names`);
