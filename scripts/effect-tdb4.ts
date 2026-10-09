// Lists the distinct tdb4 (and cdat size, tdsb) of stored effect parameters in a project by
// control type, to see what a parameter After Effects left out must be written with.
//
//   node scripts/effect-tdb4.ts <project.aep> [...more.aep]
import { readFileSync } from "node:fs";
import type { PropertyNode } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { findChild } from "../src/aep/riff.ts";

const seen = new Map<string, { count: number; example: string }>();
for (const file of process.argv.slice(2)) {
  const bytes = readFileSync(file);
  const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const walk = (nodes: readonly PropertyNode[], inEffect: boolean) => {
    for (const n of nodes) {
      if (n.kind === "group") walk(n.children, inEffect || !!n.isEffect);
      else if (inEffect && n.chunk && !n.synthesized && n.controlType !== undefined) {
        const tdb4 = findChild(n.chunk, "tdb4");
        const cdat = findChild(n.chunk, "cdat");
        const tdsb = findChild(n.chunk, "tdsb");
        if (!tdb4) continue;
        const hex = Buffer.from(tdb4.data).toString("hex");
        const key = `ct ${n.controlType} pvt ${n.propertyValueType} kf ${n.keyframes.length ? 1 : 0} expr ${n.expression ? 1 : 0} cdat ${cdat?.data.length ?? "-"} tdsb ${tdsb ? Buffer.from(tdsb.data).toString("hex") : "-"}\n    ${hex}`;
        const entry = seen.get(key) ?? { count: 0, example: n.matchName };
        entry.count++;
        seen.set(key, entry);
      }
    }
  };
  for (const item of project.items.values()) if (item.kind === "comp") for (const layer of item.layers) walk(layer.properties, false);
}
for (const [key, { count, example }] of [...seen].sort()) console.log(`${count}x ${example}: ${key}`);
