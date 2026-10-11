// @vitest-environment jsdom
// The menu bar's and context menus' commands, driven through the app as a user would.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../src/ui/App.tsx";

// layerops_holder (160x120, 24 fps, 1 s) opens first with "layerops small", "layerops tall", "layerops wide".
const FIXTURE = resolve(import.meta.dirname, "../refs/fixtures/layerops.base.aep");
const ORIGINAL = ["layerops small", "layerops tall", "layerops wide"];

afterEach(cleanup);

for (const name of ["PointerEvent", "DragEvent"] as const) {
  if (typeof window[name] === "undefined") {
    Object.defineProperty(window, name, { configurable: true, value: class extends MouseEvent {} });
  }
}

async function openFixture(): Promise<void> {
  render(<App />);
  const file = new File([readFileSync(FIXTURE)], "layerops.base.aep");
  fireEvent.change(screen.getByLabelText("Open After Effects project"), { target: { files: [file] } });
  await screen.findByRole("tree", { name: "Timeline layers" });
}

const tree = () => screen.getByRole("tree", { name: "Timeline layers" });
const layerNames = () => Array.from(tree().querySelectorAll<HTMLElement>(".tl-layer")).map((row) => row.getAttribute("aria-label"));
const row = (name: string) => within(tree()).getAllByRole("treeitem", { name })[0];
/** The entry labelled `name` in the open menus (checkable or not), the innermost when several match. */
function entry(name: string): HTMLElement {
  const found = [...screen.queryAllByRole("menuitem"), ...screen.queryAllByRole("menuitemcheckbox")].filter(
    (e) => (e.querySelector(".menu-label")?.textContent ?? e.textContent) === name,
  );
  if (!found.length) throw new Error(`no menu entry "${name}"`);
  return found.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)).at(-1)!;
}

/** Opens menu bar menu path[0] and clicks through the rest. */
function menu(...path: string[]) {
  fireEvent.click(screen.getByRole("menuitem", { name: path[0] }));
  for (const name of path.slice(1)) fireEvent.click(entry(name));
}

/** Opens path[0..n-1] and returns the last entry without clicking it. */
function peek(...path: string[]): HTMLElement {
  fireEvent.click(screen.getByRole("menuitem", { name: path[0] }));
  for (const name of path.slice(1, -1)) fireEvent.click(entry(name));
  return entry(path.at(-1)!);
}

const closeMenus = () => fireEvent.keyDown(window, { key: "Escape" });

function expandTransform(layer: string) {
  fireEvent.click(within(tree()).getByRole("button", { name: `Expand ${layer}` }));
  fireEvent.click(within(tree()).getByRole("button", { name: "Expand Transform" }));
}
const value = (label: string) => Number(within(tree()).getByRole("spinbutton", { name: label }).getAttribute("aria-valuenow"));

test("Layer > Label, Blending Mode and Switches act on the selected layer and show its state", async () => {
  await openFixture();
  expect((peek("Edit", "Label") as HTMLButtonElement).disabled).toBe(true);
  closeMenus();

  fireEvent.click(row("layerops tall"));
  menu("Edit", "Label", "Green");
  expect(peek("Edit", "Label", "Green").getAttribute("aria-checked")).toBe("true");
  closeMenus();

  menu("Layer", "Blending Mode", "Multiply");
  expect(peek("Layer", "Blending Mode", "Multiply").getAttribute("aria-checked")).toBe("true");
  closeMenus();
  fireEvent.keyDown(window, { key: "+", code: "Equal", shiftKey: true });
  expect(peek("Layer", "Blending Mode", "Color Burn").getAttribute("aria-checked")).toBe("true");
  closeMenus();

  menu("Layer", "3D Layer");
  expect(peek("Layer", "3D Layer").getAttribute("aria-checked")).toBe("true");
  closeMenus();
  menu("Layer", "Switches", "Shy");
  expect(peek("Layer", "Switches", "Shy").getAttribute("aria-checked")).toBe("true");
  closeMenus();

  // Edit > History lists the commands; picking the first undoes the rest.
  const history = () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    fireEvent.click(entry("History"));
    const list = screen.getAllByRole("menu", { name: "History" }).at(-1)!;
    return within(list).getAllByRole("menuitemcheckbox").map((e) => e.textContent);
  };
  expect(history()).toEqual(["Change label", "Change blending mode", "Change blending mode", "Enable threeDLayer", "Enable shy"]);
  fireEvent.click(entry("Change label"));
  expect(peek("Layer", "3D Layer").getAttribute("aria-checked")).toBe("false");
  expect(peek("Edit", "Label", "Green").getAttribute("aria-checked")).toBe("true");
});

