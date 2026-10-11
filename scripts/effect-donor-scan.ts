// Lists the effects defined (LIST:EfDf) by After Effects-saved projects on this machine: the
// py-aep corpus, refs/fixtures and the given folders. An effect can be authored into fixtures
// and saved from the app only when some project After Effects itself saved defines it.
//
//   node scripts/effect-donor-scan.ts [folder...] [--json out.json]
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseProject } from "../src/aep/parse.ts";
import { PY_AEP } from "./lib/paths.ts";

const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const out = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : undefined;
const roots = [join(PY_AEP, "samples"), ...args];

function* aeps(dir: string, depth = 0): Generator<string> {
  if (depth > 5) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) yield* aeps(path, depth + 1);
    else if (/\.aep$/i.test(name) && stat.size < 200e6) yield path;
  }
}

const donors = new Map<string, { name: string; files: string[] }>();
let files = 0;
for (const root of roots) {
  for (const path of aeps(root)) {
    try {
      const bytes = readFileSync(path);
      const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      files++;
      for (const [matchName, name] of project.effectTypes) {
        const entry = donors.get(matchName) ?? { name, files: [] };
        entry.files.push(path);
        donors.set(matchName, entry);
      }
    } catch {
      // Not a project this parser reads.
    }
  }
}
console.log(`${files} projects, ${donors.size} effects defined`);
for (const [matchName, { name, files: list }] of [...donors].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`${matchName.padEnd(36)} ${name.padEnd(32)} ${list.length}`);
}
if (out) writeFileSync(out, JSON.stringify(Object.fromEntries([...donors].map(([k, v]) => [k, v])), null, 1));
