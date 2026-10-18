// @vitest-environment jsdom
import { File as NodeFile } from "node:buffer";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { addLayer } from "../src/edit/layers.ts";
import { DEFAULT_COMP_SETTINGS, newComposition, newProject } from "../src/edit/project.ts";
import { footageStore } from "../src/media/store.ts";
import { readLocal } from "../src/media/localFootage.ts";
import { App } from "../src/ui/App.tsx";
import { ImportDialog } from "../src/ui/ImportDialog.tsx";

beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, String(value)),
    removeItem: (key: string) => data.delete(key),
    clear: () => data.clear(),
  });
});
afterEach(() => {
  cleanup();
  footageStore.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.querySelector('meta[name="aep-local-footage"]')?.remove();
});

const tree = () => screen.getByRole("tree", { name: "Project items" });
const row = (name: string) => within(tree()).getAllByText(name).find((e) => e.classList.contains("cell-text"))!.closest<HTMLElement>('[role="treeitem"]')!;
const key = (code: string, shift = false) => act(() => {
  fireEvent.keyDown(window, { code, key: code.slice(3).toLowerCase(), ctrlKey: true, shiftKey: shift });
});
const file = (data: Uint8Array, name: string) => new NodeFile([data], name) as unknown as File;
function incoming() {
  const editor = newProject();
  const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: "Imported Comp", width: 160, height: 120, duration: 2 });
  addLayer(editor, comp, { kind: "solid", name: "Imported Solid", color: [0, 1, 0], width: 64, height: 64 });
  return file(editor.save(), "Packet.aep");
}
async function start() {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "New Project" }));
  await screen.findByRole("tree", { name: "Project items" });
  key("KeyN");
  const dialog = await screen.findByRole("dialog", { name: "Composition Settings" });
  fireEvent.change(within(dialog).getByLabelText("Composition Name:"), { target: { value: "Host" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
}
function pick(files: File[]) {
  return vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function(this: HTMLInputElement) {
    if (this.type !== "file" || this.getAttribute("aria-label") === "Open After Effects project") return;
    expect(this.accept).toContain(".aep");
    Object.defineProperty(this, "files", { value: files, configurable: true });
    this.dispatchEvent(new Event("change"));
  });
}
const transfer = (files: File[]) => ({ files, items: [], types: ["Files"], getData: () => "", dropEffect: "copy" });

test("Ctrl+I imports native comps alongside footage, keeps the current comp open, and undoes as one command", async () => {
  await start();
  pick([incoming(), file(new Uint8Array(readFileSync("refs/media/straight.png")), "straight.png")]);
  key("KeyI");
  await waitFor(() => expect(row("Packet")).toBeTruthy());
  expect(row("Host")).toBeTruthy();
  expect(row("straight.png")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Host" })).toBeTruthy();
  expect(document.title).toBe("Untitled Project.aep * - AEP Web");
  fireEvent.click(row("Packet").querySelector(".twirl")!);
  expect(row("Imported Comp").getAttribute("aria-level")).toBe("2");
  fireEvent.doubleClick(row("Imported Comp"));
  expect(await screen.findByRole("tab", { name: "Imported Comp" })).toBeTruthy();
  expect(screen.getAllByText("Imported Solid").length).toBeGreaterThan(0);
  key("KeyZ");
  expect(within(tree()).queryByText("Packet")).toBeNull();
  expect(within(tree()).queryByText("straight.png")).toBeNull();
  expect(row("Host")).toBeTruthy();
  key("KeyZ", true);
  expect(row("Packet")).toBeTruthy();
});

test("a project dropped into a Project panel folder imports there without replacing the session", async () => {
  await start();
  fireEvent.keyDown(window, { key: "n", code: "KeyN", ctrlKey: true, shiftKey: true, altKey: true });
  fireEvent.keyDown(within(tree()).getByLabelText("Item name"), { key: "Enter" });
  fireEvent.drop(row("Untitled 1"), { dataTransfer: transfer([incoming()]) });
  await waitFor(() => expect(row("Packet").getAttribute("aria-level")).toBe("2"));
  expect(screen.getByRole("tab", { name: "Host" })).toBeTruthy();
  expect(row("Host")).toBeTruthy();
});

test("a project dropped onto the workspace imports instead of opening over the current project", async () => {
  await start();
  fireEvent.drop(screen.getByRole("tab", { name: "Host" }), { dataTransfer: transfer([incoming()]) });
  await waitFor(() => expect(row("Packet")).toBeTruthy());
  expect(screen.getByRole("tab", { name: "Host" })).toBeTruthy();
  expect(row("Host")).toBeTruthy();
});

test("a bad project in a multi-file import adds nothing and leaves the current project open", async () => {
  await start();
  pick([incoming(), file(new TextEncoder().encode("not an aep"), "Broken.aep")]);
  key("KeyI");
  expect(await screen.findByText(/missing RIFX header/)).toBeTruthy();
  expect(within(tree()).queryByText("Packet")).toBeNull();
  expect(row("Host")).toBeTruthy();
  expect(screen.getByRole("tab", { name: "Host" })).toBeTruthy();
});

test("the local import browser lists AEP files as projects; replacement keeps its footage filter", async () => {
  document.head.insertAdjacentHTML("beforeend", '<meta name="aep-local-footage" content="test">');
  const listing = { dir: "C:/Templates", parent: "C:/", entries: [{ name: "Packet.aep", path: "C:/Templates/Packet.aep", folder: false }] };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => listing }));
  const choose = vi.fn();
  const { rerender } = render(<ImportDialog title="Import File" action="Import" multiple projects onChoose={choose} onSystemDialog={() => {}} onCancel={() => {}} />);
  fireEvent.click(await screen.findByRole("option", { name: /Packet.aep/ }));
  expect(screen.getByText("Project", { selector: ".imp-foot span" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Import" }));
  expect(choose).toHaveBeenCalledWith(["C:/Templates/Packet.aep"]);
  rerender(<ImportDialog title="Replace" action="Replace" multiple={false} onChoose={choose} onSystemDialog={() => {}} onCancel={() => {}} />);
  expect(screen.queryByRole("option", { name: /Packet.aep/ })).toBeNull();
});

test("local project reads retain their file identity so footage can be located beside the imported AEP", async () => {
  const modified = "Fri, 16 Oct 2026 12:00:00 GMT";
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["data"]), headers: new Headers({ "Last-Modified": modified }) }));
  const project = await readLocal("C:/Templates/Packet.aep");
  expect(project.name).toBe("Packet.aep");
  expect(project.lastModified).toBe(Date.parse(modified));
});
