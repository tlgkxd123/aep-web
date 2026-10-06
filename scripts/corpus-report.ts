// Parses every .aep in the py-aep sample corpus and compares the result with
// the ExtendScript JSON export AE wrote next to each sample.
//
//   node scripts/corpus-report.ts [--samples DIR] [--require-parse] [--require-match] [--verbose]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseProject } from "../src/aep/parse.ts";
import { isShapeValue, PropertyValueType, type Item, type Layer, type Property, type PropertyNode, type Shape } from "../src/aep/model.ts";

type Json = Record<string, any>;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const samplesDir = resolve(option("--samples") ?? process.env.AEP_SAMPLES ?? "../_ref/py-aep/samples");
const verbose = flag("--verbose");

// Exports that describe a different project state than the .aep beside them
// (py-aep does not validate these pairs either).
const STALE_EXPORTS = new Map([
  ["models/composition/selection_both_layers.aep", "JSON shows a 100x100 comp with 'Solid 1'; the file holds a 1920x1080 comp with 'Gray Solid 1'"],
  ["models/selection/selection_dropshadow_enabled_opacity.aep", "JSON shows a 100x100 comp with 'TestLayer'; the file holds a 1000x1000 comp with 'Gray Solid 1'"],
]);

class Tally {
  compared = 0;
  mismatched = 0;
  readonly byField = new Map<string, { count: number; examples: string[] }>();
  check(field: string, ours: unknown, theirs: unknown, where: string): void {
    this.compared++;
    if (equal(ours, theirs)) return;
    this.mismatched++;
    const example = `${where}: ours=${short(ours)} ae=${short(theirs)}`;
    const entry = this.byField.get(field);
    if (!entry) this.byField.set(field, { count: 1, examples: [example] });
    else {
      entry.count++;
      if (entry.examples.length < (verbose ? 8 : 1)) entry.examples.push(example);
    }
  }
  rate(): number {
    return this.compared ? (this.compared - this.mismatched) / this.compared : 1;
  }
}

function short(v: unknown): string {
  const s = JSON.stringify(v);
  return s === undefined ? "undefined" : s.length > 120 ? s.slice(0, 117) + "..." : s;
}

function equal(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") {
    return Math.abs(a - b) <= 1e-3 + 1e-6 * Math.abs(b);
  }
  if (typeof a === "boolean" && typeof b === "number") return Number(a) === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  }
  if (a === undefined && b === null) return true;
  return a === b;
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.toLowerCase().endsWith(".aep")) yield full;
  }
}

const tallies = {
  items: new Tally(),
  layers: new Tally(),
  values: new Tally(),
  keyframes: new Tally(),
};
let layersMissing = 0;
let layersExpected = 0;
let jsonLeavesMissing = 0;
let jsonLeavesTotal = 0;
const missingByMatchName = new Map<string, number>();
const noteMissing = (matchName: string, count = 1) =>
  missingByMatchName.set(matchName, (missingByMatchName.get(matchName) ?? 0) + count);

const ITEM_FIELDS = ["name", "typeName", "comment", "label"];
const COMP_FIELDS = [
  "width", "height", "duration", "frameRate", "pixelAspect", "bgColor", "displayStartTime",
  "workAreaStart", "workAreaDuration", "shutterAngle", "shutterPhase", "motionBlur",
  "frameBlending", "hideShyLayers", "draft3d", "resolutionFactor",
];
const FOOTAGE_FIELDS = ["width", "height", "duration", "frameRate", "pixelAspect"];
const LAYER_FIELDS: (keyof Layer)[] = [
  "id", "name", "matchName", "comment", "inPoint", "outPoint", "startTime", "stretch",
  "enabled", "solo", "shy", "locked", "threeDLayer", "threeDPerChar", "adjustmentLayer", "nullLayer",
  "guideLayer", "environmentLayer", "collapseTransformation", "effectsActive", "audioEnabled",
  "motionBlur", "preserveTransparency", "blendingMode", "trackMatteType", "label", "quality",
  "samplingQuality", "autoOrient", "frameBlendingType", "timeRemapEnabled", "sourceId", "width", "height",
];

