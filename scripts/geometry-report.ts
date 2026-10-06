// Checks layer transforms against After Effects' own point conversions
// (sourcePointToComp / compPointToSource) from py-aep's geometry probes.
//
//   node scripts/geometry-report.ts [--layer-samples DIR] [--require]
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CompItem } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { compPointToSource, sourcePointToComp } from "../src/aep/transform.ts";

const args = process.argv.slice(2);
const dirArg = args.indexOf("--layer-samples");
const dir = resolve(dirArg >= 0 ? args[dirArg + 1] : (process.env.AEP_LAYER_SAMPLES ?? "../_ref/py-aep/samples/models/layer"));
const TOLERANCE = 5e-3;
const POINTS: [number, number][] = [[0, 0], [100, 50], [960, 540]];
const CAMERA_POINTS: [number, number][] = [[0, 0], [100, 50], [200, 100]];

type Expected = { ok: boolean; value?: [number, number] };
let checks = 0;
let failures = 0;

function check(label: string, compute: () => [number, number], want: Expected): void {
  if (!want.ok || !want.value) return;
  checks++;
  let got: [number, number] | string;
  try {
    got = compute();
  } catch (error) {
    got = (error as Error).message;
  }
  const ok = Array.isArray(got) && got.every((v, i) => Math.abs(v - want.value![i]) <= TOLERANCE);
  if (!ok) {
    failures++;
    console.log(`  FAIL ${label}: ours=${JSON.stringify(got)} ae=${JSON.stringify(want.value)}`);
  }
}

function comp(file: string, name: string): CompItem {
  const project = parseProject(new Uint8Array(readFileSync(resolve(dir, file))));
  const found = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === name);
  if (!found) throw new Error(`comp ${name} not found in ${file}`);
  return found;
}

const probe = JSON.parse(readFileSync(resolve(dir, "geometry_points_probe.json"), "utf8"));
const main = comp("geometry_probe.aep", "PROBE_MAIN");
for (const [timeKey, time] of [["time0", 0], ["time1.5", 1.5]] as const) {
  for (const [layerName, entry] of Object.entries<{ s2c: Expected[]; c2s: Expected[] }>(probe[timeKey])) {
    const layer = main.layers.find((l) => l.name === layerName);
    if (!layer) throw new Error(`layer ${layerName} not found`);
    POINTS.forEach((pt, i) => {
      check(`${layerName} s2c ${pt} @${time}`, () => sourcePointToComp(layer, main, pt, time), entry.s2c[i]);
      check(`${layerName} c2s ${pt} @${time}`, () => compPointToSource(layer, main, pt, time), entry.c2s[i]);
    });
  }
}

const rigs = JSON.parse(readFileSync(resolve(dir, "camera_rigs_probe.json"), "utf8"));
for (const [compName, key] of [["CAM_ONE", "one_node"], ["CAM_TWO", "two_node"], ["CAM_KEYED", "keyed_zoom"], ["CAM_NONE", "no_camera"]]) {
  const c = comp("camera_rigs.aep", compName);
  const layer = c.layers.find((l) => l.name === "target3d");
  if (!layer) throw new Error(`target3d not found in ${compName}`);
  for (const [timeKey, entry] of Object.entries<{ s2c: Expected[]; c2s: Expected[] }>(rigs[key].conv)) {
    const time = Number(timeKey.slice(1));
    CAMERA_POINTS.forEach((pt, i) => {
      check(`${compName} s2c ${pt} @${time}`, () => sourcePointToComp(layer, c, pt, time), entry.s2c[i]);
      check(`${compName} c2s ${pt} @${time}`, () => compPointToSource(layer, c, pt, time), entry.c2s[i]);
    });
  }
}

console.log(`geometry checks: ${checks}, failures: ${failures} (tolerance ${TOLERANCE} px)`);
if (args.includes("--require")) {
  if (checks > 0 && failures === 0) console.log("GEOMETRY-PASSED");
  else {
    console.log("geometry requirement not met");
    process.exit(1);
  }
}
