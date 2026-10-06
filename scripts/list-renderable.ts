// Lists corpus samples After Effects 2025 can open (saved with AE <= 25), with
// their compositions and layer kinds, to pick reference-render candidates.
//   node scripts/list-renderable.ts [--samples DIR] [--max-major 25]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseProject } from "../src/aep/parse.ts";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const dir = resolve(opt("--samples") ?? "../_ref/py-aep/samples");
const maxMajor = Number(opt("--max-major") ?? 25);

function* walk(d: string): Generator<string> {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) yield* walk(f);
    else if (n.endsWith(".aep")) yield f;
  }
}

const byVersion = new Map<number, number>();
for (const file of walk(dir)) {
  const project = parseProject(new Uint8Array(readFileSync(file)));
  const major = Number(project.version.split(".")[0]);
  byVersion.set(major, (byVersion.get(major) ?? 0) + 1);
  if (major > maxMajor) continue;
  const comps = [...project.items.values()].filter((i) => i.kind === "comp");
  const summary = comps
    .map((c) => {
      const kinds = new Map<string, number>();
      for (const l of c.kind === "comp" ? c.layers : []) {
        const source = l.sourceId ? project.items.get(l.sourceId) : undefined;
        const kind =
          l.layerType !== "AVLayer"
            ? l.layerType
            : source?.kind === "comp"
              ? "precomp"
              : source?.kind === "footage"
                ? source.mainSource.sourceType.replace("Source", "")
                : "AV";
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
      return `"${c.name}" [${[...kinds].map(([k, n]) => `${k}${n > 1 ? `x${n}` : ""}`).join(" ")}]`;
    })
    .join("; ");
  console.log(`${project.version.padEnd(9)} ${relative(dir, file)}: ${summary}`);
}
console.log("files by AE major version:", Object.fromEntries([...byVersion].sort((a, b) => a[0] - b[0])));
