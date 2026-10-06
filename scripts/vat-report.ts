// Compares valueAtTime() against After Effects' own per-frame values for every
// animated property in the py-aep value_at_time ground-truth exports.
//
//   node scripts/vat-report.ts [--dir DIR] [--require] [--verbose]
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { valueAtTime } from "../src/aep/evaluate.ts";
import type { CompItem, PropertyNode, PropertyValue } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";

type Json = Record<string, any>;

const args = process.argv.slice(2);
const dirArg = args.indexOf("--dir");
const dir = resolve(dirArg >= 0 ? args[dirArg + 1] : (process.env.AEP_VAT ?? "../_ref/py-aep/samples/models/property/value_at_time"));
const verbose = args.includes("--verbose");
const TOLERANCE = 1e-3;
// AE's motion-path pipeline adds up to ~0.011 px of noise even on straight
// LINEAR moves; py-aep's own value_at_time tests use the same 0.015 bound.
const SPATIAL_TOLERANCE = 0.015;
const MOTION_PATH_TYPES = new Set([6413, 6415]);

function flatten(v: PropertyValue | Json | null | undefined): number[] | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return [v];
  if (Array.isArray(v)) return v.flat(2) as number[];
  const shape = v as Json;
  if (typeof v === "object" && Array.isArray(shape.vertices)) {
    return [Number(!!shape.closed), ...shape.vertices.flat(), ...shape.inTangents.flat(), ...shape.outTangents.flat()];
  }
  return null;
}

function findProperty(nodes: PropertyNode[], names: string[], matchName: string): { prop: PropertyNode; siblings: PropertyNode[] } | undefined {
  let level = nodes;
  for (let i = 0; i < names.length; i++) {
    const last = i === names.length - 1;
    const node = level.find((n) => n.name === names[i] && (!last || n.matchName === matchName));
    if (!node) return undefined;
    if (last) return { prop: node, siblings: level };
    if (node.kind !== "group") return undefined;
    level = node.children;
  }
  return undefined;
}

if (!existsSync(dir)) {
  console.error(`value_at_time directory not found: ${dir}`);
  process.exit(1);
}

let frames = 0;
let within = 0;
let properties = 0;
let missing = 0;
const worst: { error: number; where: string }[] = [];

for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const json: Json = JSON.parse(readFileSync(join(dir, name), "utf8"));
  const project = parseProject(new Uint8Array(readFileSync(resolve(dir, "..", json.source))));
  for (const jComp of json.comps ?? []) {
    const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === jComp.name);
    for (const jLayer of jComp.layers ?? []) {
      const layer = comp?.layers[jLayer.index - 1];
      for (const jProp of jLayer.properties ?? []) {
        properties++;
        const where = `${json.source} / ${jComp.name} / ${jLayer.index} / ${jProp.path}`;
        const found = layer && findProperty(layer.properties, String(jProp.path).split(" > "), jProp.matchName);
        if (!layer || !found || found.prop.kind !== "property") {
          missing++;
          worst.push({ error: Infinity, where: `${where}: property not found` });
          continue;
        }
        const prop = found.prop;
        const tolerance =
          MOTION_PATH_TYPES.has(prop.propertyValueType) && prop.matchName !== "ADBE Orientation" ? SPATIAL_TOLERANCE : TOLERANCE;
        let maxError = 0;
        let maxAt = 0;
        for (const frame of jProp.frames ?? []) {
          frames++;
          const ours = flatten(valueAtTime(found.prop, frame.time, layer, found.siblings));
          const theirs = flatten(frame.value);
          let error = Infinity;
          if (ours && theirs && ours.length === theirs.length) {
            error = Math.max(0, ...ours.map((v, i) => Math.abs(v - theirs[i]) / Math.max(1, Math.abs(theirs[i]) * 1e-3)));
          }
          if (error <= tolerance) within++;
          if (error > maxError) {
            maxError = error;
            maxAt = frame.time;
          }
        }
        if (maxError > tolerance || verbose) worst.push({ error: maxError, where: `${where} (worst at t=${maxAt}, tolerance ${tolerance})` });
      }
    }
  }
}

worst.sort((a, b) => b.error - a.error);
const rate = frames ? within / frames : 0;
console.log(
  `properties: ${properties} (${missing} not found), frames: ${frames}, within tolerance (${TOLERANCE}, motion paths ${SPATIAL_TOLERANCE}): ${within} (${(rate * 100).toFixed(3)}%)`,
);
for (const w of worst.slice(0, verbose ? 60 : 15)) console.log(`  ${w.error === Infinity ? "mismatch" : w.error.toExponential(2)}  ${w.where}`);

if (args.includes("--require")) {
  if (missing === 0 && frames > 0 && within === frames) console.log("VALUE-AT-TIME-PASSED");
  else {
    console.log("value-at-time requirement not met");
    process.exit(1);
  }
}
