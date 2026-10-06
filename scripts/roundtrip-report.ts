// Reads every .aep in the py-aep sample corpus (plus the fixture projects) into
// a chunk tree, writes the tree back with src/aep/write.ts and checks the bytes
// are identical to the original file.
//
//   node scripts/roundtrip-report.ts [--samples DIR] [--require]
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { readRifx } from "../src/aep/riff.ts";
import { writeRifx } from "../src/aep/write.ts";
import { corpusFiles } from "./lib/corpus.ts";
import { SAMPLES } from "./lib/paths.ts";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const samplesDir = resolve(option("--samples") ?? SAMPLES);

const files = corpusFiles(samplesDir);
let identical = 0;
let bytes = 0;
const failures: string[] = [];
const started = performance.now();
for (const file of files) {
  const original = new Uint8Array(readFileSync(file));
  bytes += original.length;
  let written: Uint8Array;
  try {
    written = writeRifx(readRifx(original));
  } catch (error) {
    failures.push(`${file}: ${(error as Error).message}`);
    continue;
  }
  let at = -1;
  const n = Math.min(written.length, original.length);
  for (let i = 0; i < n; i++) {
    if (written[i] !== original[i]) {
      at = i;
      break;
    }
  }
  if (at < 0 && written.length === original.length) identical++;
  else failures.push(`${relative(samplesDir, file)}: ${at >= 0 ? `first difference at byte ${at}` : `length ${written.length} vs ${original.length}`}`);
}
const seconds = (performance.now() - started) / 1000;
console.log(`files: ${files.length} (${(bytes / 1e6).toFixed(1)} MB), byte-identical: ${identical}, time: ${seconds.toFixed(1)}s`);
for (const f of failures.slice(0, 30)) console.log(`  DIFF ${f}`);
if (args.includes("--require")) {
  if (files.length >= 500 && identical === files.length) console.log("ROUNDTRIP-PASSED");
  else {
    console.log("round-trip requirement not met");
    process.exit(1);
  }
}
