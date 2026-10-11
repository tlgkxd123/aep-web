// @vitest-environment jsdom
// On a phone-sized screen the app shows the compact workspace: the viewer over one panel at a time, picked from a
// tab bar; the menus open as a sheet from the Menu button, and context menus as sheets whose submenus replace them.
// File > Add Footage to Comp adds the selected project item to the open composition, without drag and drop; a long
// press picks a project item up for a touch drag onto the viewer.
import { File as NodeFile } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "../src/ui/App.tsx";
import { COMPACT_QUERY } from "../src/ui/responsive.ts";

const FIXTURE = resolve(import.meta.dirname, "../refs/fixtures/roundtrip.base.aep");
const COMP = "roundtrip_minimax";
const CARD = "roundtrip_card";

beforeEach(() => {
  // A phone in portrait: the compact layout's query matches, the others (landscape, coarse pointer) do not.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === COMPACT_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "matchMedia");
});

const tab = (name: string) => screen.getByRole("tab", { name });
const sheet = () => screen.getByRole("dialog", { name: /.*/ });
const timeline = () => screen.getByRole("tree", { name: "Timeline layers" });
const layerNames = () => Array.from(timeline().querySelectorAll<HTMLElement>(".tl-layer")).map((row) => row.getAttribute("aria-label"));

/** Opens the fixture and, from the Project tab, the comp COMP. */
async function openComp() {
  render(<App />);
  const file = new NodeFile([readFileSync(FIXTURE)], "roundtrip.base.aep") as unknown as File;
  fireEvent.change(screen.getByLabelText("Open After Effects project"), { target: { files: [file] } });
  await screen.findByRole("tablist", { name: "Panels" });
  fireEvent.click(tab("Project"));
  fireEvent.change(screen.getByLabelText("Search project"), { target: { value: COMP } });
  const items = screen.getByRole("tree", { name: "Project items" });
  fireEvent.doubleClick(within(items).getAllByText(COMP).find((e) => e.classList.contains("cell-text"))!.closest<HTMLElement>('[role="treeitem"]')!);
}

test("the compact workspace shows the viewer and one panel at a time, picked from the tab bar", async () => {
  await openComp();
  expect(document.querySelector(".app.compact")).toBeTruthy();
  expect(document.querySelector(".ws")).toBeNull();
  // Opening the comp shows it in the viewer, with its Timeline.
  expect(screen.getByRole("img", { name: new RegExp(`^${COMP}, 160 x 120`) })).toBeTruthy();
  expect(tab("Timeline").getAttribute("aria-selected")).toBe("true");
  expect(within(timeline()).getByRole("treeitem", { name: CARD })).toBeTruthy();
  expect(screen.getByRole("toolbar", { name: "Playback" })).toBeTruthy();

  const panels: [string, () => HTMLElement][] = [
    ["Project", () => screen.getByRole("tree", { name: "Project items" })],
    ["Effect Controls", () => screen.getByText("Select a layer in the Timeline to see its effects.")],
    ["Effects & Presets", () => screen.getByRole("tree", { name: "Effects & Presets" })],
    ["Render Queue", () => screen.getByRole("list", { name: "Render Queue" })],
    ["More panels", () => screen.getByRole("button", { name: "RIFX Chunks" })],
    ["Timeline", timeline],
  ];
  for (const [name, shown] of panels) {
    fireEvent.click(tab(name));
    expect(tab(name).getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById("mpanel")!.contains(shown())).toBe(true);
  }
  // Effects & Presets has its own tab, so More leaves it out.
  fireEvent.click(tab("More panels"));
  expect(screen.queryByRole("button", { name: "Effects & Presets" })).toBeNull();
});

