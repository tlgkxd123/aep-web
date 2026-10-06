// Cross-checks projects written by the project operations against py-aep
// (scripts/fixtures/projectops_summary.py): every item's id, name, folder,
// kind, size, timing, footage file and alpha, and every layer's source must
// read the same in both parsers. Also checks that the file writes back byte
// for byte.
//
//   node scripts/projectops-check.ts [file.aep ...]   (default: refs/fixtures/projectops.aep)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { Item } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { readRifx } from "../src/aep/riff.ts";
import { writeRifx } from "../src/aep/write.ts";

const PY_AEP = process.env.PY_AEP ?? "C:/Users/schxm/projects/_ref/py-aep";
const files = process.argv.slice(2).length ? process.argv.slice(2) : ["refs/fixtures/projectops.aep"];

const py = spawnSync(
  "uv",
  ["run", "--no-project", "--with", "attrs", "--with", "pyyaml", "--with", "fonttools", "python", "scripts/fixtures/projectops_summary.py", ...files.map((f) => resolve(f))],
  { encoding: "utf8", env: { ...process.env, PYTHONPATH: `${PY_AEP}/src` }, maxBuffer: 64 << 20 },
);
if (py.status !== 0) throw new Error(`py-aep failed: ${py.stderr}`);
const theirs = JSON.parse(py.stdout) as Record<string, Record<string, unknown>[]>;

const KINDS: Record<Item["kind"], string> = { comp: "CompItem", footage: "FootageItem", folder: "FolderItem" };
const close = (a: unknown, b: unknown) =>
  typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6 : JSON.stringify(a) === JSON.stringify(b);

function ours(item: Item): Record<string, unknown> {
  const out: Record<string, unknown> = { id: item.id, name: item.name, parent: item.parentFolderId, kind: KINDS[item.kind] };
  if (item.kind === "folder") return out;
  Object.assign(out, { width: item.width, height: item.height, duration: item.duration, pixelAspect: item.pixelAspect });
  if (item.kind === "comp") {
    Object.assign(out, {
      frameRate: item.frameRate,
      bgColor: item.bgColor,
      displayStartTime: item.displayStartTime,
      layers: item.layers.map((l) => ({ id: l.id, name: l.name, source: l.sourceId })),
    });
  } else {
    const source = item.mainSource;
    out.source = source.sourceType;
    if (source.sourceType === "FileSource") Object.assign(out, { file: source.file, hasAlpha: source.hasAlpha, isStill: source.isStill });
  }
  return out;
}

let failures = 0;
for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file));
  const roundTrip = writeRifx(readRifx(bytes));
  const identical = roundTrip.length === bytes.length && roundTrip.every((b, i) => b === bytes[i]);
  if (!identical) failures++;
  console.log(`${basename(file)}: write-back ${identical ? "byte-identical" : "DIFFERS"}`);

  const project = parseProject(bytes);
  const expected = theirs[basename(file)] ?? [];
  const mine = new Map([...project.items.values()].map((i) => [i.id, ours(i)]));
  for (const want of expected) {
    const got = mine.get(want.id as number);
    if (!got) {
      failures++;
      console.log(`  item ${want.id} "${want.name}": py-aep has it, aep-web does not`);
      continue;
    }
    mine.delete(want.id as number);
    for (const [key, value] of Object.entries(want)) {
      if (key === "layers") {
        const a = value as { id: number; name: string; source: number }[];
        const b = got.layers as typeof a;
        if (a.length !== b.length || a.some((l, i) => l.id !== b[i].id || l.source !== b[i].source || l.name !== b[i].name)) {
          failures++;
          console.log(`  ${want.name}: layers differ\n    py-aep  ${JSON.stringify(a)}\n    aep-web ${JSON.stringify(b)}`);
        }
      } else if (!close(value, got[key])) {
        failures++;
        console.log(`  ${want.name}: ${key} py-aep ${JSON.stringify(value)} aep-web ${JSON.stringify(got[key])}`);
      }
    }
  }
  for (const extra of mine.values()) {
    failures++;
    console.log(`  item ${extra.id} "${extra.name}": aep-web has it, py-aep does not`);
  }
  console.log(`  ${expected.length} items compared`);
}
console.log(failures ? `${failures} differences` : "py-aep and aep-web agree");
process.exitCode = failures ? 1 : 0;
