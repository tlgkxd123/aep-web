// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { footageStore } from "../src/media/store.ts";
import { App } from "../src/ui/App.tsx";

const refs = resolve("refs");

afterEach(() => {
  cleanup();
  footageStore.clear();
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test("footage is shown missing in the Project panel until its files are located", async () => {
  render(<App />);
  const bytes = readFileSync(join(refs, "fixtures", "footage.aep"));
  fireEvent.change(screen.getByLabelText("Open After Effects project"), { target: { files: [new File([bytes], "footage.aep")] } });
  const items = await screen.findByRole("tree", { name: "Project items" });
  fireEvent.click(within(items).getByText("footage"));
  fireEvent.keyDown(items, { key: "ArrowRight" });

  const missingNames = () =>
    within(items)
      .queryAllByLabelText("missing")
      .map((mark) => mark.closest<HTMLElement>('[role="treeitem"]')!.querySelector(".cell-text")!.textContent);
  expect(missingNames()).toContain("clip.mp4");
  expect(screen.getByRole("button", { name: "Locate footage folder" })).toBeTruthy();

  await act(async () => {
    footageStore.addFiles(files(join(refs, "media")).map((path) => ({ path: relative(refs, path), blob: new Blob([readFileSync(path)]) })));
    await Promise.resolve();
  });
  expect([...new Set(missingNames())].sort()).toEqual(["footage placeholder", "gone.png"]);
});
