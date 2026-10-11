// @vitest-environment jsdom
// In the Android app, the native AppShell plugin passes on Android's requests to use less memory (the app out of
// sight, its page among the first to be stopped, memory running low). When Android stops the page anyway, or the page
// crashes, the plugin loads it again and tells it why: the app says so and keeps to smaller caches from then on.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";

const shell = vi.hoisted(() => ({
  listeners: new Map<string, (data?: unknown) => void>(),
  restartReason: vi.fn(async () => ({ reason: "memory" })),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "android",
    convertFileSrc: (path: string) => path,
  },
  registerPlugin: () => ({
    addListener: async (event: string, listener: (data?: unknown) => void) => {
      shell.listeners.set(event, listener);
      return { remove: async () => void shell.listeners.delete(event) };
    },
    exit: async () => {},
    restartReason: shell.restartReason,
  }),
}));

const { App, restartNotice } = await import("../src/ui/App.tsx");
const { memoryConstrained } = await import("../src/playback/memory.ts");
const { ramCache } = await import("../src/playback/ramCache.ts");
const { footageStore } = await import("../src/media/store.ts");

const userAgent = navigator.userAgent;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => userAgent });
  ramCache.invalidate();
});

const emit = (event: string, data?: unknown) => act(() => shell.listeners.get(event)?.(data));
const bitmap = () => ({ close: () => {} }) as unknown as ImageBitmap;
/** Renders the app once it has shown the restart notice (this page is a restarted one). */
async function renderApp() {
  render(<App />);
  await screen.findByRole("alertdialog", { name: "Restarted to free memory" });
}

test("after Android stopped the page for memory, the app says so and keeps to smaller caches", async () => {
  expect(memoryConstrained()).toBe(false);
  render(<App />);
  const notice = await screen.findByRole("alertdialog", { name: "Restarted to free memory" });
  expect(notice.textContent).toContain("Android stopped the app's page to free memory");
  expect(memoryConstrained()).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "OK" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  // Android tells once per page.
  cleanup();
  await renderApp();
  expect(shell.restartReason).toHaveBeenCalledOnce();
});

test("memory pressure Android reports gives the caches back; levels it does not know are ignored", async () => {
  const release = vi.spyOn(footageStore, "releaseMemory");
  await renderApp();
  await vi.waitFor(() => expect(shell.listeners.has("memory")).toBe(true));
  ramCache.put("1@1", 0, bitmap(), 1000);

  await emit("memory", { level: "complete" });
  expect(release).not.toHaveBeenCalled();

  await emit("memory", { level: "hidden" });
  expect(release).toHaveBeenLastCalledWith(true);
  expect(ramCache.size).toBe(1);

  await emit("memory", { level: "background" });
  expect(ramCache.size).toBe(0);
});

test("on a phone, putting the app out of sight gives back the caches and the video decoders", async () => {
  const release = vi.spyOn(footageStore, "releaseMemory");
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await renderApp();
  // A desktop browser's hidden tab keeps them, to play on at once when it comes back.
  await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
  expect(release).not.toHaveBeenCalled();

  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    get: () => "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36",
  });
  await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
  expect(release).toHaveBeenCalledWith(true);

  visibility.mockReturnValue("visible");
  release.mockClear();
  await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
  expect(release).not.toHaveBeenCalled();
});

test("the restart notice tells what happened, and suggests Auto resolution while it is off", () => {
  expect(restartNotice("crash", true)).toBe(
    "The app's page stopped unexpectedly, so the app started again. Changes that were not saved are lost. " +
      "For the rest of this session the app keeps fewer frames and layers in memory.",
  );
  expect(restartNotice("memory", false)).toMatch(/^Android stopped the app's page to free memory.*Resolution to Auto uses less memory still\.$/);
  expect(restartNotice("memory", true)).not.toContain("Auto");
});
