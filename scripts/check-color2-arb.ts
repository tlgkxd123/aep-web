// Prints the arbitrary data (aRbp) every instance of an effect stores in a project, by
// parameter, as hex rows of 32 bytes (and float32 / uint16 views with --floats / --u16).
//
//   node scripts/check-color2-arb.ts <match name> <project.aep> [--floats] [--u16] [--max n]
import { readFileSync } from "node:fs";
import type { PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import type { Chunk } from "../src/aep/riff.ts";

const [matchName, path] = process.argv.slice(2);
if (!matchName || !path) throw new Error("usage: node scripts/check-color2-arb.ts <match name> <project.aep>");
const floats = process.argv.includes("--floats");
const u16 = process.argv.includes("--u16");
const maxAt = process.argv.indexOf("--max");
const max = maxAt >= 0 ? Number(process.argv[maxAt + 1]) : 3;
const bytes = readFileSync(path);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const tdmn = (c: Chunk) => new TextDecoder().decode(c.data).replace(/\0[\s\S]*$/, "");

let shown = 0;
for (const item of project.items.values()) {
  if (item.kind !== "comp") continue;
  for (const layer of item.layers) {
    const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
    for (const fx of parade?.children ?? []) {
      if (fx.kind !== "group" || fx.matchName !== matchName || !fx.chunk || shown >= max) continue;
      shown++;
      console.log(`comp "${item.name}" layer "${layer.name}" effect "${fx.name}"`);
      if (process.argv.includes("--names"))
        for (const c of fx.children) {
          const options = "options" in c && Array.isArray(c.options) ? ` [${c.options.join(" | ")}]` : "";
          console.log(`  ${c.matchName}: ${c.name}${options}`);
        }
      const visit = (children: Chunk[]) => {
        let current = "";
        for (const c of children) {
          if (c.type === "tdmn") current = tdmn(c);
          else if (c.type === "aRbp") {
            const d = c.data;
            console.log(`  ${current}: ${d.length} bytes`);
            for (let o = 0; o < d.length; o += 32) console.log(`    ${o.toString().padStart(5)} ${Array.from(d.subarray(o, o + 32), (b) => b.toString(16).padStart(2, "0")).join(" ")}`);
            const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
            if (floats) console.log(`    f32le ${Array.from({ length: d.length >> 2 }, (_, i) => +view.getFloat32(i * 4, true).toPrecision(5)).join(" ")}`);
            if (u16) console.log(`    u16le ${Array.from({ length: d.length >> 1 }, (_, i) => view.getUint16(i * 2, true)).join(" ")}`);
          } else if (c.children) visit(c.children);
        }
      };
      visit(fx.chunk.children ?? []);
    }
  }
}
if (!shown) console.log(`no ${matchName} in ${path}`);
