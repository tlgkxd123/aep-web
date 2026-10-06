// "Locate Footage": the browser cannot follow the project's file paths, so the
// user picks the folder (or files) holding the footage and the footage store
// relinks items by path, like After Effects' relink.
import { useSyncExternalStore } from "react";
import type { CompItem, FootageItem, Project } from "../aep/model.ts";
import { footageStore } from "../media/store.ts";
import { Icon } from "./icons.tsx";
import "./footage.css";

type Picked = { path: string; blob: Blob };

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

/**
 * Asks for the folder holding the project's footage. A folder input rather than
 * `showDirectoryPicker`: Chromium's File System Access picker refuses Downloads,
 * Desktop, Documents and the home folder themselves.
 */
export async function locateFootageFolder(): Promise<void> {
  chooseFiles(true);
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
