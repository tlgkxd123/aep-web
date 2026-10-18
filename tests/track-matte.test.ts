import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { CompItem } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { Editor } from "../src/edit/editor.ts";
import { matteLayerOf } from "../src/render/composition.ts";
import { SAMPLES } from "../scripts/lib/paths.ts";

const open = () => Editor.fromBytes(new Uint8Array(readFileSync("refs/fixtures/matte2.aep")));
const comp = (editor: Editor, name: string) => [...editor.project.items.values()].find((i) => i.name === name) as CompItem;
const layer = (c: CompItem, name: string) => c.layers.find((l) => l.name === name)!;

describe("track mattes of AE 23+ files", () => {
  test("the matte layer is read by id wherever it sits in the stack", () => {
    const c = comp(open(), "matte2_gap");
    const content = layer(c, "content");
    expect(matteLayerOf(content, c)!.name).toBe("matte");
    expect(layer(c, "matte").index).toBeGreaterThan(content.index + 1);
  });

  test("a matte naming no layer of the comp (0 or a missing id) leaves the layer unmatted", () => {
    const editor = open();
    for (const name of ["matte2_top", "matte2_dangling", "matte2_chain_legacy"]) {
      const c = comp(editor, name);
      expect(matteLayerOf(layer(c, "content"), c), name).toBeUndefined();
    }
  });

  test("files before AE 23 use the layer above", () => {
    const project = parseProject(new Uint8Array(readFileSync(`${SAMPLES}/versions/ae2018/complete.aep`)));
    const c = [...project.items.values()].find((i) => i.name === "Main_Comp") as CompItem;
    const target = layer(c, "TrackMatte_Target");
    expect(matteLayerOf(target, c)).toBe(c.layers[target.index - 2]);
  });

  test("any other layer can be picked and survives saving; a loop is refused", () => {
    const editor = open();
    expect(editor.hasExplicitMatteLayers(layer(comp(editor, "matte2_below"), "content"))).toBe(true);
    editor.setTrackMatte(comp(editor, "matte2_below"), layer(comp(editor, "matte2_below"), "content"), 5015, layer(comp(editor, "matte2_below"), "bg").id);
    const saved = comp(Editor.fromBytes(editor.save()), "matte2_below");
    expect(layer(saved, "content").trackMatteType).toBe(5015);
    expect(matteLayerOf(layer(saved, "content"), saved)!.name).toBe("bg");
    const now = comp(editor, "matte2_below");
    expect(() => editor.setTrackMatte(now, layer(now, "bg"), 5013, layer(now, "content").id)).toThrow("own track matte");
  });
});
