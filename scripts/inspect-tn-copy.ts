import { readFileSync } from "node:fs";
import type { CompItem, FolderItem, PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { valueAtTime } from "../src/aep/evaluate.ts";

const raw = readFileSync("C:/Users/schxm/Downloads/TN 2020 2 copy.aep");
const project = parseProject(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
const folderPath = (id: number | undefined): string => {
  if (!id) return "";
  const f = project.items.get(id) as FolderItem | undefined;
  return f ? `${folderPath(f.parentFolderId)}${f.name}/` : "";
};

for (const item of project.items.values()) {
  if (item.kind !== "comp") continue;
  const comp = item as CompItem;
  for (const l of comp.layers) {
    const fxParade = l.properties.find((p) => p.matchName === "ADBE Effect Parade") as PropertyGroup | undefined;
    for (const fx of fxParade?.children ?? []) {
      if (fx.kind === "group" && fx.matchName === "tc Particular") {
        const pType = fx.children.find((p) => p.matchName === "tc Particular-0026");
        const tex = fx.children.find((p) => p.matchName === "tc Particular-0066");
        const sampling = fx.children.find((p) => p.matchName === "tc Particular-0067");
        const size = fx.children.find((p) => p.matchName === "tc Particular-0027");
        const op = fx.children.find((p) => p.matchName === "tc Particular-0033");
        const rate = fx.children.find((p) => p.matchName === "tc Particular-0146");
        console.log(`${folderPath(comp.parentFolderId)}${comp.name} (id=${comp.id}) > L${l.index}.${l.name} (enabled=${l.enabled}): type=${pType?.kind === "property" ? valueAtTime(pType, 6, l) : "?"} tex=${tex?.kind === "property" ? valueAtTime(tex, 6, l) : "?"} sampling=${sampling?.kind === "property" ? valueAtTime(sampling, 6, l) : "?"} size=${size?.kind === "property" ? valueAtTime(size, 6, l) : "?"} op=${op?.kind === "property" ? valueAtTime(op, 6, l) : "?"} rate=${rate?.kind === "property" ? valueAtTime(rate, 6, l) : "?"}`);
      }
    }
  }
}
