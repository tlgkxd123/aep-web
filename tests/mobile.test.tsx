// @vitest-environment jsdom
// On a phone-sized screen the app shows the compact workspace: the viewer over one panel at a time, picked from a
// tab bar; the menus open as a sheet from the Menu button, and context menus as sheets whose submenus replace them.
// File > Add Footage to Comp adds the selected project item to the open composition, without drag and drop. What
// desktops do with keys or drags has a touch path: Composition Settings (the comp's duration) from the Timeline, the
// work area from the ruler's menu, Rename from a layer's menu, Move To from a project item's menu, and a long press
// picks a project item up for a touch drag onto the viewer, or onto another tab's panel once held on its tab.
import { File as NodeFile } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Item, Project } from "../src/aep/model.ts";
import { App } from "../src/ui/App.tsx";
import { closeContextMenu, type MenuEntry } from "../src/ui/ContextMenu.tsx";
import { moveToEntries } from "../src/ui/contextMenus.ts";
import { COMPACT_QUERY } from "../src/ui/responsive.ts";
import { TouchDataTransfer } from "../src/ui/touch.ts";

const FIXTURE = resolve(import.meta.dirname, "../refs/fixtures/roundtrip.base.aep");
const COMP = "roundtrip_minimax";
const CARD = "roundtrip_card";

// jsdom has no PointerEvent: without one fireEvent drops clientX from pointer events.
if (typeof window.PointerEvent === "undefined") {
  Object.defineProperty(window, "PointerEvent", { configurable: true, value: class extends MouseEvent {} });
}

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
  closeContextMenu();
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

