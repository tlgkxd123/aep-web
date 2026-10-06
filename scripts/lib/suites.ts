// Fixture suites: refs/fixtures/manifest.json (core) plus refs/fixtures/<suite>.manifest.json.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(process.env.AEP_REFS ?? "refs");

export interface SuiteManifest {
  /** Manifest file name, e.g. "manifest.json" or "text.manifest.json". */
  file: string;
  project: string;
  comps: { comp: string; frames: number[]; fps?: number }[];
  /** Accepted approximations, "comp@frame" -> reason. */
  known?: Record<string, string>;
}

export function loadSuites(only?: string): SuiteManifest[] {
  const dir = join(ROOT, "fixtures");
  return readdirSync(dir)
    .filter((f) => f.endsWith("manifest.json"))
    .filter((f) => !only || f === only || f === `${only}.manifest.json` || (only === "fixtures" && f === "manifest.json"))
    .sort()
    .map((file) => ({ file, ...(JSON.parse(readFileSync(join(dir, file), "utf8")) as Omit<SuiteManifest, "file">) }));
}

export const framePath = (comp: string, frame: number) => join(ROOT, "frames", comp, `frame_${String(frame).padStart(5, "0")}.tif`);
