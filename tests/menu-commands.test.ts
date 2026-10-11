// The editing commands behind the menu bar and context menus: labels, frame blending, Split Layer, Copy / Paste,
// Freeze Frame, Remove Unused Footage, Reduce Project, New Comp from Selection settings and Edit > History.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import type { CompItem, FootageItem } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";
import { copyLayers, pasteLayers, splitLayers } from "../src/edit/layers.ts";
import { compSettingsFor, deleteItems, reduceProject, removeUnusedFootage, setItemLabel } from "../src/edit/project.ts";
import { menuShortcut } from "../src/ui/App.tsx";
import { incrementedName } from "../src/ui/useProjectOps.tsx";

const FIXTURE = resolve(import.meta.dirname, "../refs/fixtures/layerops.base.aep");
const open = () => Editor.fromBytes(readFileSync(FIXTURE));
const comp = (editor: Editor, name: string) => [...editor.project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === name)!;
const layer = (c: CompItem, name: string) => c.layers.find((l) => l.name === name)!;
const reopen = (editor: Editor) => Editor.fromBytes(editor.save());

test("layer labels and frame blending are written to the layer and survive a save", () => {
  const editor = open();
  const holder = comp(editor, "layerops_holder");
  editor.setLayerLabel(holder, layer(holder, "layerops tall"), 9);
  editor.setFrameBlending(holder, layer(holder, "layerops tall"), 4014);
  expect(layer(holder, "layerops tall").label).toBe(9);
  expect(layer(holder, "layerops tall").frameBlendingType).toBe(4014);

  const saved = comp(reopen(editor), "layerops_holder");
  expect(layer(saved, "layerops tall").label).toBe(9);
  expect(layer(saved, "layerops tall").frameBlendingType).toBe(4014);
  expect(layer(saved, "layerops small").label).toBe(1);

  editor.setFrameBlending(holder, layer(holder, "layerops tall"), 4013);
  expect(layer(holder, "layerops tall").frameBlendingType).toBe(4013);
  editor.undo();
  editor.undo();
  editor.undo();
  expect(layer(holder, "layerops tall").label).toBe(1);
  expect(layer(holder, "layerops tall").frameBlendingType).toBe(4012);
});

test("item labels change through the Project panel's Label menu", () => {
  const editor = open();
  const card = comp(editor, "layerops_card");
  setItemLabel(editor, [card], 3);
  expect(comp(editor, "layerops_card").label).toBe(3);
  expect(comp(reopen(editor), "layerops_card").label).toBe(3);
  editor.undo();
  expect(comp(editor, "layerops_card").label).toBe(15);
});

test("Split Layer ends the layer at the time and continues it in a duplicate above", () => {
  const editor = open();
  const holder = comp(editor, "layerops_holder");
  const [created] = splitLayers(editor, holder, [layer(holder, "layerops tall")], 0.5);
  const parts = holder.layers.filter((l) => l.name.startsWith("layerops tall"));
  expect(parts).toHaveLength(2);
  const copy = holder.layers.find((l) => l.id === created)!;
  const original = holder.layers.find((l) => l.name === "layerops tall" && l.id !== created)!;
  expect(copy.index).toBe(original.index - 1);
  expect([original.inPoint, original.outPoint]).toEqual([0, 0.5]);
  expect([copy.inPoint, copy.outPoint]).toEqual([0.5, 1]);
  expect(editor.undoLabel).toBe("Split Layer");
  editor.undo();
  expect(holder.layers).toHaveLength(3);
  expect(splitLayers(editor, holder, [layer(holder, "layerops tall")], 0)).toEqual([]);
});

test("copied layers paste into another comp of the same frame rate, with fresh ids; other frame rates are refused", () => {
  const editor = open();
  const holder = comp(editor, "layerops_holder");
  const target = comp(editor, "layerops_new");
  const clip = copyLayers(editor.project, holder, [layer(holder, "layerops small"), layer(holder, "layerops wide")])!;
  const ids = pasteLayers(editor, target, clip);
  expect(target.layers.map((l) => l.name)).toEqual(["layerops small", "layerops wide"]);
  expect(target.layers.map((l) => l.id)).toEqual(ids);
  expect(ids.some((id) => holder.layers.some((l) => l.id === id))).toBe(false);
  expect(target.layers[0].sourceId).toBe(layer(holder, "layerops small").sourceId);

  pasteLayers(editor, holder, clip, layer(holder, "layerops tall"));
  expect(holder.layers.map((l) => l.name)).toEqual(["layerops small", "layerops small", "layerops wide", "layerops tall", "layerops wide"]);
  expect(comp(reopen(editor), "layerops_new").layers).toHaveLength(2);

  expect(() => pasteLayers(editor, comp(editor, "ErrorLayer"), clip)).toThrow(/frame rate/);
  expect(() => pasteLayers(open(), target, clip)).toThrow(/project/);
});

