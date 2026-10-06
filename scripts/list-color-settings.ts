// Prints the project color settings AE reported for each sample export, grouped,
// to find samples rendered with AE's default color pipeline.
//   node scripts/list-color-settings.ts [--samples DIR]
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const dir = resolve(process.argv[3] ?? "../_ref/py-aep/samples");
const groups = new Map<string, string[]>();
function* walk(d: string): Generator<string> {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (statSync(f).isDirectory()) yield* walk(f);
    else if (n.endsWith(".json") && !n.includes("value_at_time") && !n.includes("probe")) yield f;
  }
}
for (const file of walk(dir)) {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    continue;
  }
  if (!("bitsPerChannel" in j)) continue;
  const key = JSON.stringify({
    cms: j.colorManagementSystem,
    bpc: j.bitsPerChannel,
    linearBlending: j.linearBlending,
    linearize: j.linearizeWorkingSpace,
    workingSpace: j.workingSpace,
    gamma: j.workingGamma,
    ocio: j.ocioConfigurationFile,
  });
  const list = groups.get(key) ?? [];
  list.push(relative(dir, file));
  groups.set(key, list);
}
for (const [key, files] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`${files.length} files: ${key}`);
  console.log(`   e.g. ${files.slice(0, 4).join(", ")}`);
}
