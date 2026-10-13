// Where projects are read from and written to: the File System Access API
// where the browser has it (so Save writes back to the opened file), a file
// input and a download otherwise.
import { Capacitor } from "@capacitor/core";
import { canPickFiles } from "../export/output.ts";
import { saveBlob, type SavedFile } from "../export/saveFile.ts";
import { IMPORTABLE_EXTENSIONS } from "../media/probe.ts";

interface WritableHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: BlobPart): Promise<void>; close(): Promise<void> }>;
  queryPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
}

/** A project file the user opened or saved, writable in place. */
export type ProjectHandle = WritableHandle;

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

interface FilePickers {
  showOpenFilePicker?(options: { types: PickerType[]; multiple?: boolean; excludeAcceptAllOption?: boolean }): Promise<WritableHandle[]>;
  showSaveFilePicker?(options: { suggestedName: string; types: PickerType[] }): Promise<WritableHandle>;
}

/** How a project is saved: the .aep alone, or a .zip of the project and its footage. */
export type ProjectFormat = "aep" | "zip";

const AEP_TYPE: PickerType = { description: "After Effects Project", accept: { "application/octet-stream": [".aep"] } };
const ZIP_TYPE: PickerType = { description: "After Effects Project with its footage", accept: { "application/zip": [".zip"] } };
const OPEN_TYPE: PickerType = {
  description: "After Effects Project or Avee Player template",
  accept: { "application/octet-stream": [".aep", ".viz"], "application/zip": [".zip"] },
};
const pickers = () => (typeof window === "undefined" ? {} : (window as unknown as FilePickers));
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** Whether a file name is a project archive's. */
export const isArchiveName = (name: string) => /\.zip$/i.test(name);
export const formatOf = (name: string): ProjectFormat => (isArchiveName(name) ? "zip" : "aep");
/** `name` with the format's extension in place of a project's. */
export const withExtension = (name: string, format: ProjectFormat) => `${name.replace(/\.(aep|zip)$/i, "")}.${format}`;

/** File > Open Project with a handle for Save, when the browser has a file picker. undefined: cancelled; null: no picker. */
export async function pickProjectHandle(): Promise<{ file: File; handle: ProjectHandle } | undefined | null> {
  if (Capacitor.isNativePlatform()) return null;
  const { showOpenFilePicker } = pickers();
  if (!showOpenFilePicker) return null;
  try {
    const [handle] = await showOpenFilePicker({ types: [OPEN_TYPE], excludeAcceptAllOption: false });
    return { file: await handle.getFile(), handle };
  } catch (e) {
    if (isAbort(e)) return undefined;
    return null;
  }
}

/** The handle of a dropped .aep, when the browser exposes it. Must be called while the drop event is dispatched. */
export function droppedHandle(data: DataTransfer, file: File): Promise<ProjectHandle | undefined> {
  const item = Array.from(data.items ?? []).find((i) => i.kind === "file" && i.getAsFile()?.name === file.name) as
    | (DataTransferItem & { getAsFileSystemHandle?(): Promise<{ kind: string } | null> })
    | undefined;
  const pending = item?.getAsFileSystemHandle?.();
  if (!pending) return Promise.resolve(undefined);
  return pending.then(
    (h) => (h?.kind === "file" ? (h as unknown as ProjectHandle) : undefined),
    () => undefined,
  );
}

async function write(handle: ProjectHandle, data: Blob | Uint8Array): Promise<void> {
  if (handle.queryPermission && (await handle.queryPermission({ mode: "readwrite" })) !== "granted") {
    if ((await handle.requestPermission?.({ mode: "readwrite" })) !== "granted") throw new Error(`Permission to write ${handle.name} was denied`);
  }
  const writable = await handle.createWritable();
  await writable.write(data as BlobPart);
  await writable.close();
}

const asBlob = (data: Blob | Uint8Array) => (data instanceof Uint8Array ? new Blob([data as BlobPart], { type: "application/octet-stream" }) : data);

export interface Saved {
  name: string;
  handle?: ProjectHandle;
}

/** What a save writes, made once the file is chosen, in the format its name calls for. */
export type ProjectContents = (format: ProjectFormat, name: string) => Promise<Blob | Uint8Array>;

async function saveNew(contents: ProjectContents, suggestedName: string, types: PickerType[]): Promise<Saved | undefined> {
  const { showSaveFilePicker } = pickers();
  if (canPickFiles() && showSaveFilePicker) {
    let target: ProjectHandle;
    try {
      target = await showSaveFilePicker({ suggestedName, types });
    } catch (e) {
      if (isAbort(e)) return undefined;
      throw e;
    }
    await write(target, await contents(formatOf(target.name), target.name));
    return { name: target.name, handle: target };
  }
  const saved: SavedFile = await saveBlob(asBlob(await contents(formatOf(suggestedName), suggestedName)), suggestedName);
  return { name: saved.name };
}

/**
 * Save (to `handle` when there is one) or Save As, as an .aep or a .zip. The
 * save picker offers both, `format` first, and the chosen file's name decides.
 * Resolves to the saved file's name and handle, or undefined when the user
 * cancelled the picker.
 */
export async function saveProject(
  contents: ProjectContents,
  name: string,
  format: ProjectFormat,
  handle: ProjectHandle | undefined,
  saveAs: boolean,
): Promise<Saved | undefined> {
  if (handle && !saveAs) {
    await write(handle, await contents(formatOf(handle.name), handle.name));
    return { name: handle.name, handle };
  }
  return saveNew(contents, withExtension(name, format), format === "zip" ? [ZIP_TYPE, AEP_TYPE] : [AEP_TYPE, ZIP_TYPE]);
}

/** Saves the bytes of an .aep: Save (to `handle` when there is one) or Save As. */
export function saveProjectBytes(bytes: Uint8Array, name: string, handle: ProjectHandle | undefined, saveAs: boolean): Promise<Saved | undefined> {
  if (handle && !saveAs) return saveProject(async () => bytes, name, "aep", handle, false);
  return saveNew(async () => bytes, withExtension(name, "aep"), [AEP_TYPE]);
}

/**
 * Saves bytes as a new file of type `extension` (".pmwm") through the browser's
 * save picker, or as a download. Resolves to the saved file's name, or
 * undefined when the user cancelled the picker.
 */
export async function saveFileBytes(bytes: Uint8Array | Blob, name: string, description: string, extension: string): Promise<string | undefined> {
  const suggestedName = name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
  return (await saveNew(async () => bytes, suggestedName, [{ description, accept: { "application/octet-stream": [extension] } }]))?.name;
}

/** The browser's file dialog for footage. Resolves to [] when cancelled. */
export function pickMediaFiles(multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    input.accept = IMPORTABLE_EXTENSIONS.map((e) => `.${e}`).join(",");
    input.addEventListener("change", () => resolve(Array.from(input.files ?? [])));
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}
