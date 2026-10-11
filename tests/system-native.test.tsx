// @vitest-environment jsdom
// In the Android app, a project another app hands over (Open with, Share) arrives from the native AppShell plugin as
// a copy in the app's cache, which the page fetches and opens. The back button closes the topmost dialog, then the
// app, rather than Android closing it straight away.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const FIXTURE = resolve(import.meta.dirname, "../refs/fixtures/roundtrip.base.aep");

const shell = vi.hoisted(() => ({
  listeners: new Map<string, (data?: unknown) => void>(),
  exit: vi.fn(async () => {}),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "android",
    convertFileSrc: (path: string) => path.replace("file://", "https://localhost/_capacitor_file_"),
  },
  registerPlugin: () => ({
    addListener: async (event: string, listener: (data?: unknown) => void) => {
      shell.listeners.set(event, listener);
      return { remove: async () => void shell.listeners.delete(event) };
    },
    exit: shell.exit,
  }),
}));

const { App } = await import("../src/ui/App.tsx");

const fetched: string[] = [];

beforeEach(() => {
  shell.exit.mockClear();
  fetched.length = 0;
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    return new Response(readFileSync(FIXTURE));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const emit = (event: string, data?: unknown) => act(() => shell.listeners.get(event)?.(data));

test("a project another app shares opens from the copy the plugin made", async () => {
  render(<App />);
  expect(screen.getByText(/Open with or Share/)).toBeTruthy();
  await vi.waitFor(() => expect(shell.listeners.has("file")).toBe(true));
  await emit("file", { name: "shot.aep", path: "/data/user/0/app/cache/incoming/shot.aep" });
  expect(await screen.findByRole("tree", { name: "Project items" })).toBeTruthy();
  expect(fetched).toEqual(["https://localhost/_capacitor_file_/data/user/0/app/cache/incoming/shot.aep"]);
  expect(document.title).toContain("shot.aep");

  // Nothing open over the project and nothing unsaved: back closes the app.
  await emit("back");
  await vi.waitFor(() => expect(shell.exit).toHaveBeenCalledOnce());
});

test("a file Android could not hand over is reported, and back closes the report before the app", async () => {
  render(<App />);
  await vi.waitFor(() => expect(shell.listeners.has("file")).toBe(true));
  await emit("file", { name: "shot.aep", error: "Permission denied" });
  expect((await screen.findByRole("alertdialog")).textContent).toContain("Could not read shot.aep: Permission denied");

  await emit("back");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(shell.exit).not.toHaveBeenCalled();

  await emit("back");
  await vi.waitFor(() => expect(shell.exit).toHaveBeenCalledOnce());
});
