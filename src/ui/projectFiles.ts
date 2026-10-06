// Where projects are read from and written to: the File System Access API
// where the browser has it (so Save writes back to the opened file), a file
// input and a download otherwise.
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

const AEP_TYPE: PickerType = { description: "After Effects Project", accept: { "application/octet-stream": [".aep"] } };
const pickers = () => (typeof window === "undefined" ? {} : (window as unknown as FilePickers));
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** File > Open Project with a handle for Save, when the browser has a file picker. undefined: cancelled; null: no picker. */
export async function pickProjectHandle(): Promise<{ file: File; handle: ProjectHandle } | undefined | null> {
  const { showOpenFilePicker } = pickers();
  if (!showOpenFilePicker) return null;
  try {
    const [handle] = await showOpenFilePicker({ types: [AEP_TYPE], excludeAcceptAllOption: false });
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

async function write(handle: ProjectHandle, bytes: Uint8Array): Promise<void> {
  if (handle.queryPermission && (await handle.queryPermission({ mode: "readwrite" })) !== "granted") {
    if ((await handle.requestPermission?.({ mode: "readwrite" })) !== "granted") throw new Error(`Permission to write ${handle.name} was denied`);
  }
  const writable = await handle.createWritable();
  await writable.write(bytes as BlobPart);
  await writable.close();
}

function download(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface Saved {
  name: string;
  handle?: ProjectHandle;
}

/**
 * Save (to `handle` when there is one) or Save As. Resolves to the saved
 * file's name and handle, or undefined when the user cancelled the picker.
 */
export async function saveProjectBytes(bytes: Uint8Array, name: string, handle: ProjectHandle | undefined, saveAs: boolean): Promise<Saved | undefined> {
  if (handle && !saveAs) {
    await write(handle, bytes);
    return { name: handle.name, handle };
  }
  const suggestedName = /\.aep$/i.test(name) ? name : `${name}.aep`;
  const { showSaveFilePicker } = pickers();
  if (showSaveFilePicker) {
    let target: ProjectHandle;
    try {
      target = await showSaveFilePicker({ suggestedName, types: [AEP_TYPE] });
    } catch (e) {
      if (isAbort(e)) return undefined;
      throw e;
    }
    await write(target, bytes);
    return { name: target.name, handle: target };
  }
  download(bytes, suggestedName);
  return { name: suggestedName };
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
