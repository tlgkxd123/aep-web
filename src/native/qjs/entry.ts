// The expression side of the native core (native/core/expressions.cpp): this module is bundled with the app's own
// parser, evaluator and expression engine (scripts/native/build-expressions.ts) and runs inside QuickJS, so
// expressions behave in the native app exactly as they do in the web app. The C++ planner calls into it only for
// properties that have an expression; everything else is evaluated in C++.
//
// The host API, on globalThis.aep:
//   load(bytes)                         parses the project once, from the same bytes the C++ core parsed
//   property(compId, layerIndex, path)  the property a C++ property stands for; path is [matchName, occurrence] pairs
//   layer(compId, layerIndex)           the layer a C++ layer stands for
//   beginFrame()                        a new frame: drops cached expression results, as setExpressionScope does
//   evaluate(prop, time, layer, pre)    the post-expression value, or pre with the frame's warning on failure
//   warnings()                          the warnings since beginFrame, then clears them
import type { CompItem, Layer, Project, Property, PropertyNode, PropertyValue } from "../../aep/model.ts";
import { parseProject } from "../../aep/parse.ts";
import { currentValue, setExpressionScope } from "../../aep/evaluate.ts";
import { expressionEngine } from "../../expressions/install.ts";

let project: Project | undefined;
let warnings: string[] = [];
const comps = new Map<number, CompItem>();

function load(bytes: Uint8Array): number {
  project = parseProject(bytes);
  comps.clear();
  for (const item of project.items.values()) if (item.kind === "comp") comps.set(item.id, item);
  return project.items.size;
}

function layer(compId: number, layerIndex: number): Layer | undefined {
  return comps.get(compId)?.layers[layerIndex - 1];
}

function property(compId: number, layerIndex: number, path: [string, number][]): Property | undefined {
  let nodes: PropertyNode[] | undefined = layer(compId, layerIndex)?.properties;
  let found: PropertyNode | undefined;
  for (const [matchName, occurrence] of path) {
    if (!nodes) return undefined;
    found = nodes.filter((n) => n.matchName === matchName)[occurrence];
    if (!found) return undefined;
    nodes = found.kind === "group" ? found.children : undefined;
  }
  return found?.kind === "property" ? found : undefined;
}

function beginFrame(): void {
  if (!project) return;
  warnings = [];
  const seen = new Set<string>();
  setExpressionScope({
    project,
    warn: (message) => {
      if (!seen.has(message)) warnings.push(message);
      seen.add(message);
    },
  });
}

function evaluate(prop: Property, time: number, owner: Layer, pre: PropertyValue): PropertyValue {
  return expressionEngine.evaluate(prop, time, owner, pre);
}

/** The value of `prop` after its expression, evaluated as the TypeScript planner does (for checks). */
function value(prop: Property, time: number, owner: Layer): PropertyValue {
  return currentValue(prop, time, owner);
}

function takeWarnings(): string[] {
  const out = warnings;
  warnings = [];
  return out;
}

(globalThis as Record<string, unknown>).aep = Object.freeze({ load, layer, property, beginFrame, evaluate, value, warnings: takeWarnings });
