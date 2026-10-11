// Prints a movie's GOP structure: codec, frame count, key frame spacing, and for H.264 the share of samples no
// other sample references (nal_ref_idc 0), which a decoder may skip when they are not shown.
//
//   node scripts/video-gop.ts <movie>
import { openAsBlob } from "node:fs";
import { demuxVideo } from "../src/media/mp4.ts";
import { isNonReference } from "../src/media/video.ts";

const blob = await openAsBlob(process.argv[2]);
const track = await demuxVideo(blob);
const keys = track.samples.map((s, i) => (s.isSync ? i : -1)).filter((i) => i >= 0);
const gaps = keys.slice(1).map((k, i) => k - keys[i]);
let nonRef = 0;
for (const s of track.samples) {
  const bytes = new Uint8Array(await blob.slice(s.offset, s.offset + s.size).arrayBuffer());
  if (isNonReference(track, bytes)) nonRef++;
}
console.log(`${track.codec} ${track.width}x${track.height}, ${track.samples.length} samples, ${keys.length} key frames`);
console.log(`key frame spacing: min ${Math.min(...gaps)}, max ${Math.max(...gaps)}, mean ${(gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length)).toFixed(1)}`);
console.log(`non-reference samples: ${nonRef} (${((100 * nonRef) / track.samples.length).toFixed(1)}%)`);
let key = -1;
const early = track.samples.filter((s, i) => {
  if (s.isSync) key = i;
  return key < 0 || s.time < track.samples[key].time - 1e-9;
}).length;
const reordered = track.samples.filter((s, i) => i > 0 && s.time < track.samples[i - 1].time).length;
console.log(`samples shown before their GOP's key frame: ${early}; samples shown before the previous one (B-frames): ${reordered}`);
console.log(`first times: ${track.samples.slice(0, 8).map((s) => `${s.time.toFixed(4)}${s.isSync ? "K" : ""}`).join(" ")}`);
