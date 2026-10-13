// Loads a project's footage from this machine through the dev server
// (server/local-footage.ts): it opens the paths the project stores and, for
// files that moved, looks next to the project file, then searches the local
// disks like After Effects' relink. Unavailable in static builds; the Locate
// Footage pickers remain.
import { sequenceFrameName } from "../aep/footage.ts";
import type { FootageItem, Project } from "../aep/model.ts";
import { footageStore } from "./store.ts";

interface LocateResult {
  path: string;
  file: string | null;
  siblings?: string[];
}

type FileSource = Extract<FootageItem["mainSource"], { sourceType: "FileSource" }>;

/** Parallel file reads; more makes the browser run out of connections on long sequences. */
const CONCURRENCY = 6;

const token = () => document.querySelector<HTMLMetaElement>('meta[name="aep-local-footage"]')?.content;

export const localFootageAvailable = () => typeof document !== "undefined" && !!token();

// Dev server pages only: lets scripts/check-app-footage.ts inspect what was located.
if (localFootageAvailable()) (window as unknown as { aepFootage: typeof footageStore }).aepFootage = footageStore;

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The sibling files that are frames of `source`'s sequence (all of them when its range is unknown). */
function sequenceFrames(source: FileSource, siblings: string[]): string[] {
  const sequence = source.sequence;
  if (!sequence) return siblings;
  const wanted = new Set<string>();
  for (let n = sequence.startFrame; n <= sequence.endFrame; n++) wanted.add(sequenceFrameName(sequence, n).toLowerCase());
  return siblings.filter((s) => wanted.has(baseName(s).toLowerCase()));
}

/**
 * Locates and loads every file footage item that is not located yet, adding
 * each file as soon as it is read: first what is near `projectFile` (the file
 * the project was opened from), then what the search of the disks finds.
 * Returns how many files were added; files that cannot be read are skipped.
 */
export async function loadLocalFootage(project: Project, projectFile?: File): Promise<number> {
  let added = 0;
  if (projectFile) added += await locateAndLoad(project, projectFile, true);
  return added + (await locateAndLoad(project, projectFile, false));
}

async function locateAndLoad(project: Project, projectFile: File | undefined, nearOnly: boolean): Promise<number> {
  const key = token();
  if (!key) return 0;
  const sources = new Map<string, FileSource>();
  for (const item of project.items.values()) {
    if (item.kind !== "footage" || item.mainSource.sourceType !== "FileSource" || footageStore.isLocated(item)) continue;
    if (item.mainSource.file) sources.set(item.mainSource.file, item.mainSource);
  }
  const paths = [...sources.keys()];
  if (!paths.length) return 0;
  const response = await fetch("/__aep/footage/locate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: key,
      paths,
      sequences: paths.map((p) => !!sources.get(p)!.sequence || sources.get(p)!.targetIsFolder),
      project: projectFile && { name: projectFile.name, size: projectFile.size, lastModified: projectFile.lastModified },
      relative: paths.map((p) => sources.get(p)!.relativePath),
      nearOnly,
    }),
  });
  if (!response.ok) throw new Error(`footage locate failed: ${response.status}`);
  const { results } = (await response.json()) as { results: LocateResult[] };

  // Single files first so ordinary footage shows up before long sequences.
  const jobs: { path: string; file: string }[] = [];
  const sequences: { path: string; file: string }[] = [];
  for (const { path, file, siblings } of results) {
    if (!file) continue;
    if (!siblings?.length) {
      jobs.push({ path, file });
      continue;
    }
    // Keep the project's own folder so the store's path matching links frames to their item.
    const folder = path.replace(/[\\/][^\\/]*$/, "");
    for (const frame of sequenceFrames(sources.get(path)!, siblings)) sequences.push({ path: `${folder}/${baseName(frame)}`, file: frame });
  }
  jobs.push(...sequences);

  let added = 0;
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { path, file } = jobs[next++];
      try {
        const r = await fetch(`/__aep/footage/file?token=${encodeURIComponent(key)}&file=${encodeURIComponent(file)}`);
        if (r.ok) added += footageStore.addFiles([{ path, blob: await r.blob() }]);
      } catch {
        // An unreadable file stays missing; the rest still load.
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return added;
}

export interface LocalEntry {
  name: string;
  path: string;
  folder: boolean;
  size?: number;
}

export interface LocalListing {
  /** "" for the list of drives and user folders. */
  dir: string;
  parent: string | null;
  entries: LocalEntry[];
}

async function post<T>(endpoint: string, body: object): Promise<T> {
  const key = token();
  if (!key) throw new Error("The local footage service is not available");
  const response = await fetch(`/__aep/footage/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: key, ...body }),
  });
  if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? `${endpoint} failed: ${response.status}`);
  return (await response.json()) as T;
}

/** A folder's subfolders and media files; the drives and user folders for "". */
export const browseLocal = (dir: string) => post<LocalListing>("browse", { dir });

/** The absolute paths of picked or dropped files (null where the file cannot be found on disk). */
export async function identifyLocal(files: readonly File[]): Promise<(string | null)[]> {
  if (!localFootageAvailable() || !files.length) return files.map(() => null);
  try {
    const { paths } = await post<{ paths: (string | null)[] }>("identify", {
      files: files.map((f) => ({ name: f.name, size: f.size, lastModified: f.lastModified })),
    });
    return paths;
  } catch {
    return files.map(() => null);
  }
}

/** A file listed by {@link browseLocal}, as a File named like it on disk. */
export async function readLocal(path: string): Promise<File> {
  const key = token();
  const response = await fetch(`/__aep/footage/file?token=${encodeURIComponent(key ?? "")}&file=${encodeURIComponent(path)}`);
  if (!response.ok) throw new Error(`Could not read ${path}`);
  const blob = await response.blob();
  return new File([blob], baseName(path), { type: blob.type });
}
