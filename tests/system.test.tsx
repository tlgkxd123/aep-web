// @vitest-environment jsdom
// Projects the system hands the web app (an installed app's file handler, through the launch queue) open like a
// picked file, with a handle Save writes back to; the back button closes the topmost sheet or dialog first.
import { File as NodeFile } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { missingRenderSupport } from "../src/playback/useViewer.ts";
import { App } from "../src/ui/App.tsx";
import { dismissTopmost, onLaunchedProjects, type LaunchedProject } from "../src/ui/system.ts";

const FIXTURE = resolve(import.meta.dirname, "../refs/fixtures/roundtrip.base.aep");

type Consumer = (params: { files: { kind: string; name: string; getFile(): Promise<File> }[] }) => void;
let launch: Consumer | undefined;

beforeAll(() => {
  Object.defineProperty(window, "launchQueue", { configurable: true, value: { setConsumer: (c: Consumer) => (launch = c) } });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

const handleFor = (name: string, bytes: Uint8Array) => ({
  kind: "file",
  name,
  getFile: async () => new NodeFile([bytes], name) as unknown as File,
});

test("launched files wait for the app, which then gets the .aep among them with its handle", async () => {
  const received: LaunchedProject[] = [];
  const stop = onLaunchedProjects((p) => received.push(p));
  stop();
  const aep = handleFor("shot.aep", new Uint8Array([1, 2, 3]));
  launch!({ files: [handleFor("notes.txt", new Uint8Array()), aep] });
  await new Promise((r) => setTimeout(r, 0));
  expect(received).toHaveLength(0);

  const late: LaunchedProject[] = [];
  const stopLate = onLaunchedProjects((p) => late.push(p));
  expect(late).toHaveLength(1);
  const [project] = late;
  expect("file" in project && project.file.name).toBe("shot.aep");
  expect("file" in project && project.handle).toBe(aep);
  stopLate();
});

test("the app opens a project the system launches it with", async () => {
  render(<App />);
  launch!({ files: [handleFor("roundtrip.base.aep", readFileSync(FIXTURE))] });
  expect(await screen.findByRole("tree", { name: "Project items" })).toBeTruthy();
  expect(document.title).toContain("roundtrip.base.aep");
});

test("the back button goes up a level of a menu sheet, or closes the topmost dialog with Escape", () => {
  expect(dismissTopmost()).toBe(false);

  const dialog = document.createElement("div");
  dialog.setAttribute("aria-modal", "true");
  const escapes = vi.fn();
  dialog.addEventListener("keydown", (e) => e.key === "Escape" && escapes());
  document.body.append(dialog);

  const sheet = document.createElement("div");
  sheet.setAttribute("aria-modal", "true");
  const up = document.createElement("button");
  up.className = "sheet-back";
  const ups = vi.fn();
  up.addEventListener("click", ups);
  sheet.append(up);
  document.body.append(sheet);

  expect(dismissTopmost()).toBe(true);
  expect(ups).toHaveBeenCalledOnce();
  expect(escapes).not.toHaveBeenCalled();
  sheet.remove();
  expect(dismissTopmost()).toBe(true);
  expect(escapes).toHaveBeenCalledOnce();
});

test("browsers without WebGL2 or OffscreenCanvas are told why frames do not render", () => {
  expect(missingRenderSupport({ WebGL2RenderingContext: class {}, OffscreenCanvas: class {} })).toBeUndefined();
  expect(missingRenderSupport({ WebGL2RenderingContext: class {} })).toMatch(/no OffscreenCanvas,/);
  expect(missingRenderSupport({})).toMatch(/no WebGL2 or OffscreenCanvas/);
});

test("the Home screen tells desktop browsers about dropping a project", () => {
  render(<App />);
  expect(screen.getByRole("button", { name: /Drop a project here/ })).toBeTruthy();
  expect(screen.queryByText(/Frames are not rendered/)).toBeNull();
});
