// Checks the Effects & Presets library (src/edit/data/effect-library.json):
//   - it is what scripts/export-effect-library.ts produces now from the registered
//     renderers and the donor projects, and every registered effect is either in it
//     or listed with the reason it is not;
//   - every template, applied through the editor (the UI's code path) to two layers of
//     a new project, saves and re-parses as that effect, switched on, under its display
//     name, with every parameter its definition lists; undo removes them and redo
//     restores them.
// Prints EFFECT-LIBRARY-CURRENT when all of that holds.
//
//   node scripts/check-effect-library.ts
import { readFileSync } from "node:fs";
import type { CompItem, Layer, PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { findList } from "../src/aep/riff.ts";
import { applyLibraryEffect, effectLibrary } from "../src/edit/effectLibrary.ts";
import { addLayer } from "../src/edit/layers.ts";
import { DEFAULT_COMP_SETTINGS, newComposition, newProject } from "../src/edit/project.ts";
import { registeredEffects } from "../src/render/registry.ts";
import { buildLibrary, LIBRARY, libraryJson, report } from "./export-effect-library.ts";

const failures: string[] = [];
const fail = (message: string) => failures.push(message);

const build = buildLibrary();
for (const line of report(build)) console.log(line);
if (libraryJson(build.library) !== readFileSync(LIBRARY, "utf8")) fail(`${LIBRARY} is stale: run node scripts/export-effect-library.ts`);
for (const matchName of registeredEffects()) {
  if (!(matchName in build.library.effects) && !build.excluded.has(matchName)) fail(`${matchName} has a renderer but neither a template nor a reason`);
}

const library = await effectLibrary();
const names = library.map((e) => e.matchName);
if (names.join() !== Object.keys(build.library.effects).join()) fail("the loader does not list the exported effects in order");

const leaves = (group: PropertyGroup): number => group.children.reduce((n, c) => n + (c.kind === "group" ? leaves(c) : 1), 0);
const effectsOf = (layer: Layer): PropertyGroup[] => {
  const parade = layer.properties.find((p): p is PropertyGroup => p.kind === "group" && p.matchName === "ADBE Effect Parade");
  return parade ? parade.children.filter((c): c is PropertyGroup => c.kind === "group") : [];
};

const editor = newProject();
const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: "library", width: 160, height: 120 });
const a = addLayer(editor, comp, { kind: "solid", color: [1, 0.5, 0], width: 80, height: 60 });
const b = addLayer(editor, comp, { kind: "solid", color: [0.1, 0.7, 0.65], width: 60, height: 80 });
for (const effect of library) {
  try {
    applyLibraryEffect(editor, comp, [a, b], effect);
  } catch (e) {
    fail(`${effect.matchName}: applying it failed: ${(e as Error).message}`);
  }
}
const steps = editor.undoLabel;

const reopened = parseProject(editor.save());
const reComp = reopened.items.get(comp.id) as CompItem | undefined;
for (const id of [a, b]) {
  const layer = reComp?.layers.find((l) => l.id === id);
  if (!layer) {
    fail(`layer ${id} is missing after saving`);
    continue;
  }
  const applied = effectsOf(layer);
  if (applied.map((e) => e.matchName).join() !== names.join()) fail(`layer ${id} re-parses with effects ${applied.map((e) => e.matchName).join(", ")}`);
  for (const [i, effect] of library.entries()) {
    const fx = applied[i];
    if (!fx || fx.matchName !== effect.matchName) continue;
    const defined = (findList(findList(effect.template.definition, "sspc"), "parT")?.children ?? []).filter((c) => c.type === "pard").length;
    const params = leaves(fx);
    if (!fx.enabled) fail(`${effect.matchName} is switched off on layer ${id}`);
    if ((fx.effectName ?? fx.name) !== effect.name) fail(`${effect.matchName} re-parses named ${fx.effectName ?? fx.name}, not ${effect.name}`);
    if (!defined || params !== defined) fail(`${effect.matchName} re-parses with ${params} parameters; its definition lists ${defined}`);
  }
}
if (reopened.warnings.length) fail(`the saved project re-parses with warnings: ${reopened.warnings.slice(0, 3).join("; ")}`);

// One undo step per effect: undoing them all leaves the layers without effects.
for (let i = 0; i < library.length; i++) editor.undo();
const bare = editor.project.items.get(comp.id) as CompItem;
if (bare.layers.some((l) => effectsOf(l).length)) fail("undoing every application leaves effects behind");
for (let i = 0; i < library.length; i++) editor.redo();
if (editor.undoLabel !== steps) fail(`redo ends at "${editor.undoLabel}", not "${steps}"`);
const redone = editor.project.items.get(comp.id) as CompItem;
if (redone.layers.some((l) => effectsOf(l).length !== library.length)) fail("redo does not restore every effect");

for (const f of failures) console.log(`FAIL ${f}`);
if (failures.length) process.exit(1);
console.log(`EFFECT-LIBRARY-CURRENT: ${library.length} effects with templates`);