test("a finger moving over the viewer shows where it is in the Info panel, without reading the pixel back", async () => {
  await openComp();
  fireEvent.click(tab("More panels"));
  const viewer = screen.getByRole("img", { name: new RegExp(`^${COMP}, 160 x 120`) });
  Object.defineProperty(viewer, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, top: 0, right: 160, bottom: 120, width: 160, height: 120, x: 0, y: 0 }),
  });
  const readout = () => Array.from(document.querySelectorAll(".info-readout dd"), (dd) => dd.textContent);
  // A mouse samples the frame (nothing renders here, so it reads zeros).
  fireEvent.pointerMove(viewer, { clientX: 40, clientY: 30 });
  expect(readout()).toEqual(["0", "0", "0", "0", "40", "30"]);
  touch("pointermove", viewer, 80, 60);
  expect(readout()).toEqual(["", "", "", "", "80", "60"]);
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
    vi.restoreAllMocks();
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

  test("draggable elements, and only they, can keep a held finger from scrolling, from before the finger lands", async () => {
    // Browsers settle whether a touch's moves can be cancelled when it starts: a listener added once the press is
    // held comes too late, and one on the window would make every scroll wait for the page's scripts.
    const add = vi.spyOn(EventTarget.prototype, "addEventListener");
    const cancelling = () =>
      add.mock.calls.flatMap(([type, , options], i) => (type === "touchmove" && typeof options === "object" && options.passive === false ? [add.mock.contexts[i]] : []));
    await openComp();
    fireEvent.click(tab("Project"));
    const source = projectRow(CARD);
    const later = document.createElement("div");
    const turned = document.createElement("div");
    later.setAttribute("draggable", "true");
    document.body.append(later, turned);
    await act(async () => {});
    turned.setAttribute("draggable", "true");
    await act(async () => {});
    const listening = cancelling();
    expect(listening).toContain(source);
    expect(listening).toContain(later);
    expect(listening).toContain(turned);
    expect(listening.every((el) => el instanceof Element && el.matches('[draggable="true"]'))).toBe(true);
    later.remove();
    turned.remove();

    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => source });
    const moveCancelled = () => {
      const move = new Event("touchmove", { bubbles: true, cancelable: true });
      source.querySelector(".cell-text")!.dispatchEvent(move);
      return move.defaultPrevented;
    };
    vi.useFakeTimers();
    touch("pointerdown", source, 20, 300);
    act(() => vi.advanceTimersByTime(300));
    expect(moveCancelled()).toBe(false);
    act(() => vi.advanceTimersByTime(300));
    expect(source.classList.contains("touch-drag-armed")).toBe(true);
    expect(moveCancelled()).toBe(true);
    touch("pointermove", source, 60, 40);
    expect(document.querySelector(".touch-drag-ghost")).toBeTruthy();
    expect(moveCancelled()).toBe(true);
    touch("pointercancel", source, 60, 40);
    expect(document.querySelector(".touch-drag-ghost")).toBeNull();
    expect(moveCancelled()).toBe(false);
  });

  test("the drag the browser starts from a long press (Android's) is cancelled, and the page's picks the item up", async () => {
    await openComp();
    fireEvent.click(tab("Project"));
    const source = projectRow(CARD);
    const viewer = screen.getByRole("img", { name: new RegExp(`^${COMP}, 160 x 120`) });
    let under: Element | null = source;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => under });

    // A mouse drag is the browser's own.
    const mouseDrag = browserDragStart(source);
    expect(mouseDrag.event.defaultPrevented).toBe(false);
    expect(mouseDrag.data.types.length).toBeGreaterThan(0);

    vi.useFakeTimers();
    touch("pointerdown", source, 20, 300);
    // Android's long press comes before the page's own hold ends.
    act(() => vi.advanceTimersByTime(400));
    const longPress = browserDragStart(source);
    expect(longPress.event.defaultPrevented).toBe(true);
    expect(longPress.data.types).toEqual([]);
    expect(source.classList.contains("touch-drag-armed")).toBe(true);

    under = viewer;
    touch("pointermove", source, 60, 40);
    expect(document.querySelector(".touch-drag-ghost")!.classList.contains("refused")).toBe(false);
    touch("pointerup", source, 60, 40);
    expect(document.querySelector(".touch-drag-ghost")).toBeNull();

    vi.useRealTimers();
    fireEvent.click(tab("Timeline"));
    expect(layerNames()).toEqual([CARD, CARD]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("a long press the browser answers (its drag or its menu event) and lifted without moving opens one context menu", async () => {
    await openComp();
    fireEvent.click(tab("Project"));
    const source = projectRow(CARD);
    vi.useFakeTimers();

    // Chrome on Android starts a drag on the long press, then sends its menu event when the finger lifts.
    touch("pointerdown", source, 20, 300);
    act(() => vi.advanceTimersByTime(400));
    browserDragStart(source);
    touch("pointerup", source, 20, 300);
    expect(within(sheet()).getAllByRole("menuitem").length).toBeGreaterThan(0);
    const late = browserEvent(source, new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 300 }));
    expect(late.defaultPrevented).toBe(true);
    fireEvent.click(within(sheet()).getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // Without touch drags, it sends its menu event on the long press instead: that picks the item up.
    touch("pointerdown", source, 20, 300);
    act(() => vi.advanceTimersByTime(400));
    const early = browserEvent(source, new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 300 }));
    expect(early.defaultPrevented).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(source.classList.contains("touch-drag-armed")).toBe(true);
    touch("pointerup", source, 20, 300);
    expect(within(sheet()).getAllByRole("menuitem").length).toBeGreaterThan(0);
  });

  test("a drag resting on a tab opens it, so a project item drops on the Timeline", async () => {
    await openComp();
    fireEvent.click(tab("Project"));
    const source = projectRow(CARD);
    let under: Element | null = source;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => under });
    vi.useFakeTimers();

    touch("pointerdown", source, 20, 300);
    act(() => vi.advanceTimersByTime(600));
    // Passing over a tab does not open it.
    under = tab("Render Queue").querySelector(".mtab-label");
    touch("pointermove", source, 300, 600);
    expect(tab("Render Queue").classList.contains("opening")).toBe(true);
    act(() => vi.advanceTimersByTime(300));
    under = screen.getByRole("tablist", { name: "Panels" });
    touch("pointermove", source, 200, 560);
    expect(tab("Render Queue").classList.contains("opening")).toBe(false);
    act(() => vi.advanceTimersByTime(600));
    expect(tab("Project").getAttribute("aria-selected")).toBe("true");

    under = tab("Timeline");
    touch("pointermove", source, 100, 600);
    expect(document.querySelector(".touch-drag-ghost")!.classList.contains("refused")).toBe(true);
    act(() => vi.advanceTimersByTime(600));
    expect(tab("Timeline").getAttribute("aria-selected")).toBe("true");
    expect(tab("Timeline").classList.contains("opening")).toBe(false);

    // The Project panel, and the row the finger pressed, are gone: the finger's events now reach what is under it.
    const row = within(timeline()).getByRole("treeitem", { name: CARD });
    under = row;
    touch("pointermove", row, 100, 400);
    expect(document.querySelector(".touch-drag-ghost")!.classList.contains("refused")).toBe(false);
    touch("pointerup", row, 100, 400);
    expect(document.querySelector(".touch-drag-ghost")).toBeNull();
    expect(layerNames()).toEqual([CARD, CARD]);
  });
});