function compareItem(item: Item, json: Json, where: string): void {
  const t = tallies.items;
  for (const f of ITEM_FIELDS) if (f in json) t.check(`item.${f}`, (item as Json)[f], json[f], where);
  t.check("item.parentFolderId", item.parentFolderId, json.parentFolderId ?? 0, where);
  const fields = item.kind === "comp" ? COMP_FIELDS : item.kind === "footage" ? FOOTAGE_FIELDS : [];
  for (const f of fields) if (f in json) t.check(`${item.kind}.${f}`, (item as Json)[f], json[f], where);
  if (item.kind === "footage" && json.mainSource) {
    t.check("footage.sourceType", item.mainSource.sourceType, json.mainSource.sourceType, where);
    if (item.mainSource.sourceType === "SolidSource" && json.mainSource.color) {
      t.check("footage.solidColor", item.mainSource.color, json.mainSource.color, where);
    }
  }
  if (item.kind === "comp" && "numLayers" in json) t.check("comp.numLayers", item.layers.length, json.numLayers, where);
}

function compareLayer(layer: Layer, json: Json, where: string): void {
  const t = tallies.layers;
  for (const f of LAYER_FIELDS) if (f in json) t.check(`layer.${f}`, layer[f], json[f], where);
  const parentIndex = layer.parentId ? parentIndexOf(layer) : undefined;
  t.check("layer.parentIndex", parentIndex, json.parentIndex, where);
  compareProperties(layer.properties, json.properties ?? [], `${where}`);
}

let currentLayers: Layer[] = [];
function parentIndexOf(layer: Layer): number | undefined {
  return currentLayers.find((l) => l.id === layer.parentId)?.index;
}

function countJsonLeaves(nodes: Json[]): number {
  let n = 0;
  for (const node of nodes) {
    if (Array.isArray(node.properties)) n += countJsonLeaves(node.properties);
    else if (node.propertyType === "Property") n++;
  }
  return n;
}

function compareProperties(ours: PropertyNode[], theirs: Json[], where: string): void {
  const seen = new Map<string, number>();
  const ourByKey = new Map<string, PropertyNode>();
  for (const node of ours) {
    const n = seen.get(node.matchName) ?? 0;
    seen.set(node.matchName, n + 1);
    ourByKey.set(`${node.matchName}#${n}`, node);
  }
  const jsonSeen = new Map<string, number>();
  for (const j of theirs) {
    const n = jsonSeen.get(j.matchName) ?? 0;
    jsonSeen.set(j.matchName, n + 1);
    const node = ourByKey.get(`${j.matchName}#${n}`);
    const path = `${where} > ${j.matchName}${n ? `#${n}` : ""}`;
    if (!node) {
      if (Array.isArray(j.properties)) {
        const leaves = countJsonLeaves(j.properties);
        jsonLeavesMissing += leaves;
        jsonLeavesTotal += leaves;
        if (leaves) noteMissing(`${j.matchName} (group)`, leaves);
      } else if (j.propertyType === "Property") {
        jsonLeavesMissing++;
        jsonLeavesTotal++;
        noteMissing(j.matchName);
      }
      continue;
    }
    tallies.values.check("property.name", node.name, j.name, path);
    if (node.kind === "group") {
      if (Array.isArray(j.properties)) compareProperties(node.children, j.properties, path);
      if (node.mask && j.maskMode !== undefined) {
        tallies.values.check("mask.maskMode", node.mask.maskMode, j.maskMode, path);
        tallies.values.check("mask.inverted", node.mask.inverted, j.inverted, path);
        tallies.values.check("mask.rotoBezier", node.mask.rotoBezier, j.rotoBezier, path);
        tallies.values.check("mask.color", node.mask.color, j.color, path);
      }
    } else {
      jsonLeavesTotal++;
      compareLeaf(node, j, path);
    }
  }
}

