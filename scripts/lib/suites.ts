// Fixture suites: refs/fixtures/manifest.json (core) plus refs/fixtures/<suite>.manifest.json.
// A suite may also list comps whose renderer only approximates After Effects in
// refs/fixtures/<suite>.approximations.json: they have references but no pixel gate.
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
  /** Footage files the project links to, relative to the refs folder (e.g. "media/clip.mp4"). */
  media?: string[];
}

/** The suites' manifests; with `approximations`, their approximation lists too (for rendering references). */
export function loadSuites(only?: string, approximations = false): SuiteManifest[] {
  const dir = join(ROOT, "fixtures");
  return readdirSync(dir)
    .filter((f) => f.endsWith("manifest.json") || (approximations && f.endsWith(".approximations.json")))
    .filter(
      (f) =>
        !only ||
        f === only ||
        f === `${only}.manifest.json` ||
        f === `${only}.approximations.json` ||
        (only === "fixtures" && f === "manifest.json"),
    )
    .sort()
    .map((file) => ({ file, ...(JSON.parse(readFileSync(join(dir, file), "utf8")) as Omit<SuiteManifest, "file">) }));
}

export const framePath = (comp: string, frame: number) => join(ROOT, "frames", comp, `frame_${String(frame).padStart(5, "0")}.tif`);
