import type { Sink } from "./pipeline.ts";
import { saveBlob } from "./saveFile.ts";
import { FORMATS, type Format } from "./settings.ts";

interface SavePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
}

export function canPickFiles(): boolean {
  return typeof (globalThis as SavePickerWindow).showSaveFilePicker === "function";
}

/**
 * Asks where to save the output. Returns null when the user cancels, and undefined when the browser has no
 * save picker (the render then downloads).
 */
export async function pickOutputFile(suggestedName: string, format: Format): Promise<FileSystemFileHandle | null | undefined> {
  const picker = (globalThis as SavePickerWindow).showSaveFilePicker;
  if (!picker) return undefined;
  const info = FORMATS[format];
  try {
    return await picker({ suggestedName, types: [{ description: info.label, accept: { [info.mime]: [`.${info.extension}`] } }] });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
}

export async function fileSink(handle: FileSystemFileHandle): Promise<Sink> {
  const stream = await handle.createWritable();
  return {
    write: (bytes) => stream.write(bytes as Uint8Array<ArrayBuffer>),
    close: () => stream.close(),
    abort: () => stream.abort(),
  };
}

/** Collects the file in memory and hands it to the browser's downloads when closed. */
export function downloadSink(fileName: string, mime: string): Sink {
  let parts: BlobPart[] = [];
  return {
    async write(bytes) {
      parts.push(bytes as Uint8Array<ArrayBuffer>);
    },
    async close() {
      const blob = new Blob(parts, { type: mime });
      parts = [];
      await saveBlob(blob, fileName);
    },
    async abort() {
      parts = [];
    },
  };
}
