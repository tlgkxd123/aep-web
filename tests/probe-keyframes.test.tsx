// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { App } from "../src/ui/App.tsx";
import { SAMPLES } from "../scripts/lib/paths.ts";

const samples = resolve(SAMPLES);
afterEach(cleanup);

for (const name of ["PointerEvent", "DragEvent"] as const) {
  if (typeof window[name] === "undefined") Object.defineProperty(window, name, { configurable: true, value: class extends MouseEvent {} });
}

test("probe: keyframe click selection and drag", async () => {
  render(<App />);
  const bytes = readFileSync(resolve(samples, "models/property/keyframe_BEZIER.aep"));
  fireEvent.change(screen.getByLabelText("Open After Effects project"), {
    target: { files: [new File([bytes], "k.aep")] },
  });
  const layers = await screen.findByRole("tree", { name: "Timeline layers" });
  fireEvent.click(within(layers).getByRole("button", { name: "Expand TestLayer" }));
  fireEvent.click(within(layers).getByRole("button", { name: "Expand Transform" }));
  const position = within(layers).getByRole("treeitem", { name: "Position" });
  const keys = within(position).getAllByRole("button", { name: /^Position keyframe at / });
  console.log("keyframes:", keys.length);
  console.log("before class:", keys[0].className, keys[0].getAttribute("style"));
  fireEvent.click(keys[0]);
  const after = within(position).getAllByRole("button", { name: /^Position keyframe at / });
  console.log("after click class:", after[0].className);
  console.log("parent track:", after[0].parentElement?.className);
  const track = after[0].parentElement as HTMLElement;
  track.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 20, right: 1000, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.pointerDown(after[0], { clientX: 100, clientY: 10, button: 0 });
  fireEvent.pointerMove(window, { clientX: 300, clientY: 10 });
  fireEvent.pointerUp(window);
  const moved = within(position).getAllByRole("button", { name: /^Position keyframe at / });
  console.log("after drag styles:", moved.map((m) => m.getAttribute("style")));
  expect(true).toBe(true);
});
