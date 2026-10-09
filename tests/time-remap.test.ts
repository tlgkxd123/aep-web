// Layer > Time > Enable Time Remapping: the keys After Effects seeds, written into the file, and undoable.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { CompItem, Property } from "../src/aep/model.ts";
import { valueAtTime } from "../src/aep/evaluate.ts";
import { Editor } from "../src/edit/editor.ts";
import { canRemapTime, setTimeRemapping } from "../src/edit/layers.ts";

const open = (bytes: Uint8Array) => Editor.fromBytes(bytes);
const clipLayer = (editor: Editor) => {
  const comp = [...editor.project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === "footage_video")!;
  const layer = comp.layers[comp.layers.length - 1];
  const remap = layer.properties.find((n): n is Property => n.kind === "property" && n.matchName === "ADBE Time Remapping")!;
  return { comp, layer, remap };
};

it("seeds source time 0 at the layer start and the last frame where the layer reaches it, and turns off again", () => {
  const editor = open(new Uint8Array(readFileSync(join("refs", "fixtures", "footage.aep"))));
  let { comp, layer } = clipLayer(editor);
  expect(canRemapTime(editor.project, layer)).toBe(true);
  expect(layer.timeRemapEnabled).toBe(false);

  setTimeRemapping(editor, comp, [layer], true);
  // clip.mp4: 30 frames at 30 fps.
  const reopened = clipLayer(open(editor.save()));
  expect(reopened.layer.timeRemapEnabled).toBe(true);
  expect(reopened.remap.keyframes.map((k) => [k.time, k.value])).toEqual([
    [expect.closeTo(reopened.layer.startTime, 6), expect.closeTo(0, 6)],
    // Key times sit on the comp's time grid.
    [expect.closeTo(reopened.layer.startTime + 29 / 30, 4), expect.closeTo(29 / 30, 6)],
  ]);
  expect(Number(valueAtTime(reopened.remap, reopened.layer.startTime + 0.5, reopened.layer))).toBeCloseTo(0.5, 4);

  ({ comp, layer } = clipLayer(editor));
  setTimeRemapping(editor, comp, [layer], false);
  expect(clipLayer(open(editor.save())).layer.timeRemapEnabled).toBe(false);
  editor.undo();
  expect(clipLayer(editor).layer.timeRemapEnabled).toBe(true);
  editor.undo();
  expect(clipLayer(editor).layer.timeRemapEnabled).toBe(false);
});

it("is unavailable for stills", () => {
  const editor = open(new Uint8Array(readFileSync(join("refs", "fixtures", "footage.aep"))));
  const still = [...editor.project.items.values()]
    .flatMap((i) => (i.kind === "comp" ? i.layers : []))
    .find((l) => {
      const source = editor.project.items.get(l.sourceId);
      return source?.kind === "footage" && source.mainSource.isStill && source.mainSource.sourceType === "FileSource";
    })!;
  expect(canRemapTime(editor.project, still)).toBe(false);
});
