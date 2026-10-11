// @vitest-environment jsdom
// In the Android app, renders and saved projects go to Documents/aep-web through Capacitor Filesystem. Android 11 and
// later let the app create files there but not overwrite one it did not create (left by an earlier install of the
// app, or copied there): that write fails with "EACCES (Permission denied)", which failed renders after all their
// frames were done. Such a file now keeps its name and the new one gets a numbered name; where Documents takes no new
// files at all (Android 10 and earlier with the storage permission refused), the file goes to the app's own folder.
import { Blob as NodeBlob } from "node:buffer";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CompItem, Project } from "../src/aep/model.ts";
import type { Renderer } from "../src/render/renderer.ts";

const android = vi.hoisted(() => {
  const roots: Record<string, string> = {
    DOCUMENTS: "/storage/emulated/0/Documents",
    EXTERNAL: "/storage/emulated/0/Android/data/com.zionschxma.aev3/files",
  };
  const state = {
    roots,
    /** Shared storage, by full path, with the package that created each file. */
    files: new Map<string, { owner: "app" | "other"; bytes: Uint8Array }>(),
    /** How Documents refuses new files: not at all, by the storage permission the user refused, or by path. */
    documents: "open" as "open" | "permission" | "path",
    /** An error other than a refusal, for writes to Documents. */
    failure: null as string | null,
  };
  return state;
});

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
}));

vi.mock("@capacitor/filesystem", () => {
  const error = (message: string, code: string) => Object.assign(new Error(message), { code });
  const full = (directory: string, path: string) => `${android.roots[directory]}/${path}`;
  const decode = (data: string) => new Uint8Array(Buffer.from(data, "base64"));
  return {
    Directory: { Documents: "DOCUMENTS", External: "EXTERNAL" },
    Filesystem: {
      writeFile: vi.fn(async ({ path, data, directory }: { path: string; data: string; directory: string }) => {
        const file = full(directory, path);
        const existing = android.files.get(file);
        if (directory === "DOCUMENTS") {
          if (android.documents === "permission") throw error("Unable to do file operation, user denied permission request.", "OS-PLUG-FILE-0007");
          if (android.failure) throw error(`'writeFile' failed with: ${file}: open failed: ${android.failure}`, "OS-PLUG-FILE-0013");
          if (existing && existing.owner !== "app") throw error(`'writeFile' failed with: ${file}: open failed: EACCES (Permission denied)`, "OS-PLUG-FILE-0013");
          if (!existing && android.documents === "path") throw error("'writeFile' failed with: Permission denied", "OS-PLUG-FILE-0013");
        }
        android.files.set(file, { owner: "app", bytes: decode(data) });
        return { uri: `file://${encodeURI(file)}` };
      }),
      appendFile: vi.fn(async ({ path, data, directory }: { path: string; data: string; directory: string }) => {
        const file = full(directory, path);
        const existing = android.files.get(file);
        if (existing?.owner !== "app") throw error(`'appendFile' failed with: ${file}: open failed: EACCES (Permission denied)`, "OS-PLUG-FILE-0013");
        const added = decode(data);
        const bytes = new Uint8Array(existing.bytes.length + added.length);
        bytes.set(existing.bytes);
        bytes.set(added, existing.bytes.length);
        existing.bytes = bytes;
      }),
      stat: vi.fn(async ({ path, directory }: { path: string; directory: string }) => {
        const file = full(directory, path);
        if (!android.files.has(file)) throw error(`'stat' failed because file at '${file}' does not exist.`, "OS-PLUG-FILE-0008");
        return { type: "file", size: android.files.get(file)!.bytes.length, uri: `file://${file}` };
      }),
    },
  };
});

import { Filesystem } from "@capacitor/filesystem";
import { saveBlob } from "../src/export/saveFile.ts";
import { renderQueue } from "../src/export/queue.ts";
import { RenderQueuePanel } from "../src/ui/RenderQueuePanel.tsx";

const DOCUMENTS = `${android.roots.DOCUMENTS}/aep-web`;
const APP_FOLDER = `${android.roots.EXTERNAL}/aep-web`;
const bytesOf = (n: number, seed = 0) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const other = (bytes: Uint8Array) => ({ owner: "other" as const, bytes });

