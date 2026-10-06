// Compares the expression engine's post-expression values with After Effects':
//
//  1. corpus: every enabled expression in the py-aep ExtendScript exports
//     (samples/**/*.json next to their .aep), whose `value` is the evaluated
//     expression at the comp's current time;
//  2. probes: refs/fixtures/*.probes.json cells. Each cell is a shape whose
//     Fill Color expression encodes a number in 24 bits; the number decoded
//     from AE's reference frame must match the one decoded from our engine's
//     evaluation of the same expression.
//
// Samples that depend on AE's random generators (wiggle, random, noise...) are
// reported separately as a known gap and never counted as passing.
//
//   node scripts/expr-report.ts [--require] [--verbose]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { currentValue, setExpressionScope } from "../src/aep/evaluate.ts";
import type { CompItem, Layer, Project, Property, PropertyNode, PropertyValue } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import "../src/expressions/install.ts";
import { SAMPLES } from "./lib/paths.ts";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

type Json = Record<string, any>;

const args = process.argv.slice(2);
const verbose = args.includes("--verbose");
const TOLERANCE = 1e-3;
const RANDOM = /\b(wiggle|temporalWiggle|random|gaussRandom|noise|seedRandom)\s*\(/;

interface Sample {
  source: string;
  label: string;
  expression: string;
  ours: number[] | null;
  ae: number[] | null;
  warnings: string[];
  aeError?: string;
  tolerance: number;
}

const flatten = (v: PropertyValue | Json | null | undefined): number[] | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return [v];
  if (Array.isArray(v)) return (v as unknown[]).flat(2) as number[];
  return null;
};

function evaluateAt(project: Project, layer: Layer, prop: Property, siblings: PropertyNode[], time: number): { value: PropertyValue; warnings: string[] } {
  const warnings: string[] = [];
  setExpressionScope({ project, warn: (m) => warnings.push(m) });
  const value = currentValue(prop, time, layer, siblings);
  setExpressionScope(undefined);
  return { value, warnings };
}

// --- 1. corpus ---------------------------------------------------------------------

function walkJson(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walkJson(path, out);
    else if (name.endsWith(".json") && existsSync(path.replace(/\.json$/, ".aep"))) out.push(path);
  }
  return out;
}

function corpusSamples(): Sample[] {
  const samples: Sample[] = [];
  for (const file of walkJson(resolve(SAMPLES))) {
    const text = readFileSync(file, "utf8");
    if (!/"expressionEnabled": true/.test(text)) continue;
    const json = JSON.parse(text) as Json;
    let project: Project | undefined;
    for (const jComp of json.items ?? []) {
      if (!Array.isArray(jComp.layers)) continue;
      for (const jLayer of jComp.layers) {
        const visit = (jNodes: Json[], nodes: PropertyNode[], path: string[]) => {
          const seen = new Map<string, number>();
          for (const jNode of jNodes) {
            const occurrence = seen.get(jNode.matchName) ?? 0;
            seen.set(jNode.matchName, occurrence + 1);
            const node = nodes.filter((n) => n.matchName === jNode.matchName)[occurrence];
            if (!node) continue;
            const here = [...path, jNode.name];
            if (Array.isArray(jNode.properties) && node.kind === "group") visit(jNode.properties, node.children, here);
            if (!jNode.expressionEnabled || !jNode.expression || node.kind !== "property") continue;
            const layer = (project!.items.get(jComp.id) as CompItem).layers[jLayer.index - 1];
            const { value, warnings } = evaluateAt(project!, layer, node, nodes, jComp.time);
            samples.push({
              source: file.slice(resolve(SAMPLES).length + 1).replace(/\\/g, "/"),
              label: `${jComp.name} > ${jLayer.name} > ${here.join(" > ")} @ t=${jComp.time}`,
              expression: jNode.expression,
              ours: flatten(value),
              ae: flatten(jNode.value),
              warnings,
              aeError: jNode.expressionError || undefined,
              tolerance: TOLERANCE,
            });
          }
        };
        project ??= parseProject(new Uint8Array(readFileSync(file.replace(/\.json$/, ".aep"))));
        const comp = project.items.get(jComp.id);
        if (comp?.kind !== "comp") continue;
        const layer = comp.layers[jLayer.index - 1];
        if (layer) visit(jLayer.properties ?? [], layer.properties, []);
      }
    }
  }
  return samples;
}

// --- 2. probes ---------------------------------------------------------------------

