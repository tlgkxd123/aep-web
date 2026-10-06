// Prints the parameter metadata (control type, range, popup options, value,
// keyframes) of the first instance of an effect in a project.
//
//   node scripts/effect-params.ts <project.aep> <effect match name>
import { readFileSync } from "node:fs";
import type { PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";

const [file, matchName] = process.argv.slice(2);
const bytes = readFileSync(file);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
for (const item of project.items.values()) {
  if (item.kind !== "comp") continue;
  for (const layer of item.layers) {
    const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
    const fx = parade?.children.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === matchName);
    if (!fx) continue;
    console.log(`${item.name} > ${layer.name}`);
    for (const p of fx.children) {
      if (p.kind !== "property") continue;
      const keys = p.keyframes.map((k) => `${k.time.toFixed(2)}:${JSON.stringify(k.value)}`).join(" ");
      console.log(`  ${p.matchName} "${p.name}" type=${p.controlType} min=${p.min} max=${p.max} value=${JSON.stringify(p.value)}${p.options ? ` options=${JSON.stringify(p.options)}` : ""}${keys ? ` keys=${keys}` : ""}`);
    }
    process.exit(0);
  }
}
