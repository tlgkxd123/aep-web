// Loads a project's footage from this machine through the dev server
// (server/local-footage.ts): it opens the paths the project stores and, for
// files that moved, searches the local disks like After Effects' relink.
// Unavailable in static builds; the Locate Footage pickers remain.
import type { FootageItem, Project } from "../aep/model.ts";
import { footageStore } from "./store.ts";

interface LocateResult {
  path: string;
  file: string | null;
  siblings?: string[];
}

const token = () => document.querySelector<HTMLMetaElement>('meta[name="aep-local-footage"]')?.content;

export const localFootageAvailable = () => typeof document !== "undefined" && !!token();

/** Locates and loads every file footage item that is not located yet. Returns how many files were added. */
export async function loadLocalFootage(project: Project): Promise<number> {
  const key = token();
  if (!key) return 0;
  const items = [...project.items.values()].filter(
    (item): item is FootageItem => item.kind === "footage" && item.mainSource.sourceType === "FileSource" && !footageStore.isLocated(item),
  );
  const sources = items.map((item) => item.mainSource as Extract<FootageItem["mainSource"], { sourceType: "FileSource" }>);
  const paths = [...new Set(sources.map((s) => s.file).filter(Boolean))];
  if (!paths.length) return 0;
  const sequence = new Map(sources.map((s) => [s.file, !!s.sequence || s.targetIsFolder]));
  const response = await fetch("/__aep/footage/locate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: key, paths, sequences: paths.map((p) => sequence.get(p) ?? false) }),
  });
  if (!response.ok) throw new Error(`footage locate failed: ${response.status}`);
  const { results } = (await response.json()) as { results: LocateResult[] };

  const fetchFile = async (file: string) => {
    const r = await fetch(`/__aep/footage/file?token=${encodeURIComponent(key)}&file=${encodeURIComponent(file)}`);
    if (!r.ok) throw new Error(`footage read failed: ${r.status} ${file}`);
    return r.blob();
  };
  let added = 0;
  for (const { path, file, siblings } of results) {
    if (!file) continue;
    // Keep the project's own folder so the store's path matching links the file to its item.
    const folder = path.replace(/[\\/][^\\/]*$/, "");
    const files = siblings?.length ? siblings : [file];
    const picked = await Promise.all(
      files.map(async (f) => ({ path: siblings?.length ? `${folder}/${f.split(/[\\/]/).pop()}` : path, blob: await fetchFile(f) })),
    );
    added += footageStore.addFiles(picked);
  }
  return added;
}