/** Dispatches `event` as one of the browser's own: jsdom makes trusted events only internally. */
function browserEvent<E extends Event>(target: EventTarget, event: E): E {
  type Impl = { isTrusted: boolean; _dispatch(event: Impl): boolean };
  const impl = (o: object) => (o as Record<symbol, Impl>)[Object.getOwnPropertySymbols(o).find((s) => s.description === "impl")!];
  impl(event).isTrusted = true;
  act(() => {
    impl(target)._dispatch(impl(event));
  });
  return event;
}

/** The browser starting its own HTML drag of `source`, with what the app's handlers put in its drag data. */
function browserDragStart(source: Element) {
  const data = new TouchDataTransfer();
  const event = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: data });
  return { event: browserEvent(source, event), data };
}

test("the Timeline sets the work area by touch: buttons at the current time, and its ends dragged", async () => {
  await openComp();
  const start = () => screen.getByRole("slider", { name: "Work area start" });
  const end = () => screen.getByRole("slider", { name: "Work area end" });
  const value = (el: HTMLElement) => Number(el.getAttribute("aria-valuenow"));
  const duration = Number(end().getAttribute("aria-valuemax"));

  // At time 0, the end button ends the work area after the first frame; the start button then starts it at 0.
  fireEvent.click(screen.getByRole("button", { name: "Set work area end" }));
  const oneFrame = value(end());
  expect(value(start())).toBe(0);
  expect(oneFrame).toBeGreaterThan(0);
  expect(oneFrame).toBeLessThan(duration);
  fireEvent.click(screen.getByRole("button", { name: "Set work area start" }));
  expect([value(start()), value(end())]).toEqual([0, oneFrame]);

  // The arrow keys move an end a frame.
  fireEvent.keyDown(end(), { key: "ArrowRight" });
  expect(value(end())).toBeCloseTo(2 * oneFrame, 6);

  // Dragging the end across the whole lane takes it to the comp's end, as one undo step.
  const lane = end().closest<HTMLElement>(".tl-workarea-lane")!;
  lane.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 12, width: 100, height: 12, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.pointerDown(end(), { button: 0, clientX: 2, clientY: 6 });
  fireEvent.pointerMove(window, { clientX: 50, clientY: 6 });
  fireEvent.pointerMove(window, { clientX: 200, clientY: 6 });
  fireEvent.pointerUp(window, { clientX: 200, clientY: 6 });
  expect(value(end())).toBeCloseTo(duration, 6);
  expect(value(start())).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: /^Undo/ }));
  expect(value(end())).toBeCloseTo(2 * oneFrame, 6);
});

