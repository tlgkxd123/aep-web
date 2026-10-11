// Effects from the library read back under their type's name with every parameter under its definition's name, as
// After Effects writes them, whichever effect or project a template's streams were copied from; expressions find
// them by those names.
import { afterEach, expect, it } from "vitest";
import { decodePard } from "../src/aep/decode.ts";
import { currentValue, setExpressionScope } from "../src/aep/evaluate.ts";
import type { CompItem, Layer, Property, PropertyGroup } from "../src/aep/model.ts";
import { findList } from "../src/aep/riff.ts";
import { Editor } from "../src/edit/editor.ts";
import { effectLibrary } from "../src/edit/effectLibrary.ts";
import { addEffects, newInstance, setInstanceName, setInstanceNumber } from "../src/edit/effects.ts";
import { addLayer } from "../src/edit/layers.ts";
import { tdmnName } from "../src/edit/layer-templates.ts";
import { DEFAULT_COMP_SETTINGS, newComposition, newProject } from "../src/edit/project.ts";
import "../src/expressions/install.ts";

afterEach(() => setExpressionScope(undefined));

const effectsOf = (layer: Layer) =>
  (layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade")?.children ?? []).filter(
    (n): n is PropertyGroup => n.kind === "group",
  );

it("names every library effect after its type and its parameters after their definitions", async () => {
  const library = await effectLibrary();
  const editor = newProject();
  const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: "Names", width: 320, height: 180 });
  const id = addLayer(editor, comp, { kind: "solid", name: "Plate", color: [1, 1, 1], width: 320, height: 180 });
  addEffects(editor, comp, id, library.map((e) => ({ template: e.template, instance: newInstance(e.template) })));

  const reopened = [...Editor.fromBytes(editor.save()).project.items.values()].find((i): i is CompItem => i.kind === "comp")!;
  const effects = effectsOf(reopened.layers[0]);
  expect(effects.map((e) => e.matchName)).toEqual(library.map((e) => e.matchName));
  const wrong: string[] = [];
  effects.forEach((effect, i) => {
    if (effect.name !== library[i].name) wrong.push(`${effect.matchName}: ${effect.name}`);
    const defined = new Map<string, string>();
    let current = "";
    for (const c of findList(library[i].template.instance, "parT")?.children ?? []) {
      if (c.type === "tdmn") current = tdmnName(c);
      else if (c.type === "pard") defined.set(current, decodePard(c).name);
    }
    const visit = (group: PropertyGroup) => {
      for (const p of group.children) {
        if (p.kind === "group") visit(p);
        else if (defined.get(p.matchName)?.trim() && p.name !== defined.get(p.matchName)) wrong.push(`${p.matchName}: ${p.name}`);
      }
    };
    visit(effect);
  });
  expect(wrong).toEqual([]);
});

it("finds a renamed Slider Control's value by its parameter's name", async () => {
  const slider = (await effectLibrary()).find((e) => e.matchName === "ADBE Slider Control")!;
  const editor = newProject();
  const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: "Rig", width: 320, height: 180 });
  const id = addLayer(editor, comp, { kind: "null" });
  const named = (name: string, value: number) => {
    const instance = newInstance(slider.template);
    setInstanceName(instance, name);
    setInstanceNumber(instance, "ADBE Slider Control", 1, value);
    return { template: slider.template, instance };
  };
  addEffects(editor, comp, id, [named("Bass", 42), named("Twice", 0)]);
  const sliderOf = (layer: Layer, name: string) =>
    effectsOf(layer).find((e) => e.name === name)!.children.find((c): c is Property => c.kind === "property")!;
  editor.setExpression(comp, comp.layers[0], sliderOf(comp.layers[0], "Twice"), 'effect("Bass")("Slider") * 2');

  const project = Editor.fromBytes(editor.save()).project;
  const controls = [...project.items.values()].find((i): i is CompItem => i.kind === "comp")!.layers[0];
  setExpressionScope({ project, warn: (message) => expect.fail(message) });
  expect(sliderOf(controls, "Bass").name).toBe("Slider");
  expect(currentValue(sliderOf(controls, "Twice"), 0, controls)).toBe(84);
});
