// Edit round trip over the corpus: applies scripted edits through the Editor
// to every project, then checks that
//   - each edited field reads back the intended value from the edited model,
//   - writing and re-parsing yields a model equal to the edited one,
//   - undoing every edit restores the original bytes and redoing them restores the edit,
// and writes the edited files plus expectations.json for scripts/fixtures/check_edits.py,
// which reads them with py-aep.
//
//   node scripts/edit-roundtrip.ts [--out DIR] [--limit N] [--require]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { parseProject } from "../src/aep/parse.ts";
import type { CompItem, Layer, Project, Property, PropertyNode, PropertyValue } from "../src/aep/model.ts";
import { Editor, isEditableProperty } from "../src/edit/editor.ts";
import { corpusFiles } from "./lib/corpus.ts";
import { SAMPLES } from "./lib/paths.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outDir = resolve(option("--out") ?? join(tmpdir(), "aep-web-edit-roundtrip"));
const limit = Number(option("--limit") ?? Infinity);

/** A field the edit set, as the model should report it; also checked by py-aep. */
interface Expectation {
  file: string;
  comp: string;
  compId: number;
  /** 1-based layer index after all edits, 0 for composition fields. */
  layer: number;
  layerId: number;
  /** Match-name path of a property, empty for layer and composition fields. */
  path: string[];
  field: string;
  value: unknown;
}

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));

function equalValues(a: unknown, b: unknown, eps = 1e-6): boolean {
  if (typeof a === "number" && typeof b === "number") return (Number.isNaN(a) && Number.isNaN(b)) || close(a, b, eps);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equalValues(x, b[i], eps));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (key === "chunk") continue;
      if (!equalValues((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], eps)) return false;
    }
    return true;
  }
  return a === b;
}

