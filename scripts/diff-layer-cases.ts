// Lists the leaf chunks that differ between two py-aep reference cases in
// tests/data/layer-templates-cases.json, with the differing byte offsets.
//
//   node scripts/diff-layer-cases.ts <case a> <case b> [layer|item] [--hex]
import { readFileSync } from "node:fs";
import type { Chunk } from "../src/aep/riff.ts";
import { chunksFromBytes } from "../src/edit/layers.ts";

const cases = JSON.parse(readFileSync("tests/data/layer-templates-cases.json", "utf8"));
const [a, b, part = "layer"] = process.argv.slice(2);
const hex = process.argv.includes("--hex");

function leaves(chunks: Chunk[], path: string, out = new Map<string, Uint8Array>()): Map<string, Uint8Array> {
  const seen = new Map<string, number>();
  for (const c of chunks) {
    let key = c.listType ?? c.type;
    if (c.type === "tdmn") key = `tdmn=${new TextDecoder().decode(c.data).replace(/\0+$/, "")}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const here = `${path}/${key}#${n}`;
    if (c.children && c.type === "LIST") leaves(c.children, here, out);
    else out.set(here, c.data);
  }
  return out;
}

const decode = (list: string[]) => chunksFromBytes(list.map((s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))));
const x = leaves(decode(cases[Number(a)][part]), "");
const y = leaves(decode(cases[Number(b)][part]), "");
for (const key of new Set([...x.keys(), ...y.keys()])) {
  const p = x.get(key);
  const q = y.get(key);
  if (hex && p) console.log(key, p.length, Buffer.from(p).toString("hex"));
  if (!p || !q || p.length !== q.length) {
    console.log(`${key}: length ${p?.length} vs ${q?.length}`);
    continue;
  }
  const offsets = [...p.keys()].filter((i) => p[i] !== q[i]);
  if (offsets.length) console.log(`${key}: ${offsets.slice(0, 40).join(",")}`);
}
