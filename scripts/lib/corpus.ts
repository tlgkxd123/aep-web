// The .aep files the editing gates run over: the py-aep sample corpus plus the fixture projects.
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { SAMPLES } from "./paths.ts";
import { ROOT } from "./suites.ts";

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.toLowerCase().endsWith(".aep")) yield full;
  }
}

export function corpusFiles(samplesDir = SAMPLES): string[] {
  return [...walk(resolve(samplesDir)), ...walk(join(ROOT, "fixtures"))];
}
