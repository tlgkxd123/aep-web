// @vitest-environment jsdom
// Effects & Presets lists every effect After Effects does and applies those it has a template of (the library's,
// and those the project defines) to the selected layer: double-click, Enter (on an effect or in the search field), the
// Effect menu, a drop on a Timeline layer row, on the viewer or on Effect Controls, each one undo step; the effects
// show in Effect Controls and survive saving and reopening. The others are listed, unavailable.
import { File as NodeFile } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { CompItem, Property, PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { App } from "../src/ui/App.tsx";
import { SAMPLES } from "../scripts/lib/paths.ts";

const FIXTURE = resolve(import.meta.dirname, "../refs/fixtures/roundtrip.base.aep");
const COMP = "roundtrip_minimax";
const CARD = "roundtrip_card";
/** A project After Effects saved whose one layer has two Gaussian Blurs (Blurriness 20 and 30). */
const GAUSSIAN = resolve(SAMPLES, "models/property/2_gaussian_20_30.aep");
/** A project After Effects saved that defines Lens Flare and CC Sphere, which the viewer does not render. */
const EFFECTS = resolve(SAMPLES, "models/property/effects.aep");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

for (const name of ["PointerEvent", "DragEvent"] as const) {
  if (typeof window[name] === "undefined") {
    Object.defineProperty(window, name, { configurable: true, value: class extends MouseEvent {} });
  }
}

/** Opens a project and the comp in it, and selects its layer `layer`. */
async function openComp(bytes: Uint8Array, name: string, comp = COMP, layer = CARD) {
  render(<App />);
  // jsdom's File cannot be read back; Node's can.
  const file = new NodeFile([bytes], name) as unknown as File;
  fireEvent.change(screen.getByLabelText("Open After Effects project"), { target: { files: [file] } });
  const items = await screen.findByRole("tree", { name: "Project items" });
  fireEvent.change(screen.getByLabelText("Search project"), { target: { value: comp } });
  const row = within(items)
    .getAllByText(comp)
    .find((e) => e.classList.contains("cell-text"))!
    .closest<HTMLElement>('[role="treeitem"]')!;
  fireEvent.doubleClick(row);
  expect(await screen.findByText("Select a layer to apply effects to it.")).toBeTruthy();
  fireEvent.click(layerRow(layer));
  expect(screen.queryByText("Select a layer to apply effects to it.")).toBeNull();
}

const timeline = () => screen.getByRole("tree", { name: "Timeline layers" });
const layerRow = (name = CARD) => within(timeline()).getByRole("treeitem", { name });
const library = () => screen.getByRole("tree", { name: "Effects & Presets" });
const search = () => screen.getByLabelText("Search effects and presets");
const effectNames = () =>
  Array.from(screen.getByRole("tree", { name: "Effect Controls" }).querySelectorAll(".ec-effect-name")).map((e) => e.textContent);

/** The effect `name` listed in `category` (opened), once it can be applied when `available`. */
async function libraryEffect(category: string, name: string, available = true): Promise<HTMLElement> {
  const row = await within(library()).findByRole("treeitem", { name: category });
  if (row.getAttribute("aria-expanded") !== "true") fireEvent.click(row.querySelector(".fxp-cat")!);
  const effect = within(row).getByRole("treeitem", { name });
  if (available) await waitFor(() => expect(effect.getAttribute("aria-disabled")).toBeNull());
  return effect;
}

function dataTransfer() {
  const data = new Map<string, string>();
  return {
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    dropEffect: "none",
    effectAllowed: "all",
  };
}

/** Drags `from` (an effect row) and drops it on `to`. */
function dragDrop(from: Element, to: Element) {
  const moving = dataTransfer();
  fireEvent.dragStart(from, { dataTransfer: moving });
  fireEvent.dragOver(to, { dataTransfer: moving });
  fireEvent.drop(to, { dataTransfer: moving });
}

const key = (k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) =>
  act(() => {
    fireEvent.keyDown(window, { key: k, ...mods });
  });

/** Saves with Ctrl+S (downloaded without a file picker) and returns the bytes written. */
async function save(): Promise<Uint8Array> {
  let saved: Blob | undefined;
  URL.createObjectURL = vi.fn((blob: Blob) => ((saved = blob), "blob:project"));
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  act(() => {
    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
  });
  await waitFor(() => expect(saved).toBeTruthy());
  return new Promise<Uint8Array>((done) => {
    const reader = new FileReader();
    reader.onload = () => done(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(saved!);
  });
}

/** The effects of the first layer of comp `name` in a saved project. */
function savedEffects(bytes: Uint8Array, name: string): PropertyGroup[] {
  const comp = [...parseProject(bytes).items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === name)!;
  const parade = comp.layers[0].properties.find((p): p is PropertyGroup => p.kind === "group" && p.matchName === "ADBE Effect Parade")!;
  return parade.children.filter((c): c is PropertyGroup => c.kind === "group");
}

test("library effects apply to the selected layer from the panel, the Effect menu and drops, and survive save and reopen", async () => {
  await openComp(readFileSync(FIXTURE), "roundtrip.base.aep");

  // Searching narrows the list to matching effects, under their categories.
  fireEvent.change(search(), { target: { value: "mirr" } });
  const mirror = await libraryEffect("Distort", "Mirror");
  expect(within(library()).queryByRole("treeitem", { name: "Polar Coordinates" })).toBeNull();
  expect(within(library()).getByRole("treeitem", { name: "Distort" }).getAttribute("aria-expanded")).toBe("true");

  // Double-click applies the effect and shows the layer in Effect Controls; the project now uses it.
  fireEvent.doubleClick(mirror);
  await waitFor(() => expect(effectNames()).toEqual(["Mirror"]));
  expect(screen.getByRole("tab", { name: /^Effect Controls/ }).textContent).toContain(CARD);
  const used = within(library()).getByRole("treeitem", { name: "Used in This Project" });
  expect(within(used).getByRole("treeitem", { name: "Mirror" })).toBeTruthy();
  fireEvent.change(search(), { target: { value: "" } });

  // Enter applies the selected effect; one undo removes it.
  const polar = await libraryEffect("Distort", "Polar Coordinates");
  fireEvent.click(polar);
  fireEvent.keyDown(polar, { key: "Enter" });
  expect(effectNames()).toEqual(["Mirror", "Polar Coordinates"]);
  key("z", { ctrlKey: true });
  expect(effectNames()).toEqual(["Mirror"]);

  // In the search field, Enter applies the first match that can be applied, and Down picks the next one.
  fireEvent.change(search(), { target: { value: "blur" } });
  fireEvent.keyDown(search(), { key: "Enter" });
  expect(effectNames()).toEqual(["Mirror", "Fast Box Blur"]);
  fireEvent.change(search(), { target: { value: "control" } });
  fireEvent.keyDown(search(), { key: "ArrowDown" });
  fireEvent.keyDown(search(), { key: "ArrowDown" });
  expect((await libraryEffect("Expression Controls", "Angle Control")).getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(search(), { key: "Enter" });
  expect(effectNames()).toEqual(["Mirror", "Fast Box Blur", "Angle Control"]);
  key("z", { ctrlKey: true });
  key("z", { ctrlKey: true });
  expect(effectNames()).toEqual(["Mirror"]);
  fireEvent.change(search(), { target: { value: "" } });

  // Effect > Channel > Minimax, and Last Effect applies it again.
  fireEvent.click(screen.getByRole("menuitem", { name: "Effect" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Channel/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Minimax/ }));
  expect(effectNames()).toEqual(["Mirror", "Minimax"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Effect" }));
  expect(screen.getByRole("menuitem", { name: /^Minimax\s*Ctrl\+Alt\+Shift\+E/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Effect" }));
  key("E", { ctrlKey: true, altKey: true, shiftKey: true });
  expect(effectNames()).toEqual(["Mirror", "Minimax", "Minimax"]);
  key("z", { ctrlKey: true });

  // Dragged onto the layer's Timeline row.
  const vignette = await libraryEffect("Stylize", "CC Vignette");
  const moving = dataTransfer();
  fireEvent.dragStart(vignette, { dataTransfer: moving });
  fireEvent.dragOver(layerRow(), { dataTransfer: moving });
  expect(layerRow().className).toContain("drop-on");
  fireEvent.drop(layerRow(), { dataTransfer: moving });
  expect(effectNames()).toEqual(["Mirror", "Minimax", "CC Vignette"]);

  // Dragged onto the Composition viewer: applied to the selected layer, as the pointer is over no other.
  dragDrop(await libraryEffect("Generate", "Gradient Ramp"), screen.getByRole("img", { name: new RegExp(`^${COMP}, 160 x 120`) }));
  expect(effectNames()).toEqual(["Mirror", "Minimax", "CC Vignette", "Gradient Ramp"]);

  // Dragged onto Effect Controls: applied to the layer it shows.
  dragDrop(await libraryEffect("Expression Controls", "Slider Control"), screen.getByRole("tree", { name: "Effect Controls" }));
  expect(effectNames()).toEqual(["Mirror", "Minimax", "CC Vignette", "Gradient Ramp", "Slider Control"]);
  key("z", { ctrlKey: true });

  const bytes = await save();
  expect(savedEffects(bytes, COMP).map((c) => c.matchName)).toEqual(["ADBE Mirror", "ADBE Minimax", "CS Vignette", "ADBE Ramp"]);

  // Reopened in the app, Effect Controls lists them.
  cleanup();
  await openComp(bytes, "roundtrip.base.aep");
  fireEvent.click(screen.getByRole("tab", { name: /^Effect Controls/ }));
  expect(effectNames()).toEqual(["Mirror", "Minimax", "CC Vignette", "Gradient Ramp"]);

  // Effect > Remove All (Ctrl+Shift+E) is one undo step too.
  key("E", { ctrlKey: true, shiftKey: true });
  expect(effectNames()).toEqual([]);
  key("z", { ctrlKey: true });
  expect(effectNames()).toEqual(["Mirror", "Minimax", "CC Vignette", "Gradient Ramp"]);
});

test("every After Effects effect is listed; those without a template are unavailable", async () => {
  await openComp(readFileSync(FIXTURE), "roundtrip.base.aep");
  fireEvent.click(screen.getByRole("tab", { name: /^Effect Controls/ }));
  await libraryEffect("Distort", "Mirror");

  // Effects the library lacks and the project does not define are found by name and category, but do not apply.
  fireEvent.change(search(), { target: { value: "invert" } });
  const invert = await libraryEffect("Channel", "Invert", false);
  expect(invert.getAttribute("aria-disabled")).toBe("true");
  expect(invert.getAttribute("draggable")).toBe("false");
  fireEvent.doubleClick(invert);
  fireEvent.keyDown(search(), { key: "Enter" });
  expect(effectNames()).toEqual([]);
  fireEvent.change(search(), { target: { value: "noise & grain" } });
  for (const name of ["Add Grain", "Dust & Scratches", "Fractal Noise", "Median", "Turbulent Noise"]) {
    expect(await libraryEffect("Noise & Grain", name, false)).toBeTruthy();
  }
  fireEvent.change(search(), { target: { value: "" } });
  const categories = within(library())
    .getAllByRole("treeitem")
    .filter((e) => e.getAttribute("aria-level") === "1")
    .map((e) => e.getAttribute("aria-label") ?? e.textContent);
  for (const category of ["3D Channel", "Audio", "Blur & Sharpen", "Color Correction", "Keying", "Matte", "Obsolete", "Perspective", "Simulation", "Transition", "Utility"]) {
    expect(categories).toContain(category);
  }

  // The Effect menu lists them too, unavailable.
  fireEvent.click(screen.getByRole("menuitem", { name: "Effect" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Blur & Sharpen/ }));
  const blurs = within(screen.getByRole("menu", { name: "Blur & Sharpen" }));
  expect(blurs.getByRole("menuitem", { name: /^Sharpen/ }).hasAttribute("disabled")).toBe(true);
  expect(blurs.getByRole("menuitem", { name: /^Fast Box Blur/ }).hasAttribute("disabled")).toBe(false);
});

test("plug-ins the viewer draws are listed under their vendors' categories; those with a template apply", async () => {
  await openComp(readFileSync(FIXTURE), "roundtrip.base.aep");
  fireEvent.click(screen.getByRole("tab", { name: /^Effect Controls/ }));

  fireEvent.change(search(), { target: { value: "s_shake" } });
  const shake = await libraryEffect("Sapphire Distort", "S_Shake");
  expect(shake.getAttribute("draggable")).toBe("true");
  expect(shake.textContent).not.toContain("Not rendered");
  fireEvent.doubleClick(shake);
  expect(effectNames()).toEqual(["S_Shake"]);

  fireEvent.change(search(), { target: { value: "sapphire" } });
  for (const [category, name] of [
    ["Sapphire Blur+Sharpen", "S_Blur"],
    ["Sapphire Lighting", "S_Glow"],
    ["Sapphire Lighting", "S_ZGlow"],
    ["Sapphire Adjust", "S_Flicker"],
  ]) {
    expect(await libraryEffect(category, name)).toBeTruthy();
  }

  // Form has a renderer but no template: listed, unavailable.
  fireEvent.change(search(), { target: { value: "trapcode" } });
  expect((await libraryEffect("RG Trapcode", "Form", false)).getAttribute("aria-disabled")).toBe("true");
  expect(await libraryEffect("RG Trapcode", "Particular")).toBeTruthy();

  fireEvent.click(screen.getByRole("menuitem", { name: "Effect" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Sapphire Distort/ }));
  fireEvent.click(within(screen.getByRole("menu", { name: "Sapphire Distort" })).getByRole("menuitem", { name: /^S_Shake/ }));
  expect(effectNames()).toEqual(["S_Shake", "S_Shake"]);

  const effects = savedEffects(await save(), COMP);
  expect(effects.map((e) => e.matchName)).toEqual(["S_Shake", "S_Shake"]);
});

test("effects the library lacks apply from the project's definitions; those the viewer does not draw are tagged Not rendered", async () => {
  await openComp(readFileSync(EFFECTS), "effects.aep", "effect_2dPoint", "TestLayer");
  fireEvent.click(screen.getByRole("tab", { name: /^Effect Controls/ }));
  const before = effectNames();
  fireEvent.change(search(), { target: { value: "lens flare" } });
  const listed = await libraryEffect("Generate", "Lens Flare");
  expect(listed.textContent).toContain("Not rendered");
  expect(listed.getAttribute("draggable")).toBe("true");
  fireEvent.doubleClick(listed);
  expect(effectNames()).toEqual([...before, "Lens Flare"]);
});

test("library effects the project defines too apply, from Used in This Project as well", async () => {
  await openComp(readFileSync(GAUSSIAN), "2_gaussian_20_30.aep", "Comp 1", "Gray Solid 1");
  fireEvent.click(screen.getByRole("tab", { name: /^Effect Controls/ }));
  const original = ["Gaussian Blur", "Gaussian Blur 2"];
  expect(effectNames()).toEqual(original);

  // Listed in its category, available, and not tagged as undrawn: the viewer renders Gaussian Blur.
  fireEvent.change(search(), { target: { value: "gaussian" } });
  const listed = await libraryEffect("Blur & Sharpen", "Gaussian Blur");
  expect(listed.getAttribute("draggable")).toBe("true");
  expect(listed.textContent).not.toContain("Not rendered");
  fireEvent.doubleClick(listed);
  expect(effectNames()).toEqual([...original, "Gaussian Blur"]);
  key("z", { ctrlKey: true });
  expect(effectNames()).toEqual(original);

  // Dragged from Used in This Project onto the layer's Timeline row.
  const used = within(library()).getByRole("treeitem", { name: "Used in This Project" });
  dragDrop(within(used).getByRole("treeitem", { name: "Gaussian Blur" }).querySelector(".fxp-row")!, layerRow("Gray Solid 1"));
  expect(effectNames()).toEqual([...original, "Gaussian Blur"]);

  // Effect > Blur & Sharpen > Gaussian Blur, enabled.
  fireEvent.click(screen.getByRole("menuitem", { name: "Effect" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Blur & Sharpen/ }));
  fireEvent.click(within(screen.getByRole("menu", { name: "Blur & Sharpen" })).getByRole("menuitem", { name: /^Gaussian Blur/ }));
  expect(effectNames()).toEqual([...original, "Gaussian Blur", "Gaussian Blur"]);

  // Saved, the originals keep their values and the added instances are at the template's default, 25, which After
  // Effects reports unmodified Gaussian Blurs at (py-aep's ExtendScript export of models/property/2_gaussian.aep).
  const effects = savedEffects(await save(), "Comp 1");
  const blurriness = (e: PropertyGroup) => e.children.find((c): c is Property => c.kind === "property" && c.matchName === "ADBE Gaussian Blur 2-0001")?.value;
  expect(effects.map((e) => e.matchName)).toEqual(Array(4).fill("ADBE Gaussian Blur 2"));
  expect(effects.map(blurriness)).toEqual([20, 30, 25, 25]);
});
