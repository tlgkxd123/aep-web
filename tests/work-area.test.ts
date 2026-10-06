// Setting the work area (B / N) is saved into the composition and undoable.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CompItem } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { Editor } from "../src/edit/editor.ts";

const FIXTURES = new URL("../refs/fixtures/fixtures.aep", import.meta.url);

describe("work area", () => {
  it("round-trips through save and undo", () => {
    const editor = Editor.fromBytes(new Uint8Array(readFileSync(FIXTURES)));
    const comp = [...editor.project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.duration >= 1)!;
    const before = [comp.workAreaStart, comp.workAreaDuration];
    const frame = comp.frameDuration;
    editor.setCompSettings(comp, { workArea: [frame * 3, frame * 10] });
    const saved = [...parseProject(editor.save()).items.values()].find((i): i is CompItem => i.kind === "comp" && i.id === comp.id)!;
    expect(saved.workAreaStart).toBeCloseTo(frame * 3, 6);
    expect(saved.workAreaDuration).toBeCloseTo(frame * 7, 6);
    editor.undo();
    const undone = [...parseProject(editor.save()).items.values()].find((i): i is CompItem => i.kind === "comp" && i.id === comp.id)!;
    expect([undone.workAreaStart, undone.workAreaDuration]).toEqual(before);
  });
});
