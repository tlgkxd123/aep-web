// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test } from "vitest";
import { applyLibraryEffect, effectLibrary } from "../src/edit/effectLibrary.ts";
import { addLayer } from "../src/edit/layers.ts";
import { newMask } from "../src/edit/masks.ts";
import { DEFAULT_COMP_SETTINGS, newComposition, newProject } from "../src/edit/project.ts";
import { toggleTransformStopwatch } from "../src/edit/transform-ops.ts";
import { App } from "../src/ui/App.tsx";

afterEach(cleanup);

/** "Plate" (on top) has a mask, a Fill effect and keyframed Position; "Back" has nothing but its Transform. */
let project: Uint8Array;
beforeAll(async () => {
  const editor = newProject();
  const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: "Reveal", width: 320, height: 180, frameRate: 30, duration: 4 });
  addLayer(editor, comp, { kind: "solid", name: "Back", color: [0.1, 0.1, 0.1], width: 320, height: 180 });
  addLayer(editor, comp, { kind: "solid", name: "Plate", color: [0.2, 0.6, 0.9], width: 200, height: 100 });
  const plate = () => comp.layers.find((l) => l.name === "Plate")!;
  newMask(editor, comp, plate());
  toggleTransformStopwatch(editor, comp, plate(), "ADBE Position", 0);
  const fill = (await effectLibrary()).find((e) => e.matchName === "ADBE Fill")!;
  applyLibraryEffect(editor, comp, [plate().id], fill);
  project = editor.save();
});

async function open() {
  render(<App />);
  const file = new File([project as Uint8Array<ArrayBuffer>], "reveal.aep");
  fireEvent.change(screen.getByLabelText("Open After Effects project"), { target: { files: [file] } });
  await screen.findByRole("tree", { name: "Timeline layers" });
}

const tree = () => screen.getByRole("tree", { name: "Timeline layers" });
/** The Timeline's rows, indented two spaces a level. */
const rows = () =>
  Array.from(tree().querySelectorAll<HTMLElement>('[role="treeitem"]')).map((r) => `${"  ".repeat(Number(r.getAttribute("aria-level")) - 1)}${r.getAttribute("aria-label")}`);

let clock = 0;
/** A key press `gap` ms after the previous one (two presses of a key within 400 ms are its doubled shortcut). */
function press(key: string, mods: { shiftKey?: boolean } = {}, gap = 1000) {
  clock += gap;
  const event = new KeyboardEvent("keydown", { key: mods.shiftKey ? key.toUpperCase() : key, bubbles: true, cancelable: true, ...mods });
  Object.defineProperty(event, "timeStamp", { value: clock });
  fireEvent(window, event);
}

const selectLayer = (name: string) => fireEvent.click(within(tree()).getByRole("treeitem", { name }));

test("A, P, S, R and T show only that Transform property of the selected layer; pressed again they hide it; Shift adds", async () => {
  await open();
  selectLayer("Plate");
  press("s");
  expect(rows()).toEqual(["Plate", "  Scale", "Back"]);
  press("s");
  expect(rows()).toEqual(["Plate", "Back"]);
  press("p");
  press("s", { shiftKey: true });
  press("r", { shiftKey: true });
  expect(rows()).toEqual(["Plate", "  Position", "  Scale", "  Rotation", "Back"]);
  press("p", { shiftKey: true });
  expect(rows()).toEqual(["Plate", "  Scale", "  Rotation", "Back"]);
  press("a");
  expect(rows()).toEqual(["Plate", "  Anchor Point", "Back"]);
  press("t");
  expect(rows()).toEqual(["Plate", "  Opacity", "Back"]);
});

test("with no layer selected a reveal acts on every layer", async () => {
  await open();
  press("t");
  expect(rows()).toEqual(["Plate", "  Opacity", "Back", "  Opacity"]);
  press("t");
  expect(rows()).toEqual(["Plate", "Back"]);
});

test("M, MM, F and TT show masks; E the effects closed; U the keyframed properties; UU the modified ones", async () => {
  await open();
  selectLayer("Plate");
  press("m");
  expect(rows()).toEqual(["Plate", "  Masks", "    Mask 1", "      Mask Path", "Back"]);
  press("m", {}, 100);
  expect(rows()).toEqual(["Plate", "  Masks", "    Mask 1", "      Mask Path", "      Mask Feather", "      Mask Opacity", "      Mask Expansion", "Back"]);
  press("f");
  expect(rows()).toEqual(["Plate", "  Masks", "    Mask 1", "      Mask Feather", "Back"]);
  press("t");
  press("t", {}, 100);
  expect(rows()).toEqual(["Plate", "  Masks", "    Mask 1", "      Mask Opacity", "Back"]);
  press("e");
  expect(rows()).toEqual(["Plate", "  Effects", "    Fill", "Back"]);
  expect(within(tree()).getByRole("treeitem", { name: "Fill" }).getAttribute("aria-expanded")).toBe("false");
  press("u");
  expect(rows()).toEqual(["Plate", "  Position", "Back"]);
  press("u", {}, 100);
  // A drawn mask's path differs from a new mask's, Position is keyframed; the solid's other Transform values are AE's defaults.
  expect(rows()).toEqual(["Plate", "  Masks", "    Mask 1", "      Mask Path", "  Position", "Back"]);
  selectLayer("Back");
  press("u");
  expect(rows()).toEqual(["Plate", "  Masks", "    Mask 1", "      Mask Path", "  Position", "Back"]);
});

test("a revealed layer's twirl closes it; a group's twirl turns the reveal into ordinary twirl-downs", async () => {
  await open();
  selectLayer("Plate");
  press("e");
  fireEvent.click(within(tree()).getByRole("button", { name: "Expand Fill" }));
  // The layer's whole outline again, with the groups the reveal had open still open and Fill opened.
  expect(rows().slice(0, 4)).toEqual(["Plate", "  Masks", "  Effects", "    Fill"]);
  expect(rows()).toContain("      Color");
  expect(rows().slice(-2)).toEqual(["  Transform", "Back"]);
  press("p");
  fireEvent.click(within(tree()).getByRole("button", { name: "Collapse Plate" }));
  expect(rows()).toEqual(["Plate", "Back"]);
  fireEvent.click(within(tree()).getByRole("button", { name: "Expand Plate" }));
  expect(rows()).toEqual(["Plate", "  Masks", "  Effects", "  Transform", "Back"]);
});

test("the layer's context menu and Animation > Show Properties reveal without a keyboard", async () => {
  await open();
  fireEvent.contextMenu(within(tree()).getByRole("treeitem", { name: "Plate" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Show Properties/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Scale/ }));
  expect(rows()).toEqual(["Plate", "  Scale", "Back"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Animation" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Reveal Properties with Keyframes/ }));
  expect(rows()).toEqual(["Plate", "  Position", "Back"]);
});
