// Debug helper: prints a layer's property tree or a chunk subtree.
//   node scripts/dump.ts <file.aep> [compName] [layerIndex] [--chunks]
import { readFileSync } from "node:fs";
import { parseProject } from "../src/aep/parse.ts";
import { chunkLabel, type Chunk } from "../src/aep/riff.ts";
import type { PropertyNode } from "../src/aep/model.ts";

const [file, compName, layerIndex] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const project = parseProject(new Uint8Array(readFileSync(file)));

function printChunk(chunk: Chunk, depth: number): void {
  const pad = "  ".repeat(depth);
  const preview = chunk.children ? "" : ` ${chunk.data.length}b ${Buffer.from(chunk.data.subarray(0, 24)).toString("hex")}`;
  console.log(`${pad}${chunkLabel(chunk)}${preview}`);
  for (const child of chunk.children ?? []) printChunk(child, depth + 1);
}

function printNode(node: PropertyNode, depth: number): void {
  const pad = "  ".repeat(depth);
  if (node.kind === "group") {
    console.log(`${pad}[${node.matchName}] "${node.name}"${node.synthesized ? " (synth)" : ""}`);
    node.children.forEach((c) => printNode(c, depth + 1));
  } else {
    const keys = node.keyframes.length ? ` keys=${node.keyframes.length}` : "";
    console.log(`${pad}${node.matchName} "${node.name}" pvt=${node.propertyValueType} ct=${node.controlType ?? "-"} = ${JSON.stringify(node.value)}${keys}${node.synthesized ? " (synth)" : ""}`);
  }
}

const pardArg = process.argv.indexOf("--pard");
if (pardArg >= 0) {
  const wanted = process.argv[pardArg + 1];
  const walk = (chunk: Chunk): void => {
    const kids = chunk.children ?? [];
    kids.forEach((c, i) => {
      if (c.type === "tdmn" && Buffer.from(c.data).toString("utf8").replace(/\0+$/, "") === wanted) {
        const pard = kids.slice(i + 1).find((k) => k.type === "pard");
        if (pard) console.log(`pard @${pard.offset}: ${Buffer.from(pard.data).toString("hex").replace(/(.{8})/g, "$1 ")}`);
      }
      walk(c);
    });
  };
  walk(project.file.root);
  process.exit(0);
}

const effectArg = process.argv.indexOf("--effect");
if (effectArg >= 0) {
  const matchName = process.argv[effectArg + 1];
  for (const def of project.effectParams.get(matchName) ?? []) console.log(JSON.stringify(def));
  process.exit(0);
}

console.log(`version ${project.version}, warnings: ${project.warnings.length}`);
project.warnings.slice(0, 10).forEach((w) => console.log(`  warn ${w}`));
for (const item of project.items.values()) {
  if (item.kind !== "comp" || (compName && item.name !== compName)) continue;
  console.log(`comp "${item.name}" ${item.width}x${item.height}`);
  for (const layer of item.layers) {
    if (layerIndex && layer.index !== Number(layerIndex)) continue;
    console.log(` layer ${layer.index} "${layer.name}" ${layer.matchName}`);
    if (process.argv.includes("--chunks")) printChunk(layer.chunk, 2);
    else layer.properties.forEach((p) => printNode(p, 2));
  }
}
