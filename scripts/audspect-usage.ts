// Summarizes the Audio Spectrum settings a project uses.
//
//   node scripts/audspect-usage.ts <project.aep>
import { readFileSync } from "node:fs";
import type { PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";

const bytes = readFileSync(process.argv[2]);
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const names = ["", "Audio Layer", "Start", "End", "Path", "Polar", "F0", "F1", "Bands", "MaxH", "Dur", "Offset", "Thick", "Soft", "In", "Out", "Blend", "HueInterp", "DynHue", "Symm", "Display", "Side", "Avg", "Composite"];
for (const item of project.items.values()) {
  if (item.kind !== "comp") continue;
  for (const layer of item.layers) {
    const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
    for (const fx of parade?.children ?? []) {
      if (fx.kind !== "group" || fx.matchName !== "ADBE AudSpect") continue;
      const v = (i: number) => {
        const p = fx.children.find((c) => c.matchName === `ADBE AudSpect-${String(i).padStart(4, "0")}`);
        if (p?.kind !== "property") return "-";
        const value = JSON.stringify(p.value);
        return p.keyframes.length ? `${value}(k${p.keyframes.length})` : p.expressionEnabled ? `${value}(expr)` : value;
      };
      console.log(`${item.name} > ${layer.name} (${layer.width}x${layer.height}): ` + [4, 5, 6, 7, 8, 9, 10, 12, 13, 20, 21, 22, 23].map((i) => `${names[i]}=${v(i)}`).join(" "));
    }
  }
}
