// Loads a project's footage from this machine through the dev server
// (server/local-footage.ts): it opens the paths the project stores and, for
// files that moved, searches the local disks like After Effects' relink.
// Unavailable in static builds; the Locate Footage pickers remain.
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
 * each file as soon as it is read. Returns how many files were added; files
 * that cannot be read are skipped.
 */
export async function loadLocalFootage(project: Project): Promise<number> {
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
    body: JSON.stringify({ token: key, paths, sequences: paths.map((p) => !!sources.get(p)!.sequence || sources.get(p)!.targetIsFolder) }),
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
