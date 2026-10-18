// Lists shape layers in the py-aep samples with their contents' match names, and which shape and mask
// properties have a stored (not left out) static instance to clone from:
//   node scripts/find-shape-donors.ts [--tree] [match name filter]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PropertyNode } from "../src/aep/model.ts";
import { projectFromRifx } from "../src/aep/parse.ts";
import { findList, readRifx } from "../src/aep/riff.ts";
import { SAMPLES } from "./lib/paths.ts";

const args = process.argv.slice(2);
const showTree = args.includes("--tree");
const filter = args.find((a) => !a.startsWith("--")) ?? "";

function* aepFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* aepFiles(path);
    else if (name.endsWith(".aep")) yield path;
  }
}

const tree = (nodes: readonly PropertyNode[], depth: number): string[] =>
  nodes.flatMap((n) => [
    `${"  ".repeat(depth)}${n.matchName}${n.kind === "property" && n.synthesized ? " (synth)" : ""}${n.kind === "property" && n.keyframes.length ? ` [${n.keyframes.length} keys]` : ""}`,
    ...(n.kind === "group" ? tree(n.children, depth + 1) : []),
  ]);

const stored = new Map<string, { count: number; first: string }>();
const seen = new Set<string>();
const visit = (nodes: readonly PropertyNode[], where: string) => {
  for (const n of nodes) {
    if (n.kind === "group") {
      visit(n.children, where);
      continue;
    }
    seen.add(n.matchName);
    if (n.synthesized || !n.chunk || n.keyframes.length || n.expression || findList(n.chunk, "list")) continue;
    const entry = stored.get(n.matchName);
    if (entry) entry.count++;
    else stored.set(n.matchName, { count: 1, first: where });
  }
};

for (const file of aepFiles(SAMPLES)) {
  let project;
  try {
    project = projectFromRifx(readRifx(new Uint8Array(readFileSync(file))));
  } catch {
    continue;
  }
  for (const item of project.items.values()) {
    if (item.kind !== "comp") continue;
    for (const layer of item.layers) {
      const where = `${file.slice(SAMPLES.length + 1)} | ${item.name} | ${layer.name}`;
      for (const group of ["ADBE Root Vectors Group", "ADBE Mask Parade"]) {
        const node = layer.properties.find((n) => n.matchName === group);
        if (node?.kind !== "group") continue;
        visit(node.children, where);
        const lines = tree(node.children, 2);
        if (showTree && layer.layerType === "ShapeLayer" && (!filter || lines.some((l) => l.includes(filter)))) console.log(`${where}\n${lines.join("\n")}`);
      }
    }
  }
}
if (!showTree) {
  for (const name of [...seen].sort()) {
    const entry = stored.get(name);
    console.log(`${name.padEnd(44)} ${entry ? `${String(entry.count).padStart(5)}  ${entry.first}` : "    -  (never stored)"}`);
  }
}