test("Remove Unused Footage and Reduce Project delete what no kept composition uses", () => {
  const editor = open();
  expect(removeUnusedFootage(editor)).toBe(0);
  deleteItems(editor, [comp(editor, "layerops_holder")]);
  expect(removeUnusedFootage(editor)).toBe(3);
  expect([...editor.project.items.values()].filter((i) => i.kind === "footage").map((i) => i.name).sort()).toEqual(["layerops card bg", "layerops card mark"]);

  const fresh = open();
  const removed = reduceProject(fresh, [comp(fresh, "layerops_card")]);
  expect(removed).toBe(13);
  expect([...fresh.project.items.values()].map((i) => i.name).sort()).toEqual(["Farbflächen", "layerops", "layerops card bg", "layerops card mark", "layerops_card"]);
  fresh.undo();
  expect(fresh.project.items.size).toBe(18);
  expect(() => reduceProject(fresh, [])).toThrow(/Select/);
});

test("New Comp from Selection takes the item's size, rate and duration, with defaults for stills", () => {
  const editor = open();
  const card = comp(editor, "layerops_card");
  expect(compSettingsFor(card)).toMatchObject({ name: "layerops_card", width: 80, height: 60, frameRate: 24, duration: 1 });
  const solid = [...editor.project.items.values()].find((i): i is FootageItem => i.kind === "footage")!;
  const settings = compSettingsFor(solid);
  expect(settings.width).toBe(solid.width);
  expect(settings.duration).toBeGreaterThan(0);
});

test("Edit > History undoes back to an entry; Purge > Undo forgets the history but not the unsaved changes", () => {
  const editor = open();
  const holder = comp(editor, "layerops_holder");
  editor.setLayerLabel(holder, layer(holder, "layerops small"), 2);
  editor.setLayerLabel(holder, layer(holder, "layerops small"), 3);
  editor.renameLayer(holder, layer(holder, "layerops small"), "renamed");
  expect(editor.history).toEqual(["Change label", "Change label", "Rename layer"]);
  editor.undoTo(1);
  expect(editor.history).toEqual(["Change label"]);
  expect(layer(holder, "layerops small").label).toBe(2);
  expect(editor.redoLabel).toBe("Change label");
  editor.clearHistory();
  expect(editor.history).toEqual([]);
  expect(editor.redoLabel).toBeUndefined();
  expect(editor.dirty).toBe(true);
  editor.markSaved();
  editor.clearHistory();
  expect(editor.dirty).toBe(false);
});

test("Increment and Save numbers the file name", () => {
  expect(incrementedName("Project.aep")).toBe("Project 2.aep");
  expect(incrementedName("Project 2.aep")).toBe("Project 3.aep");
  expect(incrementedName("shot_09.aep")).toBe("shot 10.aep");
  expect(incrementedName("Untitled")).toBe("Untitled 2.aep");
});

test("menu shortcuts map AE's keys to the menu commands", () => {
  const key = (code: string, mods: Partial<KeyboardEvent> = {}, k = "") =>
    ({ code, key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }) as KeyboardEvent;
  expect(menuShortcut(key("KeyC", { ctrlKey: true }), false)).toBe("copy");
  expect(menuShortcut(key("KeyC", { ctrlKey: true }), true)).toBeUndefined();
  expect(menuShortcut(key("KeyD", { ctrlKey: true, shiftKey: true }), false)).toBe("split-layer");
  expect(menuShortcut(key("KeyO", { ctrlKey: true, shiftKey: true }), false)).toBe("transform-dialog:opacity");
  expect(menuShortcut(key("KeyJ", { altKey: true, shiftKey: true }), false)).toBe("go-to-time");
  expect(menuShortcut(key("Equal", { shiftKey: true }), false)).toBe("next-blending-mode");
  expect(menuShortcut(key("Period", {}, "."), false)).toBe("zoom-in");
  expect(menuShortcut(key("KeyZ", { ctrlKey: true }), false)).toBeUndefined();
});
