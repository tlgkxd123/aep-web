// The Timeline's comp switches are saved into the cdta chunk and read back.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CompItem } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { Editor, type CompSwitch } from "../src/edit/editor.ts";

const FIXTURES = new URL("../refs/fixtures/fixtures.aep", import.meta.url);

describe("comp switches", () => {
  for (const name of ["draft3d", "frameBlending", "motionBlur", "hideShyLayers"] as CompSwitch[]) {
    it(`${name} round-trips through save, and undo restores it`, () => {
      const editor = Editor.fromBytes(new Uint8Array(readFileSync(FIXTURES)));
      const comp = [...editor.project.items.values()].find((i): i is CompItem => i.kind === "comp")!;
      const before = comp[name];
      editor.setCompSwitch(comp, name, !before);
      const saved = parseProject(editor.save());
      const reread = [...saved.items.values()].find((i): i is CompItem => i.kind === "comp" && i.id === comp.id)!;
      expect(reread[name]).toBe(!before);
      // Other switches are untouched.
      for (const other of ["draft3d", "frameBlending", "motionBlur", "hideShyLayers"] as CompSwitch[]) {
        if (other !== name) expect(reread[other]).toBe(comp[other]);
      }
      editor.undo();
      const undone = parseProject(editor.save());
      expect([...undone.items.values()].find((i): i is CompItem => i.kind === "comp" && i.id === comp.id)![name]).toBe(before);
    });
  }
});