test("View > Go To Time moves the playhead; Edit > Split Layer, Copy and Paste work on the selected layer", async () => {
  await openFixture();
  fireEvent.click(row("layerops tall"));
  menu("View", "Go To Time...");
  const dialog = screen.getByRole("dialog", { name: "Go to Time" });
  fireEvent.change(within(dialog).getByLabelText("Time:"), { target: { value: "12" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
  expect(screen.queryByRole("dialog", { name: "Go to Time" })).toBeNull();

  menu("Edit", "Split Layer");
  expect(layerNames()).toEqual(["layerops small", "layerops tall", "layerops tall", "layerops wide"]);
  fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
  expect(layerNames()).toEqual(ORIGINAL);

  fireEvent.click(row("layerops wide"));
  expect((peek("Edit", "Paste") as HTMLButtonElement).disabled).toBe(true);
  closeMenus();
  menu("Edit", "Copy");
  fireEvent.click(row("layerops small"));
  menu("Edit", "Paste");
  expect(layerNames()).toEqual(["layerops wide", "layerops small", "layerops tall", "layerops wide"]);
  fireEvent.keyDown(window, { key: "x", code: "KeyX", ctrlKey: true });
  expect(layerNames()).toEqual(["layerops small", "layerops tall", "layerops wide"]);
  fireEvent.keyDown(window, { key: "v", code: "KeyV", ctrlKey: true });
  expect(layerNames()).toEqual(["layerops wide", "layerops small", "layerops tall", "layerops wide"]);
});

test("Layer > Transform value dialogs set the property, from the menu bar and the layer's context menu", async () => {
  await openFixture();
  fireEvent.click(row("layerops wide"));
  menu("Layer", "Transform", "Opacity...");
  let dialog = screen.getByRole("dialog", { name: "Opacity" });
  const field = within(dialog).getByLabelText("Opacity:") as HTMLInputElement;
  expect(field.value).toBe("100");
  fireEvent.change(field, { target: { value: "40" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
  expandTransform("layerops wide");
  expect(value("Opacity")).toBe(40);

  fireEvent.contextMenu(row("layerops wide"));
  fireEvent.click(entry("Transform"));
  fireEvent.click(entry("Rotation..."));
  dialog = screen.getByRole("dialog", { name: "Rotation" });
  fireEvent.change(within(dialog).getByLabelText("Degrees:"), { target: { value: "30" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
  expect(value("Rotation degrees")).toBe(30);

  fireEvent.keyDown(window, { key: "o", code: "KeyO", ctrlKey: true, shiftKey: true });
  expect(screen.getByRole("dialog", { name: "Opacity" })).toBeTruthy();
  fireEvent.click(within(screen.getByRole("dialog", { name: "Opacity" })).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "Opacity" })).toBeNull();
});

test("Layer > Layer Settings renames; File > Close closes the comp; Help opens its pages and the shortcut list", async () => {
  await openFixture();
  fireEvent.click(row("layerops small"));
  menu("Layer", "Layer Settings...");
  const settings = screen.getByRole("dialog", { name: "Layer Settings" });
  fireEvent.change(within(settings).getByLabelText("Name:"), { target: { value: "tiny" } });
  fireEvent.click(within(settings).getByRole("button", { name: "OK" }));
  expect(layerNames()).toEqual(["tiny", "layerops tall", "layerops wide"]);

  const opened = vi.spyOn(window, "open").mockImplementation(() => null);
  menu("Help", "Expression Reference");
  expect(opened).toHaveBeenCalledWith(expect.stringContaining("expression-language-reference"), "_blank", "noopener,noreferrer");
  opened.mockRestore();

  menu("Help", "Keyboard Shortcuts");
  const list = screen.getByRole("dialog", { name: "Keyboard Shortcuts" });
  expect(within(list).getByText("Split Layer")).toBeTruthy();
  fireEvent.click(within(list).getByRole("button", { name: "OK" }));

  menu("Window", "Workspace", "Review");
  expect(screen.getByRole("button", { name: /Review/ }).getAttribute("aria-current")).toBe("true");

  menu("File", "Close");
  expect(screen.queryByRole("tree", { name: "Timeline layers" })).toBeNull();
  expect(screen.getByText(/No composition is open/)).toBeTruthy();
});

test("the Project panel's context menu makes a comp from a footage item and labels it", async () => {
  await openFixture();
  const projectItems = screen.getByRole("tree", { name: "Project items" });
  fireEvent.doubleClick(within(projectItems).getByText("Farbflächen"));
  const solid = within(projectItems).getByText("layerops card bg");
  fireEvent.click(solid);
  fireEvent.contextMenu(solid);
  fireEvent.click(entry("New Comp from Selection"));
  expect(await screen.findByRole("img", { name: /^layerops card bg, \d+ x \d+/ })).toBeTruthy();
  expect(layerNames()).toEqual(["layerops card bg"]);

  fireEvent.contextMenu(within(projectItems).getAllByText("layerops card bg")[0]);
  fireEvent.click(entry("Label"));
  fireEvent.click(entry("Blue"));
  fireEvent.contextMenu(within(projectItems).getAllByText("layerops card bg")[0]);
  fireEvent.click(entry("Label"));
  expect(entry("Blue").getAttribute("aria-checked")).toBe("true");
});

test("Composition > Trim Comp to Work Area and the View menu's viewer settings", async () => {
  await openFixture();
  expect((peek("Composition", "Trim Comp to Work Area") as HTMLButtonElement).disabled).toBe(true);
  closeMenus();
  menu("View", "Go To Time...");
  const dialog = screen.getByRole("dialog", { name: "Go to Time" });
  fireEvent.change(within(dialog).getByLabelText("Time:"), { target: { value: "12" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
  fireEvent.keyDown(window, { key: "b", code: "KeyB" });
  menu("Composition", "Trim Comp to Work Area");
  expect((peek("Composition", "Trim Comp to Work Area") as HTMLButtonElement).disabled).toBe(true);
  closeMenus();
  expect(screen.getByRole("img", { name: /^layerops_holder, 160 x 120, at 0:00:00:12/ })).toBeTruthy();
  expect(screen.getByTitle("layerops wide: 0:00:00:00 – 0:00:01:00")).toBeTruthy();
  fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
  expect((peek("Composition", "Trim Comp to Work Area") as HTMLButtonElement).disabled).toBe(false);
  closeMenus();

  expect(peek("View", "Show Grid").getAttribute("aria-checked")).toBe("false");
  fireEvent.click(entry("Show Grid"));
  expect(peek("View", "Show Grid").getAttribute("aria-checked")).toBe("true");
  closeMenus();
  expect(peek("View", "Show Layer Controls").getAttribute("aria-checked")).toBe("true");
  fireEvent.click(entry("Show Layer Controls"));
  expect(peek("View", "Show Layer Controls").getAttribute("aria-checked")).toBe("false");
  closeMenus();
  expect((peek("View", "Zoom In") as HTMLButtonElement).disabled).toBe(false);
});
