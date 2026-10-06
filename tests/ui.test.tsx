// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { CompItem } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { App } from "../src/ui/App.tsx";
import { timecode } from "../src/ui/format.ts";

const samples = resolve(process.env.AEP_SAMPLES ?? resolve(__dirname, "../../_ref/py-aep/samples"));

afterEach(cleanup);

function aepFile(relativePath: string): File {
  const bytes = readFileSync(resolve(samples, relativePath));
  return new File([bytes], relativePath.split("/").pop()!, { type: "application/octet-stream" });
}

function openSample(relativePath: string) {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Open After Effects project"), { target: { files: [aepFile(relativePath)] } });
}

test("opening an .aep shows its composition, layers and animated transform keyframes", async () => {
  openSample("models/property/keyframe_BEZIER.aep");

  const items = await screen.findByRole("tree", { name: "Project items" });
  expect(within(items).getByText("TestComp")).toBeTruthy();

  const layers = screen.getByRole("tree", { name: "Timeline layers" });
  expect(within(layers).getByText("TestLayer")).toBeTruthy();

  fireEvent.click(within(layers).getByRole("button", { name: "Expand TestLayer" }));
  fireEvent.click(within(layers).getByRole("button", { name: "Expand Transform" }));

  const position = within(layers).getByRole("treeitem", { name: "Position" });
  expect(within(position).getByLabelText("Stopwatch on (animated)")).toBeTruthy();
  const keyframes = within(position).getAllByRole("button", { name: /^Position keyframe at .*Bezier in, Bezier out$/ });
  expect(keyframes).toHaveLength(2);
});

test("an effect from a third-party plugin is labelled as a plug-in with its parameter definitions", async () => {
  openSample("bugs/29.97_fps_time_scale_3.125.aep");

  const presets = await screen.findByRole("tree", { name: "Effects & Presets" });
  const effect = within(presets).getByText("S_BlurDirectional").closest<HTMLElement>('[role="treeitem"]')!;
  expect(within(effect).getByText("Plug-in")).toBeTruthy();

  fireEvent.click(within(effect).getByText("S_BlurDirectional"));
  expect(within(effect).getByText("Mocha Opacity")).toBeTruthy();
});

test("a file that is not an After Effects project shows a readable error", async () => {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Open After Effects project"), {
    target: { files: [new File([new TextEncoder().encode("not a project")], "notes.aep")] },
  });
  expect(await screen.findByText(/Could not read notes\.aep: Not an After Effects project/)).toBeTruthy();
});

test("clicking and dragging the time ruler moves the current-time indicator and the timecode", async () => {
  const project = parseProject(new Uint8Array(readFileSync(resolve(samples, "models/property/keyframe_BEZIER.aep"))));
  const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === "TestComp")!;
  const expectedAt = (fraction: number) => {
    const frame = comp.frameDuration;
    const t = Math.min(comp.duration - frame, Math.round((comp.duration * fraction) / frame) * frame);
    return timecode(t + comp.displayStartTime, comp.frameRate);
  };

  openSample("models/property/keyframe_BEZIER.aep");
  await screen.findByRole("tree", { name: "Timeline layers" });

  const display = screen.getByTitle("Current Time (click to edit)");
  expect(display.textContent).toBe(timecode(comp.displayStartTime, comp.frameRate));

  const ruler = screen.getByRole("slider", { name: "Current time" });
  ruler.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 48, right: 500, bottom: 48, x: 0, y: 0, toJSON: () => ({}) });

  fireEvent(ruler, new MouseEvent("pointerdown", { clientX: 250, bubbles: true }));
  expect(display.textContent).toBe(expectedAt(0.5));
  expect(display.textContent).not.toBe(timecode(comp.displayStartTime, comp.frameRate));

  fireEvent(window, new MouseEvent("pointermove", { clientX: 125, bubbles: true }));
  expect(display.textContent).toBe(expectedAt(0.25));
  fireEvent(window, new MouseEvent("pointerup", { bubbles: true }));

  fireEvent.keyDown(ruler, { key: "ArrowRight" });
  expect(ruler.getAttribute("aria-valuetext")).toBe(display.textContent);
});
