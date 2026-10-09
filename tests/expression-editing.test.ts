// Writing expressions and editing effect values: syntax colouring and completions,
// pick-whip paths, and the editor commands round-tripping through a saved file.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompItem, Layer, Property, PropertyGroup, PropertyNode } from "../src/aep/model.ts";
import { PropertyValueType } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";
import { canStore, setPropertyValue } from "../src/edit/stored-property.ts";
import { complete, tokenize, type NameSource } from "../src/ui/expressionSyntax.ts";
import { addressOf, resolveAddress } from "../src/ui/expressionCommands.ts";
import { defaultExpression, expressionPath } from "../src/ui/expressionPath.ts";

const names: NameSource = {
  layers: () => ["Logo", "Background", "Shape Layer 1"],
  effects: (layer) => (layer === "Logo" ? ["Glow"] : ["Gaussian Blur", "Fill"]),
  params: (effect) => (effect === "Glow" ? ["Glow Radius", "Glow Intensity"] : ["Blurriness", "Blur Dimensions"]),
  masks: () => ["Mask 1", "Mask 2"],
};
const labels = (source: string, caret = source.length) => complete(source, caret, names)?.items.map((c) => c.label) ?? [];

describe("expression syntax", () => {
  it("tokenizes losslessly, colouring comments, strings, numbers, keywords and the expression API", () => {
    const source = '// wobble\nvar a = wiggle(2, 30); // hi\nthisComp.layer("Logo").transform.position[0] + 1.5e2';
    const tokens = tokenize(source);
    expect(tokens.map((t) => t.text).join("")).toBe(source);
    const kind = (text: string) => tokens.find((t) => t.text === text)?.kind;
    expect(kind("// wobble")).toBe("comment");
    expect(kind('"Logo"')).toBe("string");
    expect(kind("1.5e2")).toBe("number");
    expect(kind("var")).toBe("keyword");
    expect(kind("wiggle")).toBe("builtin");
    expect(kind("thisComp")).toBe("builtin");
  });

  it("completes globals, members by owner, and names inside layer(), effect() and parameter strings", () => {
    expect(labels("wig")).toContain("wiggle(freq, amp)");
    expect(labels("thisComp.")).toEqual(expect.arrayContaining(["layer(name or index)", "numLayers", "width"]));
    expect(labels('thisComp.layer("Logo").transform.op')).toEqual(["opacity"]);
    expect(labels("Math.fl")).toEqual(["floor()"]);
    expect(labels("transform.position.wig")).toContain("wiggle(freq, amp, octaves, ampMult, t)");
    expect(labels('thisComp.layer("')).toEqual(["Logo", "Background", "Shape Layer 1"]);
    expect(labels('thisComp.layer("Ba')).toEqual(["Background"]);
    expect(labels('effect("')).toEqual(["Gaussian Blur", "Fill"]);
    expect(labels('thisComp.layer("Logo").effect("')).toEqual(["Glow"]);
    expect(labels('thisComp.layer("Logo").effect("Glow")("')).toEqual(["Glow Radius", "Glow Intensity"]);
    expect(labels('mask("M')).toEqual(["Mask 1", "Mask 2"]);
    expect(labels("// wig")).toEqual([]);
    expect(labels('"wig')).toEqual([]);
    expect(labels("12.")).toEqual([]);
  });

  it("replaces only the typed prefix", () => {
    const r = complete("x = thisLayer.tra", 17, names)!;
    expect(r.from).toBe(14);
    expect(r.items[0].insert).toBe("transform");
  });
});

// --- on a real project ---------------------------------------------------------------

const fixture = (name: string) => new Uint8Array(readFileSync(join("refs", "fixtures", name)));

function find(nodes: readonly PropertyNode[], test: (n: PropertyNode) => boolean): PropertyNode | undefined {
  for (const n of nodes) {
    if (test(n)) return n;
    if (n.kind === "group") {
      const hit = find(n.children, test);
      if (hit) return hit;
    }
  }
  return undefined;
}

const prop = (layer: Layer, matchName: string) => find(layer.properties, (n) => n.kind === "property" && n.matchName === matchName) as Property;

function audioSpectrumLayer(editor: Editor): { comp: CompItem; layer: Layer; effect: PropertyGroup } {
  for (const item of editor.project.items.values()) {
    if (item.kind !== "comp") continue;
    for (const layer of item.layers) {
      const effect = find(layer.properties, (n) => n.kind === "group" && n.matchName === "ADBE AudSpect") as PropertyGroup | undefined;
      if (effect) return { comp: item, layer, effect };
    }
  }
  throw new Error("fxmisc.aep has no Audio Spectrum layer");
}

