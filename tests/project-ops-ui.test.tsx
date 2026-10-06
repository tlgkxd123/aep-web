// @vitest-environment jsdom
import { File as NodeFile } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { parseProject } from "../src/aep/parse.ts";
import { footageStore } from "../src/media/store.ts";
import { App } from "../src/ui/App.tsx";

const refs = resolve("refs");

// jsdom's File cannot be read back; Node's can.
const file = (path: string) => new NodeFile([readFileSync(resolve(refs, path))], path.split("/").pop()!) as unknown as File;

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  footageStore.clear();
  vi.restoreAllMocks();
  delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
});

type Mods = { ctrl?: boolean; shift?: boolean; alt?: boolean };
const shortcut = (code: string, { ctrl = true, shift = false, alt = false }: Mods = {}) =>
  act(() => {
    fireEvent.keyDown(window, { key: code.replace(/^Key/, "").toLowerCase(), code, ctrlKey: ctrl, shiftKey: shift, altKey: alt });
  });

const tree = () => screen.getByRole("tree", { name: "Project items" });
const row = (name: string) =>
  within(tree())
    .getAllByText(name)
    .find((e) => e.classList.contains("cell-text"))!
    .closest<HTMLElement>('[role="treeitem"]')!;
const rowNames = () => within(tree()).queryAllByRole("treeitem").map((r) => r.querySelector(".cell-text")?.textContent);
const focusProject = () => fireEvent.pointerDown(tree());

/** A DataTransfer for drag-and-drop events (jsdom has none). */
function transfer(files: File[] = []) {
  const data = new Map<string, string>();
  return {
    files,
    items: [],
    get types() {
      return files.length ? ["Files"] : [...data.keys()];
    },
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    dropEffect: "none",
    effectAllowed: "all",
  };
}

async function startNewProject() {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "New Project" }));
  await screen.findByRole("tree", { name: "Project items" });
}

async function newComp(fields: Record<string, string> = {}) {
  shortcut("KeyN");
  const dialog = await screen.findByRole("dialog", { name: "Composition Settings" });
  for (const [label, value] of Object.entries(fields)) fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
  fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
  expect(screen.queryByRole("dialog", { name: "Composition Settings" })).toBeNull();
}

/** The browser's file dialog, answered with `picked`. */
function answerFileDialogs(picked: () => File[]) {
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
    if (this.type !== "file" || this.accept === ".aep") return;
    Object.defineProperty(this, "files", { value: picked(), configurable: true });
    this.dispatchEvent(new Event("change"));
  });
}

function openEditMenu() {
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  return screen.getByRole("menu", { name: "Edit" });
}

test("File > New > New Project opens an empty, unmodified project", async () => {
  render(<App />);
  fireEvent.click(screen.getByRole("menuitem", { name: "File" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "New" }));
  fireEvent.click(within(screen.getByRole("menu", { name: "New" })).getByRole("menuitem", { name: /^New Project/ }));
  await screen.findByRole("tree", { name: "Project items" });
  expect(rowNames()).toEqual([]);
  await waitFor(() => expect(document.title).toBe("Untitled Project.aep - AEP Web"));
});

