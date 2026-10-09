// @vitest-environment jsdom
// Effect Controls: the fx switch turns an effect off and on, Delete and the trash button remove effects, undoably.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { App } from "../src/ui/App.tsx";

const FIXTURE = resolve(import.meta.dirname, "../refs/fixtures/fxmisc.aep");

afterEach(cleanup);

const effects = () => screen.getByRole("tree", { name: "Effect Controls" });
const effectNames = () => Array.from(effects().querySelectorAll(".ec-effect-name")).map((e) => e.textContent);
const fxSwitch = (name: string) => within(effects()).getByRole("button", { name: `${name} on` });

test("effects are switched off and on, and deleted with Delete or the trash button, undoably", async () => {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Open After Effects project"), {
    target: { files: [new File([readFileSync(FIXTURE)], "fxmisc.aep")] },
  });
  const items = await screen.findByRole("tree", { name: "Project items" });
  fireEvent.change(screen.getByLabelText("Search project"), { target: { value: "fxmisc_as_user_polarfx" } });
  const comp = within(items)
    .getAllByText("fxmisc_as_user_polarfx")
    .find((e) => e.classList.contains("cell-text"))!
    .closest<HTMLElement>('[role="treeitem"]')!;
  fireEvent.doubleClick(comp);
  fireEvent.click(within(screen.getByRole("tree", { name: "Timeline layers" })).getByRole("treeitem", { name: "spectrum" }));
  fireEvent.click(screen.getByRole("tab", { name: /^Effect Controls/ }));
  expect(effectNames()).toEqual(["Audio Spectrum", "Polar Coordinates"]);

  fireEvent.click(fxSwitch("Polar Coordinates"));
  expect(fxSwitch("Polar Coordinates").getAttribute("aria-pressed")).toBe("false");
  expect(fxSwitch("Audio Spectrum").getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(fxSwitch("Polar Coordinates"));
  expect(fxSwitch("Polar Coordinates").getAttribute("aria-pressed")).toBe("true");

  // Delete removes the selected effect, not the layer.
  fireEvent.click(within(effects()).getByText("Audio Spectrum", { selector: ".ec-effect-name" }));
  fireEvent.keyDown(effects(), { key: "Delete" });
  expect(effectNames()).toEqual(["Polar Coordinates"]);
  expect(within(screen.getByRole("tree", { name: "Timeline layers" })).getByRole("treeitem", { name: "spectrum" })).toBeTruthy();

  fireEvent.keyDown(window, { key: "z", ctrlKey: true });
  expect(effectNames()).toEqual(["Audio Spectrum", "Polar Coordinates"]);

  fireEvent.click(within(effects()).getByRole("button", { name: "Delete Polar Coordinates" }));
  expect(effectNames()).toEqual(["Audio Spectrum"]);
});