describe("pick-whip paths", () => {
  it("names transform, effect parameters and other layers the way After Effects writes them", () => {
    const editor = Editor.fromBytes(fixture("fxmisc.aep"));
    const { comp, layer, effect } = audioSpectrumLayer(editor);
    expect(defaultExpression(layer, prop(layer, "ADBE Position"))).toBe("transform.position");
    expect(defaultExpression(layer, prop(layer, "ADBE Opacity"))).toBe("transform.opacity");
    const param = effect.children.find((n): n is Property => n.kind === "property" && !!n.name && n.propertyValueType === PropertyValueType.OneD)!;
    expect(defaultExpression(layer, param)).toBe(`effect(${JSON.stringify(effect.name)})(${JSON.stringify(param.name)})`);
    const other = comp.layers.find((l) => l !== layer)!;
    expect(expressionPath(layer, prop(layer, "ADBE Rotate Z"), other)).toBe(`thisComp.layer(${JSON.stringify(layer.name)}).transform.rotation`);
  });
});

describe("editing commands", () => {
  it("adds, disables and removes an expression, surviving save and reopen, with undo", () => {
    const editor = Editor.fromBytes(fixture("fxmisc.aep"));
    const { comp, layer, effect } = audioSpectrumLayer(editor);
    const stored = effect.children.find((n): n is Property => n.kind === "property" && !!n.chunk && !n.synthesized && n.propertyValueType === PropertyValueType.OneD)!;
    const address = addressOf(comp, layer, stored)!;
    const current = () => resolveAddress(comp.layers.find((l) => l.id === layer.id)!, address)!;
    editor.setExpression(comp, layer, current(), "time * 90");
    expect(current().expression).toBe("time * 90");
    expect(current().expressionEnabled).toBe(true);
    editor.setExpressionEnabled(comp, layer, current(), false);
    expect(current().expressionEnabled).toBe(false);

    const reopened = Editor.fromBytes(editor.save());
    const again = audioSpectrumLayer(reopened);
    const saved = resolveAddress(again.layer, address)!;
    expect(saved.expression).toBe("time * 90");
    expect(saved.expressionEnabled).toBe(false);

    editor.undo();
    expect(current().expressionEnabled).toBe(true);
    editor.setExpression(comp, layer, current(), "");
    expect(current().expression).toBe("");
  });

  it("repoints an effect's layer parameter by layer id, and edits numeric parameters", () => {
    const editor = Editor.fromBytes(fixture("fxmisc.aep"));
    const { comp, layer, effect } = audioSpectrumLayer(editor);
    const layerParam = effect.children.find((n): n is Property => n.kind === "property" && n.propertyValueType === PropertyValueType.LAYER_INDEX)!;
    const target = comp.layers.find((l) => l !== layer)!;
    const address = addressOf(comp, layer, layerParam)!;
    editor.setLayerReference(comp, layer, layerParam, target);
    const reopened = Editor.fromBytes(editor.save());
    const again = audioSpectrumLayer(reopened);
    expect(resolveAddress(again.layer, address)!.value).toBe(target.index);
    editor.setLayerReference(comp, layer, resolveAddress(audioSpectrumLayer(editor).layer, address)!, null);
    expect(resolveAddress(audioSpectrumLayer(editor).layer, address)!.value).toBe(0);

    const numeric = effect.children.find((n): n is Property => n.kind === "property" && !!n.chunk && n.propertyValueType === PropertyValueType.OneD && !n.keyframes.length)!;
    const numericAddress = addressOf(comp, layer, numeric)!;
    editor.setValue(comp, layer, numeric, 7, 0);
    expect(resolveAddress(audioSpectrumLayer(editor).layer, numericAddress)!.value).toBe(7);
  });

  it("writes a parameter After Effects left out at its default, then edits it, as one undo step", () => {
    const editor = Editor.fromBytes(fixture("fxmisc.aep"));
    const { comp, layer, effect } = audioSpectrumLayer(editor);
    const left = effect.children.find((n): n is Property => n.kind === "property" && !!n.synthesized && n.propertyValueType === PropertyValueType.OneD && typeof n.value === "number")!;
    expect(left).toBeDefined();
    expect(canStore(editor, layer, left)).toBe(true);
    const address = addressOf(comp, layer, left)!;
    const others = effect.children.filter((n): n is Property => n.kind === "property" && n !== left).map((p) => [p.matchName, JSON.stringify(p.value)]);
    const next = (left.value as number) + 3;
    setPropertyValue(editor, comp, layer, left, next, 0);

    const written = resolveAddress(audioSpectrumLayer(editor).layer, address)!;
    expect(written.synthesized).toBeFalsy();
    expect(written.value).toBe(next);
    const reopened = audioSpectrumLayer(Editor.fromBytes(editor.save()));
    expect(resolveAddress(reopened.layer, address)!.value).toBe(next);
    const after = reopened.effect.children.filter((n): n is Property => n.kind === "property" && n.matchName !== left.matchName).map((p) => [p.matchName, JSON.stringify(p.value)]);
    expect(after).toEqual(others.filter(([m]) => m !== left.matchName));

    editor.undo();
    const restored = resolveAddress(audioSpectrumLayer(editor).layer, address)!;
    expect(restored.synthesized).toBe(true);
    expect(restored.value).toBe(left.value);
  });
});