test("menus and context menus open as sheets, submenus in their place", async () => {
  await openComp();

  // The Menu button lists the menus; File opens in the sheet and Back returns.
  fireEvent.click(screen.getByRole("button", { name: "Menu" }));
  expect(sheet().getAttribute("aria-label")).toBe("roundtrip.base.aep");
  for (const name of ["File", "Edit", "Composition", "Layer", "Effect", "Window", "Help"]) {
    expect(within(sheet()).getByRole("menuitem", { name })).toBeTruthy();
  }
  fireEvent.click(within(sheet()).getByRole("menuitem", { name: "File" }));
  expect(sheet().getAttribute("aria-label")).toBe("File");
  expect(within(sheet()).getByRole("menuitem", { name: /^Add Footage to Comp/ })).toBeTruthy();
  fireEvent.click(within(sheet()).getByRole("button", { name: /roundtrip\.base\.aep/ }));
  expect(within(sheet()).getByRole("menuitem", { name: "Edit" })).toBeTruthy();
  fireEvent.click(within(sheet()).getByRole("button", { name: "Close menu" }));
  expect(screen.queryByRole("dialog")).toBeNull();

  // A layer's context menu is a sheet too; Transform opens in its place.
  fireEvent.contextMenu(within(timeline()).getByRole("treeitem", { name: CARD }));
  expect(within(sheet()).getByRole("menuitem", { name: /^Duplicate/ })).toBeTruthy();
  fireEvent.click(within(sheet()).getByRole("menuitem", { name: "Transform" }));
  expect(within(sheet()).getByRole("menuitem", { name: "Flip Horizontal" })).toBeTruthy();
  fireEvent.click(within(sheet()).getByRole("menuitem", { name: "Flip Horizontal" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

/** A touch pointer event (jsdom has no PointerEvent). */
function touch(type: string, target: EventTarget, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
  Object.defineProperties(event, { pointerType: { value: "touch" }, pointerId: { value: 7 }, isPrimary: { value: true } });
  act(() => {
    target.dispatchEvent(event);
  });
}

const projectRow = (name: string) => {
  fireEvent.change(screen.getByLabelText("Search project"), { target: { value: name } });
  const items = screen.getByRole("tree", { name: "Project items" });
  return within(items).getAllByText(name).find((e) => e.classList.contains("cell-text"))!.closest<HTMLElement>('[role="treeitem"]')!;
};

describe("touch drags", () => {
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  test("a long press picks a project item up and dropping it on the viewer adds it as a layer", async () => {
    await openComp();
    fireEvent.click(tab("Project"));
    const source = projectRow(CARD);
    const viewer = screen.getByRole("img", { name: new RegExp(`^${COMP}, 160 x 120`) });
    let under: Element | null = source;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => under });
    vi.useFakeTimers();

    touch("pointerdown", source, 20, 300);
    act(() => vi.advanceTimersByTime(300));
    expect(source.classList.contains("touch-drag-armed")).toBe(false);
    act(() => vi.advanceTimersByTime(300));
    expect(source.classList.contains("touch-drag-armed")).toBe(true);

    under = viewer;
    touch("pointermove", source, 60, 40);
    const ghost = document.querySelector(".touch-drag-ghost")!;
    expect(ghost.textContent).toBe(CARD);
    expect(ghost.classList.contains("refused")).toBe(false);
    touch("pointerup", source, 60, 40);
    expect(document.querySelector(".touch-drag-ghost")).toBeNull();
    expect(source.classList.contains("touch-drag-armed")).toBe(false);

    vi.useRealTimers();
    fireEvent.click(tab("Timeline"));
    expect(layerNames()).toEqual([CARD, CARD]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("a drag released over nothing that takes it drops nothing", async () => {
    await openComp();
    fireEvent.click(tab("Project"));
    const source = projectRow(CARD);
    const label = screen.getByRole("tablist", { name: "Panels" });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => label });
    vi.useFakeTimers();

    touch("pointerdown", source, 20, 300);
    act(() => vi.advanceTimersByTime(600));
    touch("pointermove", source, 20, 500);
    expect(document.querySelector(".touch-drag-ghost")!.classList.contains("refused")).toBe(true);
    touch("pointerup", source, 20, 500);

    vi.useRealTimers();
    fireEvent.click(tab("Timeline"));
    expect(layerNames()).toEqual([CARD]);
  });

  test("a long press lifted without moving opens the context menu; one that moves early does not", async () => {
    await openComp();
    fireEvent.click(tab("Project"));
    const source = projectRow(CARD);
    vi.useFakeTimers();

    touch("pointerdown", source, 20, 300);
    touch("pointermove", source, 20, 330);
    act(() => vi.advanceTimersByTime(600));
    expect(source.classList.contains("touch-drag-armed")).toBe(false);
    touch("pointerup", source, 20, 330);
    expect(screen.queryByRole("dialog")).toBeNull();

    touch("pointerdown", source, 20, 300);
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByRole("dialog")).toBeNull();
    touch("pointerup", source, 20, 300);
    expect(source.classList.contains("touch-drag-armed")).toBe(false);
    expect(within(sheet()).getAllByRole("menuitem").length).toBeGreaterThan(0);
  });
});

test("File > Add Footage to Comp adds the selected project item to the open comp as one undo step", async () => {
  await openComp();
  expect(layerNames()).toEqual([CARD]);
  fireEvent.click(tab("Project"));
  fireEvent.change(screen.getByLabelText("Search project"), { target: { value: CARD } });
  const items = screen.getByRole("tree", { name: "Project items" });
  fireEvent.click(within(items).getAllByText(CARD).find((e) => e.classList.contains("cell-text"))!.closest<HTMLElement>('[role="treeitem"]')!);

  fireEvent.click(screen.getByRole("button", { name: "Menu" }));
  fireEvent.click(within(sheet()).getByRole("menuitem", { name: "File" }));
  fireEvent.click(within(sheet()).getByRole("menuitem", { name: /^Add Footage to Comp/ }));
  expect(tab("Timeline").getAttribute("aria-selected")).toBe("true");
  expect(layerNames()).toEqual([CARD, CARD]);
  expect(within(timeline()).getAllByRole("treeitem", { name: CARD })[0].className).toContain("selected");

  fireEvent.click(screen.getByRole("button", { name: /^Undo/ }));
  expect(layerNames()).toEqual([CARD]);
});
