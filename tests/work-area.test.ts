// Setting the work area (B / N, the compact Timeline's buttons, drags of its bar) is saved into the composition and
// undoable.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CompItem } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { Editor } from "../src/edit/editor.ts";
import { dragWorkArea, workAreaAtTime, workAreaOf } from "../src/ui/workArea.ts";

const FIXTURES = new URL("../refs/fixtures/fixtures.aep", import.meta.url);

const fakeComp = (over: Partial<CompItem> = {}) =>
  ({ frameRate: 10, frameDuration: 0.1, duration: 10, workAreaStart: 2, workAreaDuration: 3, ...over }) as CompItem;

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

  it("collapses the steps of one drag into one undo step", () => {
    const editor = Editor.fromBytes(new Uint8Array(readFileSync(FIXTURES)));
    const comp = [...editor.project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.duration >= 1)!;
    const before = [comp.workAreaStart, comp.workAreaDuration];
    const frame = comp.frameDuration;
    for (const n of [2, 4, 6]) editor.setCompSettings(comp, { workArea: [frame * n, frame * (n + 5)] }, { coalesce: "drag" });
    editor.commit();
    expect(comp.workAreaStart).toBeCloseTo(frame * 6, 6);
    expect(comp.workAreaDuration).toBeCloseTo(frame * 5, 6);
    editor.undo();
    expect([comp.workAreaStart, comp.workAreaDuration]).toEqual(before);
  });

  it("B starts it at the current time and N ends it after the current frame", () => {
    expect(workAreaAtTime(fakeComp(), 3, false)).toEqual([3, 5]);
    expect(workAreaAtTime(fakeComp(), 3, true)[0]).toBe(2);
    expect(workAreaAtTime(fakeComp(), 3, true)[1]).toBeCloseTo(3.1, 9);
    // A start past the end resets the end to the comp's, an end before the start the start to 0.
    expect(workAreaAtTime(fakeComp(), 6, false)).toEqual([6, 10]);
    expect(workAreaAtTime(fakeComp(), 1, true)[0]).toBe(0);
    // The end stays inside the comp.
    expect(workAreaAtTime(fakeComp(), 9.95, true)[1]).toBe(10);
  });

  it("drags an end or the whole bar on frames, inside the comp and at least a frame long", () => {
    const comp = fakeComp();
    const from = workAreaOf(comp);
    expect(from).toEqual([2, 5]);
    const [s, e] = dragWorkArea(comp, from, "start", 0.74);
    expect(s).toBeCloseTo(2.7, 9);
    expect(e).toBe(5);
    expect(dragWorkArea(comp, from, "start", 10)[0]).toBeCloseTo(4.9, 9);
    expect(dragWorkArea(comp, from, "start", -10)).toEqual([0, 5]);
    expect(dragWorkArea(comp, from, "end", 100)).toEqual([2, 10]);
    expect(dragWorkArea(comp, from, "end", -100)[1]).toBeCloseTo(2.1, 9);
    expect(dragWorkArea(comp, from, "move", 1)).toEqual([3, 6]);
    expect(dragWorkArea(comp, from, "move", 100)).toEqual([7, 10]);
    expect(dragWorkArea(comp, from, "move", -100)).toEqual([0, 3]);
  });
});
