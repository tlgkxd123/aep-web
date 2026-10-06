// Prints a project's chunk tree to a depth, with body sizes.
//   node scripts/projectops-tree.ts <file.aep> [depth] [--under LIST:Fold/LIST:Item#2/...]
// `--under` descends by chunk label; `#n` picks the n-th (0-based) match.
import { readFileSync } from "node:fs";
import { chunkLabel, readRifx, type Chunk } from "../src/aep/riff.ts";
import { chunkSize } from "../src/aep/write.ts";

const args = process.argv.slice(2);
const hexAt = args.indexOf("--hex");
const fullHex = hexAt >= 0 && !!args.splice(hexAt, 1);
const underAt = args.indexOf("--under");
const under = underAt >= 0 ? args.splice(underAt, 2)[1] : "";
const file = args[0];
const depth = Number(args[1] ?? 2);
const rifx = readRifx(new Uint8Array(readFileSync(file)));

function print(chunk: Chunk, level: number): void {
  const pad = "  ".repeat(level);
  const preview = chunk.children ? ` (${chunk.children.length})` : ` ${Buffer.from(fullHex ? chunk.data : chunk.data.subarray(0, 40)).toString("hex")}`;
  const name = chunk.children?.find((c) => c.type === "Utf8");
  const label = name && chunk.listType === "Item" ? ` "${new TextDecoder().decode(name.data)}"` : "";
  console.log(`${pad}${chunkLabel(chunk)}${label} ${chunkSize(chunk)}b${preview}`);
  if (level < depth) for (const child of chunk.children ?? []) print(child, level + 1);
}

let node = rifx.root;
for (const step of under.split("/").filter(Boolean)) {
  const [label, nth] = step.split("#");
  const matches = (node.children ?? []).filter((c) => chunkLabel(c) === label);
  const next = matches[Number(nth ?? 0)];
  if (!next) throw new Error(`no ${step} under ${chunkLabel(node)}`);
  node = next;
}
print(node, 0);
if (!under) console.log(`trailer ${rifx.trailer.length}b`);
