// Debug helper: prints the run-length-collapsed child sequence of composition
// item lists, to find layer block boundaries.
//   node scripts/comp-children.ts [file.aep]
import { readFileSync } from "node:fs";
import { parseProject } from "../src/aep/parse.ts";
import { chunkLabel } from "../src/aep/riff.ts";
import { corpusFiles } from "./lib/corpus.ts";

const tally = new Map<string, number>();
const files = process.argv[2] ? [process.argv[2]] : corpusFiles();
for (const file of files) {
  let project;
  try {
    project = parseProject(new Uint8Array(readFileSync(file)));
  } catch {
    continue;
  }
  for (const item of project.items.values()) {
    if (item.kind !== "comp" || !item.chunk?.children) continue;
    const labels: string[] = [];
    for (const label of item.chunk.children.map(chunkLabel)) {
      if (labels.at(-1)?.startsWith(label)) {
        const m = /\*(\d+)$/.exec(labels.at(-1)!);
        labels[labels.length - 1] = `${label}*${m ? Number(m[1]) + 1 : 2}`;
      } else labels.push(label);
    }
    const key = labels.join(" ").replace(/\*\d+/g, "*");
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
}
for (const [key, n] of [...tally].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(String(n).padStart(6), key, "\n");