/** refs/fixtures/<name>.probes.json: which cells of which comp encode which expression. */
interface ProbeManifest {
  project: string;
  /** Pixel scale of the encoding: value = (code - offset) / scale. */
  scale: number;
  offset: number;
  comps: {
    comp: string;
    frames: number[];
    /** Comps whose values come from AE's random generators: measured, never passing. */
    random?: boolean;
    cells: { layer: string; label: string; x: number; y: number; tolerance?: number }[];
  }[];
}

const decode = (rgb: number[], m: ProbeManifest) => ((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]) / m.scale - m.offset / m.scale;

function findProbe(layer: Layer): { prop: Property; siblings: PropertyNode[] } | undefined {
  let found: { prop: Property; siblings: PropertyNode[] } | undefined;
  const walk = (nodes: PropertyNode[]) => {
    for (const n of nodes) {
      if (found) return;
      if (n.kind === "group") walk(n.children);
      else if (n.matchName === "ADBE Vector Fill Color" && n.expression) found = { prop: n, siblings: nodes };
    }
  };
  walk(layer.properties);
  return found;
}

function probeSamples(): { exact: Sample[]; random: Sample[] } {
  const exact: Sample[] = [];
  const random: Sample[] = [];
  const dir = join(ROOT, "fixtures");
  if (!existsSync(dir)) return { exact, random };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".probes.json"))) {
    const manifest = JSON.parse(readFileSync(join(dir, file), "utf8")) as ProbeManifest;
    const project = parseProject(new Uint8Array(readFileSync(join(dir, manifest.project))));
    for (const probe of manifest.comps) {
      const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === probe.comp);
      for (const frame of probe.frames) {
        const refFile = framePath(probe.comp, frame);
        const ref = existsSync(refFile) ? readTiff(readFileSync(refFile)) : undefined;
        for (const cell of probe.cells) {
          const layer = comp?.layers.find((l) => l.name === cell.layer);
          const target = layer && findProbe(layer);
          const sample: Sample = {
            source: `${file} ${probe.comp}@${frame}`,
            label: cell.label,
            expression: target?.prop.expression ?? "(probe layer missing)",
            ours: null,
            ae: null,
            warnings: [],
            tolerance: cell.tolerance ?? 2 / manifest.scale,
          };
          if (comp && layer && target) {
            const { value, warnings } = evaluateAt(project, layer, target.prop, target.siblings, frame * comp.frameDuration);
            sample.warnings = warnings;
            if (Array.isArray(value)) sample.ours = [decode(value.slice(0, 3).map((c) => Math.round(c * 255 - 0.5)), manifest)];
          }
          if (ref) {
            const i = (cell.y * ref.width + cell.x) * 4;
            sample.ae = [decode([ref.data[i], ref.data[i + 1], ref.data[i + 2]], manifest)];
          }
          (probe.random ? random : exact).push(sample);
        }
      }
    }
  }
  return { exact, random };
}

// --- report -------------------------------------------------------------------------

const matches = (s: Sample) =>
  !!s.ours && !!s.ae && s.ours.length === s.ae.length && s.ours.every((v, i) => Math.abs(v - s.ae![i]) <= s.tolerance) && !s.warnings.length;

const corpus = corpusSamples();
const probes = probeSamples();
const deterministic = [...corpus.filter((s) => !RANDOM.test(s.expression)), ...probes.exact];
const randomGap = [...corpus.filter((s) => RANDOM.test(s.expression)), ...probes.random];

const show = (s: Sample, status: string) => {
  const fmt = (v: number[] | null) => (v ? JSON.stringify(v.map((x) => +x.toFixed(5))) : "-");
  console.log(`  ${status} ${s.source}: ${s.label}`);
  console.log(`       ${JSON.stringify(s.expression)}  ae=${fmt(s.ae)} ours=${fmt(s.ours)}${s.warnings.length ? `  [${s.warnings.join("; ")}]` : ""}`);
};

const passing = deterministic.filter(matches);
console.log(`deterministic expression samples: ${deterministic.length} (corpus ${deterministic.length - probes.exact.length}, probes ${probes.exact.length}), matching After Effects within tolerance: ${passing.length}`);
for (const s of deterministic) if (verbose || !matches(s)) show(s, matches(s) ? "ok  " : "DIFF");
const randomMatching = randomGap.filter(matches).length;
console.log(`known gap - AE's random generators (not counted): ${randomGap.length} samples, ${randomMatching} equal by value`);
for (const s of randomGap) if (verbose) show(s, matches(s) ? "same" : "gap ");

if (args.includes("--require")) {
  if (!deterministic.length || passing.length !== deterministic.length) {
    console.error(`${deterministic.length - passing.length} deterministic samples differ from After Effects`);
    process.exit(1);
  }
  console.log("EXPRESSIONS-MATCH-AE");
}
