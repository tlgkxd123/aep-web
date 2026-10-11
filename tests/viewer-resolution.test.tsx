// @vitest-environment jsdom
// The Resolution menu's Auto renders the viewer no finer than it shows the comp, so a phone's GPU renders a full HD
// comp at Quarter for a viewer a few hundred pixels wide. It is on by default on phones and tablets.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { autoFactor, autoResolution, viewerFactor } from "../src/playback/viewer.ts";
import { App } from "../src/ui/App.tsx";

const FIXTURE = resolve(import.meta.dirname, "../refs/fixtures/roundtrip.base.aep");
const COMP = "roundtrip_minimax";
const DESKTOP_UA = navigator.userAgent;

function stubMedia(matching: string[]) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: matching.includes(query),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function stubUserAgent(ua: string) {
  Object.defineProperty(navigator, "userAgent", { configurable: true, get: () => ua });
}

afterEach(() => {
  cleanup();
  autoResolution.set(false);
  localStorage.clear();
  Reflect.deleteProperty(window, "matchMedia");
  stubUserAgent(DESKTOP_UA);
  vi.resetModules();
});

test("Auto takes the coarser of the comp's Resolution and the magnification's", () => {
  expect(autoFactor(1)).toBe(1);
  expect(autoFactor(0.5)).toBe(2);
  expect(autoFactor(0.18)).toBe(4);
  expect(viewerFactor(1, 0.18, false)).toBe(1);
  expect(viewerFactor(1, 0.18, true)).toBe(4);
  expect(viewerFactor(1, 0.5, true)).toBe(2);
  expect(viewerFactor(3, 1, true)).toBe(3);
  expect(viewerFactor(2, 2, true)).toBe(2);
  expect(viewerFactor(0, 1, false)).toBe(1);
});

test("phones and touch-only tablets count as mobile devices; desktops and touch laptops do not", async () => {
  const { isMobileDevice } = await import("../src/device.ts");
  expect(isMobileDevice()).toBe(false);
  stubMedia(["(pointer: coarse)", "(any-pointer: fine)"]);
  expect(isMobileDevice()).toBe(false);
  stubMedia(["(pointer: coarse)"]);
  expect(isMobileDevice()).toBe(true);
  Reflect.deleteProperty(window, "matchMedia");
  stubUserAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36");
  expect(isMobileDevice()).toBe(true);
});

test("Auto is on by default on a phone and off on a desktop, and a choice is kept", async () => {
  expect((await import("../src/playback/viewer.ts")).autoResolution.on).toBe(false);

  vi.resetModules();
  stubUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148");
  const phone = (await import("../src/playback/viewer.ts")).autoResolution;
  expect(phone.on).toBe(true);
  phone.set(false);

  vi.resetModules();
  expect((await import("../src/playback/viewer.ts")).autoResolution.on).toBe(false);
});

test("the Resolution menu switches the viewer between Auto and a fixed resolution", async () => {
  render(<App />);
  const file = new File([readFileSync(FIXTURE)], "roundtrip.base.aep");
  fireEvent.change(screen.getByLabelText("Open After Effects project"), { target: { files: [file] } });
  fireEvent.change(await screen.findByLabelText("Search project"), { target: { value: COMP } });
  const items = screen.getByRole("tree", { name: "Project items" });
  fireEvent.doubleClick(within(items).getAllByText(COMP).find((e) => e.classList.contains("cell-text"))!.closest<HTMLElement>('[role="treeitem"]')!);

  const menu = () => screen.getByRole("button", { name: /^Resolution\/Down Sample Factor: / });
  expect(menu().getAttribute("aria-label")).toBe("Resolution/Down Sample Factor: Full");

  fireEvent.click(menu());
  fireEvent.click(screen.getByRole("menuitem", { name: "Auto" }));
  expect(autoResolution.on).toBe(true);
  expect(menu().getAttribute("aria-label")).toBe("Resolution/Down Sample Factor: Auto");

  fireEvent.click(menu());
  expect(screen.getByRole("menuitem", { name: "Auto" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("menuitem", { name: "Full" }).getAttribute("aria-checked")).toBe("false");
  fireEvent.click(screen.getByRole("menuitem", { name: "Full" }));
  expect(autoResolution.on).toBe(false);
  expect(menu().getAttribute("aria-label")).toBe("Resolution/Down Sample Factor: Full");
});