test("New Composition creates the comp from the dialog, opens it, and undoes and redoes", async () => {
  await startNewProject();
  shortcut("KeyN");
  const dialog = await screen.findByRole("dialog", { name: "Composition Settings" });
  expect((within(dialog).getByLabelText("Composition Name:") as HTMLInputElement).value).toBe("Comp 1");
  expect((within(dialog).getByLabelText("Duration:") as HTMLInputElement).value).toBe("0:00:30:00");
  fireEvent.change(within(dialog).getByLabelText("Composition Name:"), { target: { value: "Main" } });
  fireEvent.change(within(dialog).getByLabelText("Width:"), { target: { value: "640" } });
  expect((within(dialog).getByLabelText("Height:") as HTMLInputElement).value).toBe("360");
  fireEvent.change(within(dialog).getByLabelText("Frame Rate:"), { target: { value: "25" } });
  fireEvent.change(within(dialog).getByLabelText("Duration:"), { target: { value: "500" } });
  expect(within(dialog).getByText(/is 0:00:05:00/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));

  expect(rowNames()).toEqual(["Main"]);
  expect(within(row("Main")).getByText("640 x 360")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Main" })).toBeTruthy();
  expect(document.title).toBe("Untitled Project.aep * - AEP Web");

  expect(within(openEditMenu()).getByRole("menuitem", { name: /^Undo New Composition/ })).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  shortcut("KeyZ");
  expect(rowNames()).toEqual([]);
  expect(screen.queryByRole("tab", { name: "Main" })).toBeNull();
  expect(document.title).toBe("Untitled Project.aep - AEP Web");
  shortcut("KeyZ", { shift: true });
  expect(rowNames()).toEqual(["Main"]);

  // AE remembers the last settings for the next New Composition.
  shortcut("KeyN");
  const next = await screen.findByRole("dialog", { name: "Composition Settings" });
  expect((within(next).getByLabelText("Composition Name:") as HTMLInputElement).value).toBe("Comp 1");
  expect((within(next).getByLabelText("Width:") as HTMLInputElement).value).toBe("640");
  expect((within(next).getByLabelText("Frame Rate:") as HTMLInputElement).value).toBe("25");
});

test("the dialog refuses settings AE would refuse", async () => {
  await startNewProject();
  shortcut("KeyN");
  const dialog = await screen.findByRole("dialog", { name: "Composition Settings" });
  fireEvent.change(within(dialog).getByLabelText("Width:"), { target: { value: "2" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
  expect(within(dialog).getByRole("alert").textContent).toMatch(/Width must be a whole number from 4 to 30000/);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(rowNames()).toEqual([]);
});

test("Composition Settings (Ctrl+K) changes the active comp undoably", async () => {
  await startNewProject();
  await newComp({ "Composition Name:": "Main", "Width:": "640" });
  shortcut("KeyK");
  const dialog = await screen.findByRole("dialog", { name: "Composition Settings" });
  expect((within(dialog).getByLabelText("Composition Name:") as HTMLInputElement).value).toBe("Main");
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.change(within(dialog).getByLabelText("Width:"), { target: { value: "800" } });
  fireEvent.change(within(dialog).getByLabelText("Composition Name:"), { target: { value: "Wide" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
  expect(within(row("Wide")).getByText("800 x 360")).toBeTruthy();
  shortcut("KeyZ");
  expect(within(row("Main")).getByText("640 x 360")).toBeTruthy();
});

test("folders: create and name, new items go inside, drag to the root, rename with Enter", async () => {
  await startNewProject();
  shortcut("KeyN", { alt: true, shift: true });
  const name = within(tree()).getByLabelText("Item name") as HTMLInputElement;
  expect(name.value).toBe("Untitled 1");
  fireEvent.change(name, { target: { value: "Shots" } });
  fireEvent.keyDown(name, { key: "Enter" });
  expect(rowNames()).toEqual(["Shots"]);

  await newComp({ "Composition Name:": "A" });
  expect(rowNames()).toEqual(["Shots", "A"]);
  expect(row("A").getAttribute("aria-level")).toBe("2");

  const dt = transfer();
  fireEvent.dragStart(row("A"), { dataTransfer: dt });
  const scroll = tree().closest<HTMLElement>(".proj-scroll")!;
  fireEvent.dragOver(scroll, { dataTransfer: dt });
  fireEvent.drop(scroll, { dataTransfer: dt });
  expect(row("A").getAttribute("aria-level")).toBe("1");

  fireEvent.dragStart(row("A"), { dataTransfer: dt });
  fireEvent.drop(row("Shots"), { dataTransfer: dt });
  expect(row("A").getAttribute("aria-level")).toBe("2");

  fireEvent.click(row("A"));
  fireEvent.keyDown(tree(), { key: "Enter" });
  const rename = within(tree()).getByLabelText("Item name");
  fireEvent.change(rename, { target: { value: "B" } });
  fireEvent.keyDown(rename, { key: "Enter" });
  expect(rowNames()).toEqual(["Shots", "B"]);
  expect(screen.getByRole("tab", { name: "B" })).toBeTruthy();
  expect(within(openEditMenu()).getByRole("menuitem", { name: /^Undo Rename Composition/ })).toBeTruthy();
});

test("a composition is renamed from its Timeline tab", async () => {
  await startNewProject();
  await newComp({ "Composition Name:": "Main" });
  fireEvent.doubleClick(screen.getByRole("tab", { name: "Main" }));
  const field = screen.getByLabelText("Rename Main");
  fireEvent.change(field, { target: { value: "Edit" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(rowNames()).toEqual(["Edit"]);
});

test("Ctrl+I imports picked files that render at once; dropping files imports into a folder; Alt-drop replaces", async () => {
  await startNewProject();
  answerFileDialogs(() => [file("media/straight.png"), file("media/photo.jpg")]);
  shortcut("KeyI");
  await waitFor(() => expect(rowNames()).toEqual(["photo.jpg", "straight.png"]));
  expect(within(row("straight.png")).getByText("PNG file")).toBeTruthy();
  expect(within(tree()).queryAllByLabelText("missing")).toHaveLength(0);
  expect(row("photo.jpg").getAttribute("aria-selected")).toBe("true");

  shortcut("KeyN", { alt: true, shift: true });
  fireEvent.keyDown(within(tree()).getByLabelText("Item name"), { key: "Enter" });
  const drop = transfer([file("media/still.bmp")]);
  fireEvent.dragOver(row("Untitled 1"), { dataTransfer: drop });
  fireEvent.drop(row("Untitled 1"), { dataTransfer: drop });
  await waitFor(() => expect(row("still.bmp").getAttribute("aria-level")).toBe("2"));

  // jsdom's drag events drop the modifier keys from their init dictionary.
  const altDrop = createEvent.drop(row("photo.jpg"), { dataTransfer: transfer([file("media/big.png")]) });
  Object.defineProperty(altDrop, "altKey", { value: true });
  fireEvent(row("photo.jpg"), altDrop);
  await waitFor(() => expect(within(tree()).queryByText("photo.jpg")).toBeNull());
  expect(within(row("big.png")).getByText("PNG file")).toBeTruthy();
  expect(within(openEditMenu()).getByRole("menuitem", { name: /^Undo Replace Footage/ })).toBeTruthy();
});

test("Ctrl+H replaces the selected footage with the picked file", async () => {
  await startNewProject();
  let picked = [file("media/photo.jpg")];
  answerFileDialogs(() => picked);
  shortcut("KeyI");
  await waitFor(() => expect(rowNames()).toEqual(["photo.jpg"]));
  picked = [file("media/still.bmp")];
  shortcut("KeyH");
  await waitFor(() => expect(rowNames()).toEqual(["still.bmp"]));
  shortcut("KeyZ");
  expect(rowNames()).toEqual(["photo.jpg"]);
});

test("deleting footage used in compositions warns, removes its layers, and undoes", async () => {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Open After Effects project"), {
    target: { files: [file("fixtures/projectops.aep")] },
  });
  await screen.findByRole("tree", { name: "Project items" });
  fireEvent.change(screen.getByLabelText("Search project"), { target: { value: "projectops_png" } });
  fireEvent.doubleClick(row("projectops_png"));
  const layers = () =>
    within(screen.getByRole("tree", { name: "Timeline layers" }))
      .queryAllByRole("treeitem")
      .filter((r) => r.getAttribute("aria-level") === "1");
  expect(layers().length).toBe(1);

  // Two items import straight.png (one is the Replace Footage target): select both with Ctrl-click.
  fireEvent.change(screen.getByLabelText("Search project"), { target: { value: "straight" } });
  const footageRows = () => within(tree()).queryAllByRole("treeitem").filter((r) => r.querySelector(".cell-text")?.textContent === "straight.png");
  const [first, second] = footageRows();
  expect(footageRows()).toHaveLength(2);
  fireEvent.click(first);
  fireEvent.click(second, { ctrlKey: true });
  expect(within(tree()).getAllByRole("treeitem").filter((r) => r.getAttribute("aria-selected") === "true")).toHaveLength(2);
  focusProject();
  fireEvent.keyDown(tree(), { key: "Delete" });
  const warning = screen.getByRole("alertdialog");
  expect(warning.textContent).toMatch(/The selected items are used \d+ times in \d+ compositions\. Delete anyway\?/);
  fireEvent.click(within(warning).getByRole("button", { name: "Delete" }));
  expect(footageRows()).toHaveLength(0);
  expect(layers().length).toBe(0);

  shortcut("KeyZ");
  expect(footageRows()).toHaveLength(2);
  expect(layers().length).toBe(1);
});

test("Ctrl+D in the Project panel duplicates the selected composition", async () => {
  await startNewProject();
  await newComp({ "Composition Name:": "Main" });
  fireEvent.click(row("Main"));
  focusProject();
  shortcut("KeyD");
  expect(rowNames()).toEqual(["Main", "Main 2"]);
  expect(row("Main 2").getAttribute("aria-selected")).toBe("true");
});

test("Save without a file picker downloads the project, which parses with the new comp", async () => {
  await startNewProject();
  await newComp({ "Composition Name:": "Saved" });
  let saved: Blob | undefined;
  URL.createObjectURL = vi.fn((blob: Blob) => ((saved = blob), "blob:project"));
  URL.revokeObjectURL = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  shortcut("KeyS");
  await waitFor(() => expect(document.title).toBe("Untitled Project.aep - AEP Web"));
  expect(click).toHaveBeenCalled();
  const bytes = await new Promise<Uint8Array>((done) => {
    const reader = new FileReader();
    reader.onload = () => done(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(saved!);
  });
  const names = [...parseProject(bytes).items.values()].map((i) => i.name);
  expect(names).toEqual(["Saved"]);
});

test("Save As writes through the file picker and Save then writes to the same file", async () => {
  await startNewProject();
  await newComp();
  const writes: Uint8Array[] = [];
  const handle = {
    name: "mine.aep",
    getFile: async () => new File([], "mine.aep"),
    createWritable: async () => ({ write: async (data: Uint8Array) => void writes.push(data), close: async () => {} }),
  };
  const picker = vi.fn(async () => handle);
  (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = picker;
  shortcut("KeyS", { shift: true });
  await waitFor(() => expect(document.title).toBe("mine.aep - AEP Web"));
  shortcut("KeyN", { alt: true, shift: true });
  fireEvent.keyDown(within(tree()).getByLabelText("Item name"), { key: "Escape" });
  expect(document.title).toBe("mine.aep * - AEP Web");
  shortcut("KeyS");
  await waitFor(() => expect(document.title).toBe("mine.aep - AEP Web"));
  expect(picker).toHaveBeenCalledTimes(1);
  expect(writes).toHaveLength(2);
  expect([...parseProject(writes[1]).items.values()].map((i) => i.kind).sort()).toEqual(["comp", "folder"]);
});

test("New Project asks to save unsaved changes first", async () => {
  await startNewProject();
  await newComp({ "Composition Name:": "Keep" });
  shortcut("KeyN", { alt: true });
  let prompt = screen.getByRole("alertdialog");
  expect(prompt.textContent).toContain('Save changes to "Untitled Project.aep" before closing?');
  fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
  expect(rowNames()).toEqual(["Keep"]);
  shortcut("KeyN", { alt: true });
  prompt = screen.getByRole("alertdialog");
  fireEvent.click(within(prompt).getByRole("button", { name: "Don't Save" }));
  await waitFor(() => expect(rowNames()).toEqual([]));
});
