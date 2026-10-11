// @vitest-environment jsdom
// Quick Start: the Home screen's template cards and File > New > New Project from Template open a window that asks
// for the song (and optionally a background and a logo), then open the template's project, unsaved and without undo
// history, in place of the current one once its changes are saved or dropped.
import { File as NodeFile } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { footageStore } from "../src/media/store.ts";
import { App } from "../src/ui/App.tsx";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  footageStore.clear();
  vi.restoreAllMocks();
});

/** A mono 16-bit WAV file of kicks twice a second. */
function song(name = "song.wav", seconds = 2, rate = 22050): File {
  const samples = seconds * rate;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => (bytes[at + i] = c.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    view.setInt16(44 + i * 2, Math.round(0.8 * Math.exp(-((t * 2) % 1) * 12) * Math.sin(2 * Math.PI * 55 * t) * 32767), true);
  }
  return new NodeFile([bytes], name) as unknown as File;
}
const picture = (name: string) => new NodeFile([readFileSync(resolve("refs/media", name))], name) as unknown as File;

const dialog = () => screen.getByRole("dialog", { name: "New Project from Template" });
const choose = (label: string, file: File) => fireEvent.change(within(dialog()).getByLabelText(`${label} file`), { target: { files: [file] } });
const create = () => fireEvent.click(within(dialog()).getByRole("button", { name: "Create" }));
const projectRows = () =>
  within(screen.getByRole("tree", { name: "Project items" }))
    .queryAllByRole("treeitem")
    .map((r) => r.querySelector(".cell-text")?.textContent);
const layerNames = () =>
  within(screen.getByRole("tree", { name: "Timeline layers" }))
    .queryAllByRole("treeitem")
    .map((r) => r.getAttribute("aria-label"));
const opened = (timeout = 20000) => waitFor(() => expect(screen.queryByRole("tree", { name: "Project items" })).not.toBeNull(), { timeout });

test("a Home screen card builds its template around the chosen song, background and logo", async () => {
  render(<App />);
  const quickStart = screen.getByRole("region", { name: "Quick Start" });
  expect(within(quickStart).getAllByRole("button").map((b) => b.querySelector(".qs-card-name")?.textContent)).toEqual(["Trap Nation 2018", "Trap Nation 2020"]);
  fireEvent.click(within(quickStart).getByRole("button", { name: /^Trap Nation 2018/ }));

  expect(within(dialog()).getByRole("heading", { name: "Trap Nation 2018" })).toBeTruthy();
  const createButton = within(dialog()).getByRole("button", { name: "Create" }) as HTMLButtonElement;
  expect(createButton.disabled).toBe(true);
  choose("Song", song());
  choose("Background", picture("photo.jpg"));
  choose("Logo", picture("straight.png"));
  expect(within(dialog()).getByText("song.wav")).toBeTruthy();
  expect(createButton.disabled).toBe(false);
  create();
  expect(await within(dialog()).findByRole("status")).toBeTruthy();

  await opened();
  expect(screen.queryByRole("dialog", { name: "New Project from Template" })).toBeNull();
  await waitFor(() => expect(document.title).toBe("Trap Nation 2018.aep * - AEP Web"));
  expect(projectRows()).toEqual(expect.arrayContaining(["Trap Nation 2018", "song.wav", "photo.jpg", "straight.png"]));
  await waitFor(() => expect(layerNames()).toEqual(["Controls", "Shake", "Bounce", "straight.png", "Spectrum", "Particles", "photo.jpg", "song.wav"]));

  fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
  expect(within(screen.getByRole("menu", { name: "Edit" })).getByRole("menuitem", { name: /^Can't Undo/ })).toBeTruthy();
});

test("a song without sound is refused in the window, which stays open with the files chosen", async () => {
  render(<App />);
  fireEvent.click(within(screen.getByRole("region", { name: "Quick Start" })).getByRole("button", { name: /^Trap Nation 2020/ }));
  choose("Song", picture("photo.jpg"));
  create();
  expect((await within(dialog()).findByRole("alert")).textContent).toMatch(/"photo.jpg" has no sound/);
  expect(within(dialog()).getByText("photo.jpg")).toBeTruthy();
  fireEvent.click(within(dialog()).getByRole("button", { name: "Clear song" }));
  expect((within(dialog()).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog", { name: "New Project from Template" })).toBeNull();
  expect(screen.getByRole("region", { name: "Home" })).toBeTruthy();
});

test("File > New > New Project from Template asks to save the open project's changes before replacing it", async () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "New Project" }));
  await opened();
  act(() => {
    fireEvent.keyDown(window, { key: "n", code: "KeyN", ctrlKey: true });
  });
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Composition Settings" })).getByRole("button", { name: "OK" }));
  await waitFor(() => expect(document.title).toBe("Untitled Project.aep * - AEP Web"));

  const fromTemplate = () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "File" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "New" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "New" })).getByRole("menuitem", { name: "New Project from Template" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "New Project from Template" })).getByRole("menuitem", { name: "Trap Nation 2020..." }));
  };
  fromTemplate();
  choose("Song", song("beat.wav", 1));
  fireEvent.click(within(dialog()).getByLabelText(/^Particles/));
  create();
  const prompt = await screen.findByRole("alertdialog", {}, { timeout: 20000 });
  expect(prompt.textContent).toMatch(/Save changes to "Untitled Project.aep"/);
  fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect((within(dialog()).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false));
  expect(projectRows()).toEqual(["Comp 1"]);

  create();
  fireEvent.click(within(await screen.findByRole("alertdialog", {}, { timeout: 20000 })).getByRole("button", { name: "Don't Save" }));
  await waitFor(() => expect(document.title).toBe("Trap Nation 2020.aep * - AEP Web"));
  expect(screen.queryByRole("dialog", { name: "New Project from Template" })).toBeNull();
  await waitFor(() => expect(layerNames()).toEqual(["Controls", "Shake", "Bounce", "Logo", "Spectrum", "Background", "beat.wav"]));
}, 60000);
