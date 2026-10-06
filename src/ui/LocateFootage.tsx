// "Locate Footage": the browser cannot follow the project's file paths, so the
// user picks the folder (or files) holding the footage and the footage store
// relinks items by path, like After Effects' relink.
import { useSyncExternalStore } from "react";
import type { CompItem, FootageItem, Project } from "../aep/model.ts";
import { footageStore } from "../media/store.ts";
import { Icon } from "./icons.tsx";
import "./footage.css";

type Picked = { path: string; blob: Blob };

interface DirectoryHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterable<DirectoryHandle | FileHandle>;
}
interface FileHandle {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
}
type DirectoryPicker = (options?: { id?: string; mode?: "read" }) => Promise<DirectoryHandle>;

/** Re-renders the caller whenever footage files are added or decoded frames arrive. */
export function useFootageVersion(): number {
  return useSyncExternalStore(
    (onChange) => footageStore.subscribe(onChange),
    () => footageStore.version,
  );
}

/** Footage used by `comp` (through nested comps) whose file has not been located. */
export function missingFootage(project: Project, comp: CompItem): FootageItem[] {
  const missing = new Set<FootageItem>();
  const seen = new Set<number>();
  const visit = (c: CompItem) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    for (const layer of c.layers) {
      const item = project.items.get(layer.sourceId);
      if (item?.kind === "comp") visit(item);
      else if (item?.kind === "footage" && !footageStore.isLocated(item)) missing.add(item);
    }
  };
  visit(comp);
  return [...missing];
}

async function readDirectory(dir: DirectoryHandle, prefix: string, out: Picked[]): Promise<void> {
  for await (const entry of dir.values()) {
    const path = `${prefix}${entry.name}`;
    if (entry.kind === "file") out.push({ path, blob: await entry.getFile() });
    else await readDirectory(entry, `${path}/`, out);
  }
}

async function readEntry(entry: FileSystemEntry, out: Picked[]): Promise<void> {
  const path = entry.fullPath.replace(/^\//, "");
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.push({ path, blob: file });
    return;
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    for (const child of batch) await readEntry(child, out);
  }
}

/** Adds files and folders dropped on the window to the footage store. */
export async function addDroppedFootage(data: DataTransfer): Promise<number> {
  // Entries must be taken while the drop event is being dispatched.
  const entries = Array.from(data.items ?? [])
    .map((item) => item.webkitGetAsEntry?.())
    .filter((entry): entry is FileSystemEntry => !!entry);
  const picked: Picked[] = [];
  if (entries.length) for (const entry of entries) await readEntry(entry, picked);
  else for (const file of Array.from(data.files)) picked.push({ path: file.name, blob: file });
  return footageStore.addFiles(picked);
}

/** Opens a file input: files keep their path below the chosen folder (`webkitRelativePath`) when `folder` is set. */
function chooseFiles(folder: boolean): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.webkitdirectory = folder;
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    footageStore.addFiles(files.map((file) => ({ path: file.webkitRelativePath || file.name, blob: file })));
  });
  input.click();
}

/** Asks for the folder holding the project's footage (File System Access when available, else a folder input). */
export async function locateFootageFolder(): Promise<void> {
  const picker = (window as unknown as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
  if (!picker) {
    chooseFiles(true);
    return;
  }
  try {
    const dir = await picker({ id: "aep-footage", mode: "read" });
    const picked: Picked[] = [];
    await readDirectory(dir, `${dir.name}/`, picked);
    footageStore.addFiles(picked);
  } catch (e) {
    if ((e as Error).name !== "AbortError") chooseFiles(true);
  }
}

/** Folder and file pickers that feed the footage store (Project panel footer). */
export function LocateFootageButtons() {
  return (
    <>
      <button
        type="button"
        className="foot-btn"
        title="Locate Footage: choose the folder holding the project's footage"
        aria-label="Locate footage folder"
        onClick={() => void locateFootageFolder()}
      >
        <Icon name="footage" size={14} />
      </button>
      <button type="button" className="foot-btn" title="Locate Footage: choose footage files" aria-label="Locate footage files" onClick={() => chooseFiles(false)}>
        <Icon name="link" size={14} />
      </button>
    </>
  );
}