/** The first differing path between two models, for failure messages. */
function firstDifference(a: unknown, b: unknown, path = ""): string | undefined {
  if (equalValues(a, b)) return undefined;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (key === "chunk") continue;
      const d = firstDifference((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`);
      if (d) return d;
    }
  }
  return `${path}: ${JSON.stringify(a)?.slice(0, 120)} vs ${JSON.stringify(b)?.slice(0, 120)}`;
}

/** Leaves with match-name paths; a repeated sibling match name gets a `#n` suffix (n ≥ 2). */
function* leaves(nodes: PropertyNode[], path: string[] = []): Generator<[Property, string[]]> {
  const seen = new Map<string, number>();
  for (const node of nodes) {
    const n = (seen.get(node.matchName) ?? 0) + 1;
    seen.set(node.matchName, n);
    const here = [...path, n > 1 ? `${node.matchName}#${n}` : node.matchName];
    if (node.kind === "group") yield* leaves(node.children, here);
    else yield [node, here];
  }
}

function findByPath(nodes: PropertyNode[], path: string[]): Property | undefined {
  for (const [prop, p] of leaves(nodes)) if (p.join("/") === path.join("/")) return prop;
  return undefined;
}

const comps = (project: Project) => [...project.items.values()].filter((i): i is CompItem => i.kind === "comp");

function nudged(prop: Property, value: PropertyValue): PropertyValue {
  if (typeof value === "number") {
    if (prop.matchName === "ADBE Opacity") return (value + 37) % 100;
    if (prop.controlType === 4) return value ? 0 : 1;
    if (prop.controlType === 7) return value > 1 ? value - 1 : value + 1;
    return Math.round((value * 0.5 + 3.25) * 1000) / 1000;
  }
  if (Array.isArray(value)) {
    if (prop.propertyValueType === 6418) return value.map((c, i) => (i === 3 ? c : Math.round((1 - c) * 255) / 255));
    // A 2D layer's Scale Z is dead and always reads 100.
    if (prop.matchName === "ADBE Scale") return value.map((c, i) => (i === 2 ? c : c + 5.5));
    // Variable font axes store the axis tag after the value.
    if (prop.matchName.startsWith("ADBE Text VF Axis")) return value.map((c, i) => (i === 0 ? c + 5.5 : c));
    return value.map((c) => c + 5.5);
  }
  return value;
}

const ASSISTS = ["easyEase", "hold", "linear", "easyEaseIn", "toggleHold"] as const;
/** Rotates switches, blending modes and interpolations across layers and files. */
let turn = 0;

interface FileResult {
  edits: number;
  skipped: number;
  failures: string[];
  expectations: Expectation[];
}

function editFile(file: string, original: Uint8Array): { result: FileResult; written?: Uint8Array } {
  const editor = Editor.fromBytes(original);
  const result: FileResult = { edits: 0, skipped: 0, failures: [], expectations: [] };
  const name = relative(SAMPLES, file).startsWith("..") ? relative(resolve("refs"), file) : relative(SAMPLES, file);
  const recorded: (() => Expectation)[] = [];
  const attempt = (label: string, fn: () => ((verify: boolean) => Expectation) | void) => {
    try {
      const check = fn();
      result.edits++;
      if (!check) return;
      check(true);
      recorded.push(() => check(false));
    } catch (error) {
      const message = (error as Error).message;
      if (/cannot be edited|cannot be animated|cannot write|separated dimensions|no stored value|cannot be parented|not available on camera and light layers/.test(message)) result.skipped++;
      else result.failures.push(`${name}: ${label}: ${message}`);
    }
  };

  const project = editor.project;
  for (const comp of comps(project).slice(0, 3)) {
    const fd = comp.frameDuration || 1 / 24;
    const layerAt = (id: number) => comp.layers.find((l) => l.id === id)!;
    const ids = comp.layers.slice(0, 4).map((l) => l.id);
    const expect = (layerId: number, path: string[], field: string, read: (layer: Layer) => unknown, value: unknown) => (verify: boolean) => {
      const layer = layerAt(layerId);
      const actual = read(layer);
      if (verify && !equalValues(actual, value, 1e-5)) throw new Error(`${field} is ${JSON.stringify(actual)}, expected ${JSON.stringify(value)}`);
      return { file: name, comp: comp.name, compId: comp.id, layer: layer.index, layerId, path, field, value: actual } satisfies Expectation;
    };

    for (const [n, id] of ids.entries()) {
      // Properties.
      const props = [...leaves(layerAt(id).properties)].filter(([p]) => isEditableProperty(p)).slice(0, 8);
      for (const [k, [, path]] of props.entries()) {
        const prop = () => findByPath(layerAt(id).properties, path)!;
        const p = prop();
        if (!p.keyframes.length) {
          if (k % 3 === 2 && p.canVaryOverTime) {
            attempt(`animate ${path.join("/")}`, () => {
              editor.addKeyframe(comp, layerAt(id), prop(), 2 * fd);
              const second = nudged(p, p.value);
              editor.setValue(comp, layerAt(id), prop(), second, 6 * fd);
              const byTime = (l: Layer) => findByPath(l.properties, path)!.keyframes.slice().sort((a, b) => a.time - b.time);
              return expect(id, path, "keyframes", (l) => byTime(l).map((kf) => [kf.time, kf.value]), [[2 * fd, p.value], [6 * fd, second]]);
            });
          } else {
            attempt(`value ${path.join("/")}`, () => {
              const value = nudged(p, p.value);
              editor.setValue(comp, layerAt(id), prop(), value, 0);
              return expect(id, path, "value", (l) => findByPath(l.properties, path)!.value, value);
            });
          }
          continue;
        }
        const times = p.keyframes.map((kf) => kf.time);
        attempt(`key value ${path.join("/")}`, () => {
          const value = nudged(p, p.keyframes[0].value);
          editor.setKeyframeValue(comp, layerAt(id), prop(), 0, value);
          return expect(id, path, "key0", (l) => findByPath(l.properties, path)!.keyframes[0].value, value);
        });
        if (times.length >= 2 && times[1] - times[0] > 2 * fd) {
          attempt(`add key ${path.join("/")}`, () => {
            const t = Math.round((times[0] + times[1]) / 2 / fd) * fd;
            if (t <= times[0] || t >= times[1]) return;
            editor.addKeyframe(comp, layerAt(id), prop(), t);
            return expect(id, path, "keyCount", (l) => findByPath(l.properties, path)!.keyframes.length, times.length + 1);
          });
        }
        if (times.length >= 3) {
          attempt(`delete key ${path.join("/")}`, () => {
            const count = prop().keyframes.length;
            editor.removeKeyframes(comp, layerAt(id), prop(), [1]);
            return expect(id, path, "keyCount", (l) => findByPath(l.properties, path)!.keyframes.length, count - 1);
          });
        }
        const assist = ASSISTS[turn++ % ASSISTS.length];
        attempt(`interpolation ${assist} ${path.join("/")}`, () => {
          const { inInterpolationType: was, outInterpolationType: wasOut } = prop().keyframes[0];
          const wanted = {
            easyEase: [6613, 6613],
            hold: [6614, 6614],
            linear: [6612, 6612],
            easyEaseIn: [6613, wasOut],
            toggleHold: [was, wasOut === 6614 ? 6612 : 6614],
          }[assist];
          editor.setKeyframeInterpolation(comp, layerAt(id), [{ prop: prop(), indices: [0] }], assist);
          return expect(id, path, "key0Interpolation", (l) => {
            const kf = findByPath(l.properties, path)!.keyframes[0];
            return [kf.inInterpolationType, kf.outInterpolationType];
          }, wanted);
        });
        attempt(`move key ${path.join("/")}`, () => {
          const keys = prop().keyframes;
          const last = keys.length - 1;
          const was = keys[last].time;
          editor.moveKeyframes(comp, layerAt(id), [{ prop: prop(), indices: [last] }], fd);
          return expect(id, path, "lastKeyTime", (l) => findByPath(l.properties, path)!.keyframes.at(-1)!.time, was + fd);
        });
        if (k === 0 && n === 0) {
          attempt(`stopwatch off ${path.join("/")}`, () => {
            editor.toggleStopwatch(comp, layerAt(id), prop(), comp.duration / 2);
            return expect(id, path, "keyCount", (l) => findByPath(l.properties, path)!.keyframes.length, 0);
          });
        }
      }
      const opacity = findByPath(layerAt(id).properties, ["ADBE Transform Group", "ADBE Opacity"]);
      if (opacity && isEditableProperty(opacity)) {
        attempt("expression", () => {
          const text = n % 2 ? "" : `value * 0.5 // edited ${n}`;
          editor.setExpression(comp, layerAt(id), opacity, text);
          return expect(id, ["ADBE Transform Group", "ADBE Opacity"], "expression", (l) => findByPath(l.properties, ["ADBE Transform Group", "ADBE Opacity"])!.expression, text);
        });
        if (n % 4 === 2) {
          attempt("expression off", () => {
            const path = ["ADBE Transform Group", "ADBE Opacity"];
            editor.setExpressionEnabled(comp, layerAt(id), findByPath(layerAt(id).properties, path)!, false);
            return expect(id, path, "expressionEnabled", (l) => findByPath(l.properties, path)!.expressionEnabled, false);
          });
        }
      }

      // Layer fields.
      attempt("rename", () => {
        const text = `Edited ${n} \u00e9\u4e2d`;
        editor.renameLayer(comp, layerAt(id), text);
        return expect(id, [], "name", (l) => l.name, text);
      });
      const switches = ["solo", "shy", "locked", "motionBlur", "enabled", "adjustmentLayer", "threeDLayer", "collapseTransformation"] as const;
      const sw = switches[turn % switches.length];
      attempt(`switch ${sw}`, () => {
        const on = !layerAt(id)[sw];
        editor.setLayerSwitch(comp, layerAt(id), sw, on);
        return expect(id, [], sw, (l) => l[sw], on);
      });
      const modes = [5216, 5220, 5228, 5214, 5212];
      attempt("blend", () => {
        const mode = modes[turn++ % modes.length];
        editor.setBlendingMode(comp, layerAt(id), mode);
        return expect(id, [], "blendingMode", (l) => l.blendingMode, mode);
      });
      attempt("timing", () => {
        const before = layerAt(id);
        editor.shiftLayers(comp, [before], 2 * fd);
        return expect(id, [], "startTime", (l) => l.startTime, before.startTime + 2 * fd);
      });
      attempt("trim", () => {
        const layer = layerAt(id);
        const out = layer.outPoint - fd;
        if (out <= layer.inPoint) return;
        editor.setLayerTiming(comp, layer, { outPoint: out });
        return expect(id, [], "outPoint", (l) => l.outPoint, out);
      });
      attempt("trim in", () => {
        const layer = layerAt(id);
        const start = layer.inPoint + fd;
        if (start >= layer.outPoint) return;
        editor.setLayerTiming(comp, layer, { inPoint: start });
        return expect(id, [], "inPoint", (l) => l.inPoint, start);
      });
    }
    if (ids.length >= 2) {
      attempt("parent", () => {
        editor.setParent(comp, layerAt(ids[1]), ids[0]);
        return expect(ids[1], [], "parentId", (l) => l.parentId, ids[0]);
      });
      attempt("track matte", () => {
        const layer = layerAt(ids[1]);
        editor.setTrackMatte(comp, layer, 5013, ids[0]);
        return expect(ids[1], [], "trackMatteType", (l) => l.trackMatteType, 5013);
      });
      attempt("reorder", () => {
        const last = comp.layers.at(-1)!;
        editor.moveLayer(comp, last, 1);
        return expect(last.id, [], "index", (l) => l.index, 1);
      });
    }
    attempt("comp settings", () => {
      const before = { width: comp.width, height: comp.height, duration: comp.duration, frameRate: comp.frameRate };
      const frameRate = before.frameRate === 30 ? 25 : 30;
      const keyTimes = comp.layers.map((l) => [...leaves(l.properties)].map(([p]) => p.keyframes.map((k) => k.time)));
      editor.setCompSettings(comp, {
        width: before.width + 16,
        height: before.height + 8,
        frameRate,
        duration: Math.round(before.duration * 1.5 * frameRate) / frameRate,
        bgColor: [0.25, 0.5, 0.75],
      });
      const after = comp.layers.map((l) => [...leaves(l.properties)].map(([p]) => p.keyframes.map((k) => k.time)));
      if (!equalValues(after, keyTimes, 1e-4)) throw new Error(`keyframes moved on retime: ${firstDifference(after, keyTimes)}`);
      return (verify: boolean) => {
        const value = [comp.width, comp.height, comp.frameRate, comp.duration, comp.bgColor];
        const wanted = [before.width + 16, before.height + 8, frameRate, Math.round(before.duration * 1.5 * frameRate) / frameRate, [64 / 255, 128 / 255, 191 / 255]];
        if (verify && !equalValues(value, wanted, 1e-5)) throw new Error(`comp settings are ${JSON.stringify(value)}, expected ${JSON.stringify(wanted)}`);
        return { file: name, comp: comp.name, compId: comp.id, layer: 0, layerId: 0, path: [], field: "settings", value };
      };
    });
  }

  for (const record of recorded) {
    try {
      result.expectations.push(record());
    } catch {
      // A later edit removed the field (for example the stopwatch was turned off).
    }
  }
  if (!editor.dirty) return { result };

  const written = editor.save();
  let reparsed: Project;
  try {
    reparsed = parseProject(written);
  } catch (error) {
    result.failures.push(`${name}: re-parse failed: ${(error as Error).message}`);
    return { result };
  }
  const editedComps = comps(editor.project);
  const reparsedComps = comps(reparsed);
  for (const [i, comp] of editedComps.entries()) {
    const d = firstDifference(comp, reparsedComps[i], comp.name);
    if (d) {
      result.failures.push(`${name}: re-parsed model differs at ${d}`);
      break;
    }
  }
  while (editor.undoLabel) editor.undo();
  const restored = editor.save();
  if (!sameBytes(restored, original)) result.failures.push(`${name}: undoing every edit did not restore the original bytes`);
  while (editor.redoLabel) editor.redo();
  if (!sameBytes(editor.save(), written)) result.failures.push(`${name}: redoing every edit did not restore the edited bytes`);
  return { result, written };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const files = corpusFiles().slice(0, limit);
const expectations: Expectation[] = [];
const failures: string[] = [];
const outputs: string[] = [];
let edits = 0;
let skipped = 0;
let editedFiles = 0;
const started = performance.now();
for (const [i, file] of files.entries()) {
  const original = new Uint8Array(readFileSync(file));
  try {
    parseProject(original);
  } catch {
    continue;
  }
  const { result, written } = editFile(file, original);
  edits += result.edits;
  skipped += result.skipped;
  failures.push(...result.failures);
  if (!written) continue;
  editedFiles++;
  const out = join(outDir, `${String(i).padStart(4, "0")}_${basename(file)}`);
  writeFileSync(out, written);
  outputs.push(out);
  for (const e of result.expectations) expectations.push({ ...e, file: out });
}
writeFileSync(join(outDir, "expectations.json"), JSON.stringify(expectations, null, 1));
const seconds = (performance.now() - started) / 1000;
console.log(
  `files: ${files.length}, edited: ${editedFiles}, edits: ${edits} (${skipped} not applicable), checked fields: ${expectations.length}, failures: ${failures.length}, time: ${seconds.toFixed(1)}s`,
);
for (const f of failures.slice(0, 40)) console.log(`  FAIL ${f}`);
if (args.includes("--require")) {
  if (editedFiles >= 400 && expectations.length >= 5000 && !failures.length) console.log("EDIT-ROUNDTRIP-PASSED");
  else {
    console.log("edit round-trip requirement not met");
    process.exit(1);
  }
}
