// Writes the project templates (src/edit/data/project-templates.json) out as
// RIFX files for inspection with scripts/projectops-tree.ts:
//   node scripts/projectops-unpack.ts [outDir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import data from "../src/edit/data/project-templates.json" with { type: "json" };

const out = process.argv[2] ?? "refs/projectops-tmp";
mkdirSync(out, { recursive: true });
const files: [string, string][] = [["empty", data.empty], ...Object.entries(data.blocks as Record<string, string>)];
for (const [name, base64] of files) {
  const file = join(out, `${name}.aep`);
  writeFileSync(file, Buffer.from(base64, "base64"));
  console.log(file);
}
