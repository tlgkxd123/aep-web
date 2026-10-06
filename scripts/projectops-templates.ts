// Regenerates src/edit/data/project-templates.json: runs
// scripts/fixtures/projectops_templates.py (py-aep) and keeps the empty project
// without its XMP packet plus each template item block (the LIST:Item and the
// view data after it) as a small RIFX file of its own.
//
//   node scripts/projectops-templates.ts
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findChild, findList, readRifx, type Chunk } from "../src/aep/riff.ts";
import { writeRifx } from "../src/aep/write.ts";

const OUT = "src/edit/data/project-templates.json";
const PY_AEP = "C:/Users/schxm/projects/_ref/py-aep/src";

const tmp = mkdtempSync(join(tmpdir(), "projectops-templates-"));
try {
  const raw = join(tmp, "raw.json");
  const run = spawnSync(
    "uv",
    ["run", "--no-project", "--with", "attrs", "--with", "pyyaml", "--with", "fonttools", "python", "scripts/fixtures/projectops_templates.py", raw],
    { stdio: "inherit", env: { ...process.env, PYTHONPATH: PY_AEP } },
  );
  if (run.status !== 0) throw new Error(`projectops_templates.py failed (${run.status})`);
  const { empty, templates } = JSON.parse(readFileSync(raw, "utf8")) as Record<string, string>;

  const emptyFile = readRifx(Buffer.from(empty, "base64"));
  const out: { empty: string; blocks: Record<string, string> } = {
    empty: Buffer.from(writeRifx({ ...emptyFile, xmp: "", trailer: new Uint8Array(0) })).toString("base64"),
    blocks: {},
  };

  const fold = findList(readRifx(Buffer.from(templates, "base64")).root, "Fold");
  const children = fold?.children ?? [];
  const isItem = (c: Chunk) => c.type === "LIST" && c.listType === "Item";
  for (let i = 0; i < children.length; i++) {
    if (!isItem(children[i])) continue;
    let end = i + 1;
    while (end < children.length && !isItem(children[end])) end++;
    const block = children.slice(i, end);
    const nameChunk = findChild(children[i], "Utf8");
    const name = new TextDecoder().decode(nameChunk?.data);
    const key = name.startsWith("T_") ? name.slice(2) : "SOLIDS";
    const root: Chunk = { type: "RIFX", offset: -1, data: new Uint8Array(0), listType: "Egg!", children: block };
    const bytes = writeRifx({ root, xmp: "", trailer: new Uint8Array(0) });
    out.blocks[key] = Buffer.from(bytes).toString("base64");
    console.log(`${key.padEnd(8)} ${bytes.length} bytes`);
  }
  writeFileSync(OUT, JSON.stringify(out) + "\n");
  console.log(`empty    ${Buffer.from(out.empty, "base64").length} bytes -> ${OUT}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