beforeEach(() => {
  // jsdom's Blob cannot be read back; the WebView's can.
  vi.stubGlobal("Blob", NodeBlob);
  android.files.clear();
  android.documents = "open";
  android.failure = null;
  vi.mocked(Filesystem.writeFile).mockClear();
  vi.mocked(Filesystem.appendFile).mockClear();
  vi.mocked(Filesystem.stat).mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("a file goes to Documents/aep-web under its name, written in parts", async () => {
  const bytes = bytesOf(3 * 1024 * 1024 + 1000);
  expect(await saveBlob(new Blob([bytes]), "Comp 1.mp4")).toEqual({ name: "Comp 1.mp4", folder: "Documents/aep-web" });
  expect(Buffer.from(android.files.get(`${DOCUMENTS}/Comp 1.mp4`)!.bytes).equals(bytes)).toBe(true);
  expect(Filesystem.appendFile).toHaveBeenCalledTimes(2);
});

test("a file of the same name the app may not overwrite keeps it, and the new file gets a numbered name", async () => {
  const left = bytesOf(10, 1);
  android.files.set(`${DOCUMENTS}/Comp 1.mp4`, other(left));
  android.files.set(`${DOCUMENTS}/Comp 1 (2).mp4`, other(left));
  const bytes = bytesOf(100);
  expect(await saveBlob(new Blob([bytes]), "Comp 1.mp4")).toEqual({ name: "Comp 1 (3).mp4", folder: "Documents/aep-web" });
  expect(android.files.get(`${DOCUMENTS}/Comp 1 (3).mp4`)?.bytes).toEqual(bytes);
  expect(android.files.get(`${DOCUMENTS}/Comp 1.mp4`)?.bytes).toEqual(left);
  expect(android.files.get(`${DOCUMENTS}/Comp 1 (2).mp4`)?.bytes).toEqual(left);
});

test("the app's own file of the same name is replaced", async () => {
  android.files.set(`${DOCUMENTS}/shot.aep`, { owner: "app", bytes: bytesOf(50, 2) });
  const bytes = bytesOf(20);
  expect(await saveBlob(new Blob([bytes]), "shot.aep")).toEqual({ name: "shot.aep", folder: "Documents/aep-web" });
  expect(android.files.get(`${DOCUMENTS}/shot.aep`)?.bytes).toEqual(bytes);
});

test("characters Android refuses in file names become underscores", async () => {
  expect((await saveBlob(new Blob([bytesOf(4)]), 'Shot 16:9 "final"?.aep')).name).toBe("Shot 16_9 _final__.aep");
  expect(android.files.has(`${DOCUMENTS}/Shot 16_9 _final__.aep`)).toBe(true);
});

test("with the storage permission refused, the file goes to the app's own folder", async () => {
  android.documents = "permission";
  const bytes = bytesOf(100);
  expect(await saveBlob(new Blob([bytes]), "Comp 1.mp4")).toEqual({ name: "Comp 1.mp4", folder: "Android/data/com.zionschxma.aev3/files/aep-web" });
  expect(android.files.get(`${APP_FOLDER}/Comp 1.mp4`)?.bytes).toEqual(bytes);
  expect(Filesystem.stat).not.toHaveBeenCalled();
});

test("where Documents refuses new files by path, the file goes to the app's own folder", async () => {
  android.documents = "path";
  expect(await saveBlob(new Blob([bytesOf(10)]), "Comp 1.mp4")).toEqual({ name: "Comp 1.mp4", folder: "Android/data/com.zionschxma.aev3/files/aep-web" });
  expect(android.files.has(`${APP_FOLDER}/Comp 1.mp4`)).toBe(true);
});

test("other write failures are reported, not hidden", async () => {
  android.failure = "ENOSPC (No space left on device)";
  await expect(saveBlob(new Blob([bytesOf(10)]), "Comp 1.mp4")).rejects.toThrow(/No space left on device/);
  expect(android.files.size).toBe(0);
});

test("the app asks Android 10 for the storage that lets it write Documents/aep-web by path", () => {
  const manifest = readFileSync(resolve(import.meta.dirname, "../android/app/src/main/AndroidManifest.xml"), "utf8");
  expect(manifest).toMatch(/<application[^>]*android:requestLegacyExternalStorage="true"/);
  expect(manifest).toContain('<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />');
});

test("a render whose file name is taken is saved under a numbered name, and the Render Queue says so", async () => {
  android.files.set(`${DOCUMENTS}/Shot 16_9.zip`, other(bytesOf(10, 3)));
  const comp = {
    kind: "comp",
    id: 7,
    name: "Shot 16:9",
    width: 8,
    height: 6,
    pixelAspect: 1,
    duration: 0.2,
    frameRate: 10,
    frameDuration: 0.1,
    workAreaStart: 0,
    workAreaDuration: 0.2,
    bgColor: [0, 0, 0],
    layers: [],
  } as unknown as CompItem;
  const project = { items: new Map([[comp.id, comp]]) } as unknown as Project;
  renderQueue.createRenderer = () =>
    ({
      requestFootage: () => true,
      render: () => ({}),
      lastComplete: true,
      lastWarnings: [],
      readPixels: (_target: unknown, width: number, height: number) => new Uint8Array(width * height * 4).fill(200),
      release: () => {},
      clearCaches: () => {},
      gl: { canvas: {} },
    }) as unknown as Renderer;
  const item = renderQueue.add(project, comp);
  renderQueue.setOutput(item.id, { ...item.output, format: "png" });
  render(<RenderQueuePanel project={project} activeComp={comp} />);
  expect(screen.getByText("Shot 16_9.zip (saved to Documents/aep-web)")).toBeTruthy();

  await act(() => renderQueue.render());
  const done = renderQueue.getSnapshot().items[0];
  expect(done.status).toBe("Done");
  expect(done.error).toBeUndefined();
  expect(done.saved).toEqual({ name: "Shot 16_9 (2).zip", folder: "Documents/aep-web" });
  expect(screen.getByText("Shot 16_9 (2).zip (saved to Documents/aep-web)")).toBeTruthy();
  const zip = android.files.get(`${DOCUMENTS}/Shot 16_9 (2).zip`)?.bytes;
  expect(zip?.length).toBe(done.bytes);
  expect(String.fromCharCode(...zip!.subarray(0, 2))).toBe("PK");
});
