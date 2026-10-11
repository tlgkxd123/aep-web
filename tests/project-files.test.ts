// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveBlob: vi.fn(async (_blob: Blob, name: string) => `Documents/aep-web/${name}`),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: vi.fn(() => false) },
}));

vi.mock("../src/export/saveFile.ts", () => ({
  APP_FOLDER: "aep-web",
  saveBlob: mocks.saveBlob,
}));

import { Capacitor } from "@capacitor/core";
import { canPickFiles } from "../src/export/output.ts";
import { saveProjectBytes } from "../src/ui/projectFiles.ts";

describe("project save on native", () => {
  beforeEach(() => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    mocks.saveBlob.mockClear();
    delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });

  it("ignores the WebView save picker in the Android app", () => {
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = vi.fn();
    expect(canPickFiles()).toBe(true);
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    expect(canPickFiles()).toBe(false);
  });

  it("Save writes the .aep through Capacitor Filesystem when native", async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    const picker = vi.fn();
    (window as { showSaveFilePicker?: unknown }).showSaveFilePicker = picker;
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x58]);
    const saved = await saveProjectBytes(bytes, "mobile.aep", undefined, false);
    expect(saved).toEqual({ name: "mobile.aep" });
    expect(picker).not.toHaveBeenCalled();
    expect(mocks.saveBlob).toHaveBeenCalledWith(expect.any(Blob), "mobile.aep");
  });
});
