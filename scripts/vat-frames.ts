// Debug helper: prints ours vs AE per frame for one property of a value_at_time export.
//   node scripts/vat-frames.ts <export.json> <propertyPath> [fromFrame] [toFrame]
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { valueAtTime } from "../src/aep/evaluate.ts";
import type { CompItem, PropertyNode } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";

const [file, path, from = "0", to = "20"] = process.argv.slice(2);
const json = JSON.parse(readFileSync(file, "utf8"));
const project = parseProject(new Uint8Array(readFileSync(resolve(dirname(file), "..", json.source))));
for (const jComp of json.comps) {
  const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === jComp.name)!;
  for (const jLayer of jComp.layers) {
    const layer = comp.layers[jLayer.index - 1];
    for (const jProp of jLayer.properties) {
      if (jProp.path !== path) continue;
      let level: PropertyNode[] = layer.properties;
      let node: PropertyNode | undefined;
      let siblings = level;
      for (const name of path.split(" > ")) {
        siblings = level;
        node = level.find((n) => n.name === name);
        level = node?.kind === "group" ? node.children : [];
      }
      if (node?.kind !== "property") continue;
      console.log(`${jComp.name} layer ${jLayer.index}: keys`, JSON.stringify(node.keyframes.map((k) => ({ t: k.layerTime, v: k.value, i: k.inInterpolationType, o: k.outInterpolationType, inE: k.inTemporalEase, outE: k.outTemporalEase, ist: k.inSpatialTangent, ost: k.outSpatialTangent, ab: k.spatialAutoBezier }))));
      for (const frame of jProp.frames.slice(Number(from), Number(to))) {
        const ours = valueAtTime(node, frame.time, layer, siblings);
        console.log(`f${frame.frame} t=${frame.time.toFixed(4)} ae=${JSON.stringify(frame.value)} ours=${JSON.stringify(ours)}`);
      }
    }
  }
}