const OPAQUE_TYPES: Set<number> = new Set([
  PropertyValueType.NO_VALUE,
  PropertyValueType.CUSTOM_VALUE,
  PropertyValueType.MARKER,
  PropertyValueType.TEXT_DOCUMENT,
]);

function compareShape(field: string, ours: Shape, theirs: Json, path: string): void {
  tallies.values.check(`${field}.closed`, ours.closed, theirs.closed, path);
  tallies.values.check(`${field}.vertices`, ours.vertices.flat(), (theirs.vertices ?? []).flat(), path);
  tallies.values.check(`${field}.inTangents`, ours.inTangents.flat(), (theirs.inTangents ?? []).flat(), path);
  tallies.values.check(`${field}.outTangents`, ours.outTangents.flat(), (theirs.outTangents ?? []).flat(), path);
}

function compareLeaf(prop: Property, j: Json, path: string): void {
  const t = tallies.values;
  if ("propertyValueType" in j) t.check("property.propertyValueType", prop.propertyValueType, j.propertyValueType, path);
  if ("expression" in j) t.check("property.expression", prop.expression, j.expression, path);
  if ("expressionEnabled" in j) t.check("property.expressionEnabled", prop.expressionEnabled, j.expressionEnabled, path);
  // Essential Graphics override leaves report their source property's state, which is not linked yet.
  if ("enabled" in j && !prop.synthesized && !path.includes("ADBE Layer Overrides")) {
    t.check("property.enabled", prop.enabled, j.enabled, path);
  }
  if (OPAQUE_TYPES.has(prop.propertyValueType)) return;
  if ("numKeys" in j) t.check("property.numKeys", prop.keyframes.length, j.numKeys, path);
  const animated = (j.numKeys ?? 0) > 0 || j.expressionEnabled;
  if (!animated && "value" in j) {
    if (prop.propertyValueType === PropertyValueType.SHAPE) {
      if (isShapeValue(prop.value) && j.value) {
        compareShape("property.shapeValue", prop.value, j.value, path);
      } else t.check("property.shapeValue", prop.value, j.value, path);
    } else {
      const field = !prop.synthesized ? "property.value" : prop.controlType !== undefined ? "effect.synthesizedValue" : "synthesized.value";
      t.check(field, prop.value, j.value, path);
    }
  }
  const keys: Json[] = j.keyframes ?? [];
  keys.forEach((k, i) => {
    const kf = prop.keyframes[i];
    const kpath = `${path} key ${i + 1}`;
    const kt = tallies.keyframes;
    if (!kf) {
      kt.check("keyframe.present", false, true, kpath);
      return;
    }
    kt.check("keyframe.time", kf.time, k.time, kpath);
    kt.check("keyframe.inInterpolationType", kf.inInterpolationType, k.inInterpolationType, kpath);
    kt.check("keyframe.outInterpolationType", kf.outInterpolationType, k.outInterpolationType, kpath);
    if (prop.propertyValueType === PropertyValueType.SHAPE) {
      if (isShapeValue(kf.value) && k.value) {
        compareShape("keyframe.shapeValue", kf.value, k.value, kpath);
      }
    } else if ("value" in k) {
      kt.check("keyframe.value", kf.value, k.value, kpath);
    }
    if (k.inSpatialTangent && kf.inSpatialTangent) {
      kt.check("keyframe.inSpatialTangent", kf.inSpatialTangent, k.inSpatialTangent, kpath);
      kt.check("keyframe.outSpatialTangent", kf.outSpatialTangent, k.outSpatialTangent, kpath);
    }
    if ("roving" in k) kt.check("keyframe.roving", kf.roving, k.roving, kpath);
  });
}

