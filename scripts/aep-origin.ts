// Prints, for .aep files, what their XMP trailer says about the application that saved them.
//
//   node scripts/aep-origin.ts <file or folder>...
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readRifx } from "../src/aep/riff.ts";

function* files(path: string, depth = 0): Generator<string> {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return;
  }
  if (stat.isFile()) {
    if (/\.aep$/i.test(path)) yield path;
    return;
  }
  if (depth > 5) return;
  for (const name of readdirSync(path)) yield* files(join(path, name), depth + 1);
}

for (const path of process.argv.slice(2).flatMap((p) => [...files(p)])) {
  const bytes = readFileSync(path);
  const { xmp } = readRifx(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const tag = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>|${name}="([^"]*)"`).exec(xmp)?.slice(1).find(Boolean) ?? "-";
  const saves = (xmp.match(/stEvt:action(?:>|=")saved/g) ?? []).length;
  console.log(
    `${path}\n  xmp ${xmp.length} bytes, CreatorTool ${tag("xmp:CreatorTool")}, MetadataDate ${tag("xmp:MetadataDate")}, ${saves} saves, mtime ${statSync(path).mtime.toISOString()}`,
  );
}
