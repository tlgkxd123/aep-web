// Prints a chunk tree: node scripts/dump-chunks.ts template <name>
//                      node scripts/dump-chunks.ts layer <file.aep> <comp> <layer> [depth]
import { readFileSync } from "node:fs";
import { projectFromRifx } from "../src/aep/parse.ts";
import { readRifx, type Chunk } from "../src/aep/riff.ts";
import templates from "../src/edit/data/layer-templates.json" with { type: "json" };
import { chunksFromBytes } from "../src/edit/layers.ts";

const [mode, ...args] = process.argv.slice(2);
const depthLimit = Number(process.argv.at(-1)) || 99;

function dump(chunk: Chunk, depth = 0): void {
  if (depth > depthLimit) return;
  const pad = "  ".repeat(depth);
  if (chunk.type === "LIST") console.log(`${pad}LIST:${chunk.listType}`);
  else {
    const text = chunk.type === "tdmn" || chunk.type === "Utf8" ? ` "${new TextDecoder().decode(chunk.data).replace(/\0.*$/s, "")}"` : "";
    console.log(`${pad}${chunk.type} ${chunk.data.length}${text} ${chunk.data.length <= 48 ? Buffer.from(chunk.data).toString("hex") : ""}`);
  }
  chunk.children?.forEach((c) => dump(c, depth + 1));
}

if (mode === "template") {
  const list = (templates as Record<string, unknown>)[args[0]] as string[];
  chunksFromBytes(list.map((s) => Uint8Array.from(Buffer.from(s, "base64")))).forEach((c) => dump(c));
} else {
  const project = projectFromRifx(readRifx(new Uint8Array(readFileSync(args[0]))));
  const comp = [...project.items.values()].find((i) => i.kind === "comp" && i.name === args[1]);
  const layer = comp?.kind === "comp" ? comp.layers.find((l) => l.name === args[2]) : undefined;
  if (layer) dump(layer.chunk);
}
