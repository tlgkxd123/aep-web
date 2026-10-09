// Compares a movie's sync samples as our demuxer reads them (stss) with the NAL unit types of
// those samples: IDR pictures start a clean decode, other "sync" pictures (recovery points,
// open-GOP I frames) do not.
//
//   node scripts/video-sync.ts <movie.mp4> [samples=200]
import { readFileSync } from "node:fs";
import { demuxVideo } from "../src/media/mp4.ts";

const [file, countArg = "200"] = process.argv.slice(2);
const bytes = readFileSync(file);
const blob = new Blob([bytes]);
const track = await demuxVideo(blob);
console.log(`${track.codec} ${track.width}x${track.height}, ${track.samples.length} samples`);
const lengthSize = track.description ? ((new Uint8Array(track.description as unknown as ArrayBuffer)[4] ?? 3) & 3) + 1 : 4;
const nalTypes = (offset: number, size: number) => {
  const types: number[] = [];
  for (let p = offset; p + lengthSize < offset + size; ) {
    let len = 0;
    for (let k = 0; k < lengthSize; k++) len = len * 256 + bytes[p + k];
    types.push(bytes[p + lengthSize] & 0x1f);
    p += lengthSize + len;
  }
  return types;
};
const sync = track.samples.map((s, i) => ({ s, i })).filter(({ s }) => s.isSync);
console.log(`${sync.length} sync samples (stss); NAL types of the first ${Number(countArg)} samples flagged sync:`);
for (const { s, i } of sync.slice(0, Number(countArg))) {
  const types = nalTypes(s.offset, s.size);
  console.log(`  sample ${i} t=${s.time.toFixed(3)}: NAL ${types.join(",")}${types.includes(5) ? " (IDR)" : " (NOT IDR)"}`);
}
const idrs = track.samples.filter((s) => nalTypes(s.offset, s.size).includes(5)).length;
console.log(`IDR samples in the file: ${idrs}`);
