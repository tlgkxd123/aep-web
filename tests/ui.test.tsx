// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { App } from "../src/ui/App.tsx";

const samples = resolve(process.env.AEP_SAMPLES ?? resolve(__dirname, "../../_ref/py-aep/samples"));

afterEach(cleanup);

function aepFile(relativePath: string): File {
  const bytes = readFileSync(resolve(samples, relativePath));
  return new File([bytes], relativePath.split("/").pop()!, { type: "application/octet-stream" });
}

test("opening an .aep shows its composition, layers and animated transform properties", async () => {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Open After Effects project"), {
    target: { files: [aepFile("models/property/keyframe_BEZIER.aep")] },
  });

  const items = await screen.findByRole("list", { name: "Project items" });
  expect(within(items).getByText("TestComp")).toBeTruthy();

  const layers = screen.getByRole("list", { name: "Layers" });
  expect(within(layers).getByText("TestLayer")).toBeTruthy();

  const properties = screen.getByRole("list", { name: "Layer properties" });
  const position = within(properties).getByText("Position").closest("li")!;
  expect(position.className).toContain("animated");

  fireEvent.click(position);
  expect(within(properties).getAllByText(/bezier → bezier/)).toHaveLength(2);
});

test("an effect from a third-party plugin is labelled as a plugin with its parameter definitions", async () => {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Open After Effects project"), {
    target: { files: [aepFile("bugs/29.97_fps_time_scale_3.125.aep")] },
  });
  fireEvent.click(await screen.findByRole("tab", { name: /Effects/ }));
  const plugin = screen.getAllByText("S_BlurDirectional")[0].closest("details")!;
  expect(within(plugin).getByText("plugin")).toBeTruthy();
  expect(within(plugin).getByText("Mocha Opacity")).toBeTruthy();
});

test("a file that is not an After Effects project shows a readable error", async () => {
  render(<App />);
  fireEvent.change(screen.getByLabelText("Open After Effects project"), {
    target: { files: [new File([new TextEncoder().encode("not a project")], "notes.aep")] },
  });
  expect(await screen.findByText(/Could not read notes\.aep: Not an After Effects project/)).toBeTruthy();
});