if (!existsSync(samplesDir)) {
  console.error(`sample corpus not found: ${samplesDir}`);
  process.exit(1);
}

let files = 0;
let failures = 0;
let compared = 0;
const failureList: string[] = [];
const started = performance.now();
for (const file of walk(samplesDir)) {
  files++;
  const rel = relative(samplesDir, file).replace(/\\/g, "/");
  let project;
  try {
    project = parseProject(new Uint8Array(readFileSync(file)));
  } catch (error) {
    failures++;
    failureList.push(`${rel}: ${(error as Error).message}`);
    continue;
  }
  const jsonPath = file.replace(/\.aep$/i, ".json");
  if (!existsSync(jsonPath) || STALE_EXPORTS.has(rel)) continue;
  let json: Json;
  try {
    json = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch {
    continue;
  }
  if (!Array.isArray(json.items)) continue;
  compared++;
  if ("bitsPerChannel" in json) tallies.items.check("project.bitsPerChannel", project.bitsPerChannel, json.bitsPerChannel, rel);
  if ("expressionEngine" in json) tallies.items.check("project.expressionEngine", project.expressionEngine, json.expressionEngine, rel);
  for (const jItem of json.items as Json[]) {
    const item = project.items.get(jItem.id);
    const where = `${rel} item ${jItem.id} "${jItem.name}"`;
    if (!item) {
      tallies.items.check("item.present", false, true, where);
      continue;
    }
    compareItem(item, jItem, where);
    if (item.kind !== "comp" || !Array.isArray(jItem.layers)) continue;
    currentLayers = item.layers;
    for (const jLayer of jItem.layers as Json[]) {
      layersExpected++;
      const layer = item.layers[jLayer.index - 1];
      if (!layer) {
        layersMissing++;
        continue;
      }
      compareLayer(layer, jLayer, `${where} layer ${jLayer.index}`);
    }
  }
}
const seconds = (performance.now() - started) / 1000;

const pct = (r: number) => `${(r * 100).toFixed(2)}%`;
console.log(`corpus: ${samplesDir}`);
console.log(`files: ${files}, parse failures: ${failures}, compared with JSON: ${compared}, time: ${seconds.toFixed(1)}s`);
for (const line of failureList.slice(0, 20)) console.log(`  FAIL ${line}`);
console.log(`layers found: ${layersExpected - layersMissing}/${layersExpected}`);
for (const [rel, reason] of STALE_EXPORTS) console.log(`skipped stale export ${rel}: ${reason}`);
console.log(`AE-reported leaf properties we do not produce: ${jsonLeavesMissing}/${jsonLeavesTotal}`);
if (verbose) {
  const top = [...missingByMatchName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  for (const [matchName, count] of top) console.log(`  missing ${matchName}: ${count}`);
}
for (const [name, tally] of Object.entries(tallies)) {
  console.log(`${name}: ${pct(tally.rate())} of ${tally.compared} checks (${tally.mismatched} mismatches)`);
  const fields = [...tally.byField.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [field, info] of fields.slice(0, verbose ? 50 : 12)) {
    console.log(`  ${field}: ${info.count}`);
    for (const example of info.examples) console.log(`      ${example}`);
  }
}

let ok = true;
if (flag("--require-parse")) {
  if (failures === 0 && files >= 500) console.log("CORPUS-PARSE-PASSED");
  else {
    console.log(`corpus parse requirement not met (files=${files}, failures=${failures})`);
    ok = false;
  }
}
if (flag("--require-match")) {
  const pass =
    compared > 0 &&
    layersMissing === 0 &&
    tallies.items.rate() >= 0.995 &&
    tallies.layers.rate() >= 0.995 &&
    tallies.values.rate() >= 0.98 &&
    tallies.keyframes.rate() >= 0.98;
  if (pass) console.log("CORPUS-MATCH-PASSED");
  else {
    console.log("corpus match requirement not met");
    ok = false;
  }
}
process.exit(ok ? 0 : 1);
