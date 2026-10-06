// Tallies the raw keyframe header bytes AE writes per ldat kind across the
// corpus (temporal flag byte, interpolation pairs, spatial flag byte), to pick
// templates for keyframes created by the editor.
//   node scripts/scan-keyframes.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeLhd3, ldatItems } from "../src/aep/decode.ts";
import { readRifx, type Chunk } from "../src/aep/riff.ts";
import { SAMPLES } from "./lib/paths.ts";

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (name.toLowerCase().endsWith(".aep")) yield full;
  }
}

const tally = new Map<string, number>();
const lhd3s = new Map<string, number>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function visit(chunk: Chunk, parents: Chunk[]): void {
  if (chunk.type === "LIST" && chunk.listType === "list" && parents[parents.length - 1]?.listType === "tdbs") {
    const lhd3 = chunk.children?.find((c) => c.type === "lhd3");
    const ldat = chunk.children?.find((c) => c.type === "ldat");
    if (lhd3 && ldat) {
      const h = decodeLhd3(lhd3);
      bump(lhd3s, `${h.kind} count=${h.count} ${hex(lhd3.data.subarray(10, 32))}`);
      for (const item of ldatItems(ldat, h)) {
        const extra = h.kind === "twoDSpatial" || h.kind === "threeDSpatial" ? ` sp=${item.u8(11)}` : "";
        bump(tally, `${h.kind} io=${item.u8(4)}${item.u8(5)} flags=${item.u8(7).toString(2)}${extra}`);
      }
    }
  }
  for (const child of chunk.children ?? []) visit(child, [...parents, chunk]);
}

for (const file of walk(SAMPLES)) visit(readRifx(new Uint8Array(readFileSync(file))).root, []);
const print = (m: Map<string, number>, limit: number) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).forEach(([k, v]) => console.log(`${String(v).padStart(6)} ${k}`));
print(tally, 40);
console.log("--- lhd3 headers (bytes 10..32)");
print(lhd3s, 30);
