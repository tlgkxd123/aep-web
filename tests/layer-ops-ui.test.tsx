// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { App } from "../src/ui/App.tsx";

// layerops_holder (160x120) opens first: "layerops small" 320x160, "layerops tall" 60x180, "layerops wide" 200x50, all centred.
const FIXTURE = resolve(import.meta.dirname, "../refs/fixtures/layerops.base.aep");

afterEach(cleanup);

// jsdom has neither: without them fireEvent drops clientX / clientY from pointer and drag events.
for (const name of ["PointerEvent", "DragEvent"] as const) {
  if (typeof window[name] === "undefined") {
    Object.defineProperty(window, name, { configurable: true, value: class extends MouseEvent {} });
  }
}

async function openFixture(): Promise<HTMLElement> {
  render(<App />);
  const file = new File([readFileSync(FIXTURE)], "layerops.base.aep");
  fireEvent.change(screen.getByLabelText("Open After Effects project"), { target: { files: [file] } });
  return screen.findByRole("tree", { name: "Timeline layers" });
}

const tree = () => screen.getByRole("tree", { name: "Timeline layers" });
const layerNames = () => Array.from(tree().querySelectorAll<HTMLElement>(".tl-layer")).map((row) => row.getAttribute("aria-label"));
const row = (name: string) => within(tree()).getByRole("treeitem", { name });
const key = (k: string, mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {}) => fireEvent.keyDown(window, { key: k, ...mods });

/** Opens menu path[0] and clicks through; item names start with their label and end with the shortcut. */
function menu(...path: string[]) {
  fireEvent.click(screen.getByRole("menuitem", { name: path[0] }));
  for (const name of path.slice(1)) fireEvent.click(screen.getAllByRole("menuitem", { name: new RegExp(`^${name}`) }).at(-1)!);
}

function expandTransform(layer: string) {
  fireEvent.click(within(tree()).getByRole("button", { name: `Expand ${layer}` }));
  fireEvent.click(within(tree()).getByRole("button", { name: "Expand Transform" }));
}

const value = (label: string) => Number(within(tree()).getByRole("spinbutton", { name: label }).getAttribute("aria-valuenow"));
const close = (actual: number, expected: number) => expect(actual).toBeCloseTo(expected, 3);

/** The viewer's SVG laid out at 1 client pixel per comp pixel, so pointer positions are comp coordinates. */
function viewer(): SVGSVGElement {
  const svg = screen.getByRole("img", { name: /^layerops_holder, 160 x 120/ }) as unknown as SVGSVGElement;
  const rect = { left: 0, top: 0, width: 160, height: 120, right: 160, bottom: 120, x: 0, y: 0, toJSON: () => ({}) };
  Object.defineProperty(svg, "getBoundingClientRect", { configurable: true, value: () => rect });
  return svg;
}

