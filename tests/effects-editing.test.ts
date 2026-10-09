// Switching effects off and deleting them: written into the file, read back the same, and undoable.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompItem, Layer, PropertyGroup } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";

const effectsOf = (layer: Layer): PropertyGroup[] => {
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
  return parade?.children.filter((n): n is PropertyGroup => n.kind === "group" && !!n.isEffect) ?? [];
};

/** A fixture layer with at least two effects. */
function setup(): { editor: Editor; comp: CompItem; layer: Layer } {
  for (const name of ["fxmisc.aep", "fxextra.aep"]) {
    const editor = Editor.fromBytes(new Uint8Array(readFileSync(join("refs", "fixtures", name))));
    for (const comp of editor.project.items.values()) {
      if (comp.kind !== "comp") continue;
      const layer = comp.layers.find((l) => effectsOf(l).length >= 2);
      if (layer) return { editor, comp, layer };
    }
  }
  throw new Error("no fixture layer has two effects");
}

const layerIn = (editor: Editor, compId: number, layerId: number) => {
  const comp = editor.project.items.get(compId) as CompItem;
  return { comp, layer: comp.layers.find((l) => l.id === layerId)! };
};

describe("effects", () => {
  it("switches an effect off and on again, surviving save and reopen, and undoes", () => {
    const { editor, comp, layer } = setup();
    const names = effectsOf(layer).map((e) => e.name);
    editor.setEffectEnabled(comp, layer, effectsOf(layer)[1], false);
    const reopened = Editor.fromBytes(editor.save());
    const off = layerIn(reopened, comp.id, layer.id).layer;
    expect(effectsOf(off).map((e) => e.enabled)).toEqual(names.map((_, i) => i !== 1));
    editor.undo();
    expect(effectsOf(layerIn(editor, comp.id, layer.id).layer).every((e) => e.enabled)).toBe(true);
    editor.redo();
    const current = layerIn(editor, comp.id, layer.id);
    editor.setEffectEnabled(current.comp, current.layer, effectsOf(current.layer)[1], true);
    expect(effectsOf(layerIn(Editor.fromBytes(editor.save()), comp.id, layer.id).layer).every((e) => e.enabled)).toBe(true);
  });

  it("deletes an effect, keeping the others with their values, surviving save and reopen, and undoes", () => {
    const { editor, comp, layer } = setup();
    const before = effectsOf(layer).map((e) => e.matchName);
    const original = editor.save();
    editor.removeEffect(comp, layer, effectsOf(layer)[0]);
    expect(effectsOf(layerIn(editor, comp.id, layer.id).layer).map((e) => e.matchName)).toEqual(before.slice(1));
    const reopened = layerIn(Editor.fromBytes(editor.save()), comp.id, layer.id).layer;
    expect(effectsOf(reopened).map((e) => e.matchName)).toEqual(before.slice(1));
    expect(reopened.properties.length).toBe(layer.properties.length);
    editor.undo();
    expect(effectsOf(layerIn(editor, comp.id, layer.id).layer).map((e) => e.matchName)).toEqual(before);
    expect(Buffer.from(editor.save()).equals(Buffer.from(original))).toBe(true);
  });
});