test("the Timeline's Composition Settings button changes the comp's duration, as one undo step", async () => {
  await openComp();
  const button = within(timeline().closest(".tl")!).getByRole("button", { name: "Composition Settings" });
  const before = button.textContent;
  fireEvent.click(button);
  const dialog = screen.getByRole("dialog", { name: "Composition Settings" });
  const duration = within(dialog).getByLabelText("Duration:");
  expect(duration.getAttribute("inputmode")).toBe("decimal");
  expect(before).toBe("Δ 0:00:01:00");
  fireEvent.change(duration, { target: { value: "0:00:02:00" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
  expect(screen.queryByRole("dialog", { name: "Composition Settings" })).toBeNull();
  const after = () => within(timeline().closest(".tl")!).getByRole("button", { name: "Composition Settings" }).textContent;
  expect(after()).toBe("Δ 0:00:02:00");

  fireEvent.click(screen.getByRole("button", { name: /^Undo/ }));
  expect(after()).toBe(before);
});

test("a long press on the time ruler sets the work area at that frame and opens Composition Settings", async () => {
  await openComp();
  const root = timeline().closest<HTMLElement>(".tl")!;
  const workArea = () => root.querySelector<HTMLElement>(".tl-workarea")!.style.width;
  const full = workArea();

  // A typed time applies when the field loses focus, as touch keypads have no Enter key.
  fireEvent.click(within(root).getByRole("button", { name: /^0:00:00:00$/ }));
  const field = within(root).getByLabelText("Go to time");
  fireEvent.change(field, { target: { value: "0:00:00:05" } });
  fireEvent.blur(field);
  expect(within(root).getByRole("button", { name: "0:00:00:05" })).toBeTruthy();

  fireEvent.contextMenu(within(root).getByRole("slider", { name: "Current time" }));
  for (const name of [/^Composition Settings/, /^Set Work Area Start/]) expect(within(sheet()).getByRole("menuitem", { name })).toBeTruthy();
  fireEvent.click(within(sheet()).getByRole("menuitem", { name: /^Set Work Area End/ }));
  expect(workArea()).not.toBe(full);
  fireEvent.click(screen.getByRole("button", { name: /^Undo/ }));
  expect(workArea()).toBe(full);

  fireEvent.contextMenu(within(root).getByRole("slider", { name: "Current time" }));
  fireEvent.click(within(sheet()).getByRole("menuitem", { name: /^Composition Settings/ }));
  expect(screen.getByRole("dialog", { name: "Composition Settings" })).toBeTruthy();
});

test("a layer's context menu renames it, as Enter does on a keyboard", async () => {
  await openComp();
  fireEvent.contextMenu(within(timeline()).getByRole("treeitem", { name: CARD }));
  fireEvent.click(within(sheet()).getByRole("menuitem", { name: /^Rename/ }));
  const field = within(timeline()).getByLabelText("Layer name");
  fireEvent.change(field, { target: { value: "renamed card" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(within(timeline()).getByRole("treeitem", { name: "renamed card" })).toBeTruthy();
});

test("Move To lists the project root and every folder, disabling where the items already are", () => {
  const folder = (id: number, name: string, parentFolderId = 0) => ({ id, name, kind: "folder", parentFolderId, items: [] }) as unknown as Item;
  const comp = { id: 9, name: "comp", kind: "comp", parentFolderId: 2 } as unknown as Item;
  const a = folder(1, "A");
  const b = folder(2, "B", 1);
  const project = { items: new Map<number, Item>([a, b, comp].map((i) => [i.id, i])) } as unknown as Project;
  const moved: number[] = [];
  const entries = moveToEntries(project, [comp], (id) => moved.push(id)) as MenuEntry[];
  expect(entries.map((e) => (typeof e === "string" ? e : e.label))).toEqual(["Project Root", "-", "A", "A / B"]);
  expect(entries.filter((e) => typeof e !== "string" && e.onSelect).map((e) => e.label)).toEqual(["Project Root", "A"]);
  entries[2].onSelect!();
  expect(moved).toEqual([1]);
  // A folder cannot move into itself or its subfolders.
  const own = moveToEntries(project, [a], () => {}) as MenuEntry[];
  expect(own.filter((e) => typeof e !== "string" && e.onSelect).map((e) => e.label)).toEqual([]);
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