function drag(target: Element, from: [number, number], ...to: [number, number, { shiftKey?: boolean; altKey?: boolean }?][]) {
  fireEvent.pointerDown(target, { clientX: from[0], clientY: from[1], button: 0 });
  for (const [x, y, mods] of to) fireEvent.pointerMove(window, { clientX: x, clientY: y, ...mods });
  fireEvent.pointerUp(window);
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

const ORIGINAL = ["layerops small", "layerops tall", "layerops wide"];

test("Layer > New > Null Object adds a null at the top, and Ctrl+Z / Ctrl+Shift+Z undo and redo it", async () => {
  await openFixture();
  expect(layerNames()).toEqual(ORIGINAL);

  menu("Layer", "New", "Null Object");
  expect(layerNames()).toEqual(["Null 1", ...ORIGINAL]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  expect(screen.getByRole("menuitem", { name: /^Undo New Null Object/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));

  key("z", { ctrlKey: true });
  expect(layerNames()).toEqual(ORIGINAL);
  key("z", { ctrlKey: true, shiftKey: true });
  expect(layerNames()).toEqual(["Null 1", ...ORIGINAL]);

  key("y", { ctrlKey: true, altKey: true });
  expect(layerNames()[0]).toBe("Adjustment Layer 1");
  menu("Layer", "New", "Shape Layer");
  expect(layerNames()[0]).toBe("Shape Layer 1");
});

test("Ctrl+Y opens Solid Settings at the comp size; Make Comp Size restores it; OK adds the layer and its Solids item", async () => {
  await openFixture();
  key("y", { ctrlKey: true });
  const dialog = screen.getByRole("dialog", { name: "Solid Settings" });
  const width = within(dialog).getByLabelText("Width") as HTMLInputElement;
  const height = within(dialog).getByLabelText("Height") as HTMLInputElement;
  expect([width.value, height.value]).toEqual(["160", "120"]);
  expect(within(dialog).getAllByText("4:3 (1.33)").length).toBeGreaterThan(0);

  fireEvent.change(width, { target: { value: "300" } });
  expect(within(dialog).getByText("187.5% of comp")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Make Comp Size" }));
  expect(width.value).toBe("160");

  fireEvent.change(within(dialog).getByLabelText("Solid color"), { target: { value: "#ff0000" } });
  expect((within(dialog).getByLabelText("Name:") as HTMLInputElement).value).toBe("Red Solid 1");
  fireEvent.change(within(dialog).getByLabelText("Name:"), { target: { value: "Plate" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));

  expect(screen.queryByRole("dialog", { name: "Solid Settings" })).toBeNull();
  expect(layerNames()).toEqual(["Plate", ...ORIGINAL]);
  // The fixture was saved by a German AE: its Solids folder (named by the project's sfnm chunk) is "Farbflächen".
  const items = screen.getByRole("tree", { name: "Project items" });
  fireEvent.doubleClick(within(items).getByText("Farbflächen"));
  expect(within(items).getByText("Plate")).toBeTruthy();

  key("z", { ctrlKey: true });
  expect(layerNames()).toEqual(ORIGINAL);
  expect(within(items).queryByText("Plate")).toBeNull();
});

test("Enter renames; Ctrl+D duplicates above; Ctrl+Shift+[ / Ctrl+] restack; Delete removes", async () => {
  await openFixture();
  fireEvent.click(row("layerops tall"));
  fireEvent.keyDown(tree(), { key: "Enter" });
  const input = within(tree()).getByLabelText("Layer name");
  fireEvent.change(input, { target: { value: "Arm" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(layerNames()).toEqual(["layerops small", "Arm", "layerops wide"]);

  key("d", { ctrlKey: true });
  expect(layerNames()).toEqual(["layerops small", "Arm 2", "Arm", "layerops wide"]);
  expect(row("Arm 2").getAttribute("aria-selected")).toBe("true");

  key("[", { ctrlKey: true, shiftKey: true });
  expect(layerNames()).toEqual(["layerops small", "Arm", "layerops wide", "Arm 2"]);
  key("Delete");
  expect(layerNames()).toEqual(["layerops small", "Arm", "layerops wide"]);

  fireEvent.click(row("Arm"));
  key("]", { ctrlKey: true });
  expect(layerNames()).toEqual(["Arm", "layerops small", "layerops wide"]);
  key("z", { ctrlKey: true });
  expect(layerNames()).toEqual(["layerops small", "Arm", "layerops wide"]);
});

test("dragging a Timeline row restacks it; dragging a Project item into the Timeline adds a layer at the drop slot", async () => {
  await openFixture();
  const moving = dataTransfer();
  fireEvent.dragStart(row("layerops wide"), { dataTransfer: moving });
  fireEvent.dragOver(row("layerops small"), { dataTransfer: moving, clientY: -1 });
  expect(row("layerops small").className).toContain("drop-before");
  fireEvent.drop(row("layerops small"), { dataTransfer: moving, clientY: -1 });
  expect(layerNames()).toEqual(["layerops wide", "layerops small", "layerops tall"]);

  const items = screen.getByRole("tree", { name: "Project items" });
  const adding = dataTransfer();
  fireEvent.dragStart(within(items).getByText("layerops_card").closest('[role="treeitem"]')!, { dataTransfer: adding });
  fireEvent.dragOver(row("layerops tall"), { dataTransfer: adding, clientY: 1 });
  fireEvent.drop(row("layerops tall"), { dataTransfer: adding, clientY: 1 });
  expect(layerNames()).toEqual(["layerops wide", "layerops small", "layerops tall", "layerops_card"]);
  expect(row("layerops_card").getAttribute("aria-selected")).toBe("true");
});

test("a Project item dropped on the Composition panel is centred at the drop point at the top of the stack", async () => {
  await openFixture();
  const svg = viewer();
  const adding = dataTransfer();
  const items = screen.getByRole("tree", { name: "Project items" });
  fireEvent.dragStart(within(items).getByText("layerops_card").closest('[role="treeitem"]')!, { dataTransfer: adding });
  fireEvent.dragOver(svg, { dataTransfer: adding, clientX: 30, clientY: 20 });
  fireEvent.drop(svg, { dataTransfer: adding, clientX: 30, clientY: 20 });
  expect(layerNames()[0]).toBe("layerops_card");
  expandTransform("layerops_card");
  close(value("Position X"), 30);
  close(value("Position Y"), 20);
  close(value("Anchor Point X"), 40);
});

test("Selection tool drags move Position live as one undo step, Shift constrains, and arrow keys nudge", async () => {
  await openFixture();
  expandTransform("layerops small");
  const [x0, y0] = [value("Position X"), value("Position Y")];

  drag(viewer(), [80, 60], [90, 65], [110, 64]);
  expect(row("layerops small").getAttribute("aria-selected")).toBe("true");
  close(value("Position X"), x0 + 30);
  close(value("Position Y"), y0 + 4);
  key("z", { ctrlKey: true });
  close(value("Position X"), x0);
  close(value("Position Y"), y0);

  drag(viewer(), [80, 60], [110, 64, { shiftKey: true }]);
  close(value("Position X"), x0 + 30);
  close(value("Position Y"), y0);

  fireEvent.pointerDown(screen.getByRole("img", { name: /^layerops_holder/ }).closest("section")!);
  key("ArrowRight", { shiftKey: true });
  key("ArrowUp");
  close(value("Position X"), x0 + 40);
  close(value("Position Y"), y0 - 1);
});

test("handles scale around the anchor (Shift keeps the aspect), the Rotation tool turns and Pan Behind moves the anchor point", async () => {
  await openFixture();
  expandTransform("layerops small");
  drag(viewer(), [80, 60]);
  const corner = viewer().querySelector('[data-handle="1,1"] .sel-grip')!;
  expect(corner).toBeTruthy();
  // The bottom-right corner sits 160, 80 from the anchor: dragging it 160, 80 further doubles the size.
  drag(corner, [240, 140], [400, 220]);
  close(value("Scale X"), 200);
  close(value("Scale Y"), 200);
  key("z", { ctrlKey: true });

  const side = viewer().querySelector('[data-handle="1,0"] .sel-grip')!;
  drag(side, [240, 60], [400, 60]);
  close(value("Scale X"), 200);
  close(value("Scale Y"), 100);
  key("z", { ctrlKey: true });
  drag(viewer().querySelector('[data-handle="1,0"] .sel-grip')!, [240, 60], [400, 60, { shiftKey: true }]);
  close(value("Scale X"), 200);
  close(value("Scale Y"), 200);
  key("z", { ctrlKey: true });

  key("w");
  expect(screen.getByRole("button", { name: "Rotation Tool" }).getAttribute("aria-pressed")).toBe("true");
  drag(viewer(), [180, 60], [80, 160]);
  close(value("Rotation degrees"), 90);
  key("z", { ctrlKey: true });
  drag(viewer(), [180, 60], [180, 150, { shiftKey: true }]);
  close(value("Rotation degrees"), 45);
  key("z", { ctrlKey: true });

  key("y");
  const [ax, px] = [value("Anchor Point X"), value("Position X")];
  drag(viewer(), [80, 60], [90, 60]);
  close(value("Anchor Point X"), ax + 10);
  close(value("Position X"), px + 10);
  key("z", { ctrlKey: true });
  drag(viewer(), [80, 60], [90, 60, { altKey: true }]);
  close(value("Anchor Point X"), ax + 10);
  close(value("Position X"), px);
});

test("Fit to Comp shortcuts, Transform scrubbing with the Scale link, typed values and the stopwatch", async () => {
  await openFixture();
  fireEvent.click(row("layerops wide"));
  expandTransform("layerops wide");
  key("f", { ctrlKey: true, altKey: true });
  close(value("Scale X"), 80);
  close(value("Scale Y"), 240);
  key("h", { ctrlKey: true, altKey: true, shiftKey: true });
  close(value("Scale X"), 80);
  close(value("Scale Y"), 80);

  drag(within(tree()).getByRole("spinbutton", { name: "Scale X" }), [0, 0], [20, 0]);
  close(value("Scale X"), 100);
  close(value("Scale Y"), 100);
  key("z", { ctrlKey: true });
  close(value("Scale X"), 80);

  fireEvent.click(within(tree()).getByRole("button", { name: "Constrain Proportions" }));
  drag(within(tree()).getByRole("spinbutton", { name: "Scale X" }), [0, 0], [10, 0, { shiftKey: true }]);
  close(value("Scale X"), 180);
  close(value("Scale Y"), 80);

  drag(within(tree()).getByRole("spinbutton", { name: "Opacity" }), [0, 0]);
  const field = within(tree()).getByRole("textbox", { name: "Opacity" });
  fireEvent.change(field, { target: { value: "35" } });
  fireEvent.keyDown(field, { key: "Enter" });
  close(value("Opacity"), 35);

  const position = within(tree()).getByRole("treeitem", { name: "Position" });
  fireEvent.click(within(position).getByRole("button", { name: "Stopwatch off" }));
  expect(within(within(tree()).getByRole("treeitem", { name: "Position" })).getByRole("button", { name: "Stopwatch on (animated)" })).toBeTruthy();
  expect(within(tree()).getAllByRole("button", { name: /^Position keyframe at / })).toHaveLength(1);
});
