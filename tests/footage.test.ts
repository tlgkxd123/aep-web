import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, test } from "vitest";
import type { FootageItem } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { demuxVideo } from "../src/media/mp4.ts";
import { decodePsd } from "../src/media/psd.ts";
import { FootageStore } from "../src/media/store.ts";
import { decodeTiff } from "../src/media/tiff.ts";
import { footageFrameIndex } from "../src/render/footage.ts";
import { readTiff } from "../scripts/lib/tiff.ts";

const refs = resolve("refs");
const media = (name: string) => new Uint8Array(readFileSync(join(refs, "media", name)));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test("the MP4 demuxer lists the H.264 clip's samples in presentation order with key frames every 10", async () => {
  const track = await demuxVideo(new Blob([media("clip.mp4")]));
  expect(track.codec).toMatch(/^avc1\.[0-9a-f]{6}$/);
  expect([track.width, track.height]).toEqual([96, 64]);
  expect(track.samples).toHaveLength(30);
  const times = track.samples.map((s) => Math.round(s.time * 30)).sort((a, b) => a - b);
  expect(times).toEqual(Array.from({ length: 30 }, (_, i) => i));
  expect(track.samples.filter((s) => s.isSync).map((s) => Math.round(s.time * 30))).toEqual([0, 10, 20]);
});

test("TIFF footage decodes to the stored samples (LZW and uncompressed, unassociated and associated alpha)", async () => {
  const lzw = await decodeTiff(media("alpha.tif"));
  const raw = await decodeTiff(media("alpha_raw.tif"));
  const reference = readTiff(media("alpha.tif"));
  expect(lzw.kind === "rgba" && [...lzw.data]).toEqual([...reference.data]);
  expect(raw.kind === "rgba" && [...raw.data]).toEqual([...reference.data]);
  const assoc = await decodeTiff(media("alpha_assoc.tif"));
  const stored = media("alpha_assoc.tif");
  expect(assoc.kind === "rgba" && [...assoc.data]).toEqual([...stored.subarray(stored.length - 80 * 60 * 4)]);
});

test("a Photoshop file's merged composite decodes from PackBits planes", () => {
  const width = 3;
  const height = 2;
  const planes = [
    [10, 20, 30, 40, 50, 60],
    [1, 2, 3, 4, 5, 6],
    [200, 200, 200, 100, 100, 100],
    [255, 128, 0, 255, 255, 255],
  ];
  // Each row as one literal PackBits run.
  const rows = planes.flatMap((p) => [p.slice(0, 3), p.slice(3)]).map((row) => [row.length - 1, ...row]);
  const u16 = (n: number) => [n >> 8, n & 255];
  const u32 = (n: number) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
  const bytes = new Uint8Array([
    ...[0x38, 0x42, 0x50, 0x53], ...u16(1), 0, 0, 0, 0, 0, 0, ...u16(4), ...u32(height), ...u32(width), ...u16(8), ...u16(3),
    ...u32(0), ...u32(0), ...u32(0),
    ...u16(1), ...rows.flatMap((r) => u16(r.length)), ...rows.flat(),
  ]);
  const frame = decodePsd(bytes);
  expect(frame.kind === "rgba" && [...frame.data.subarray(0, 8)]).toEqual([10, 1, 200, 255, 20, 2, 200, 128]);
});

test("files are matched to footage by the most trailing path components, then by name", () => {
  const store = new FootageStore();
  const a = new Blob(["a"]);
  const b = new Blob(["b"]);
  store.addFiles([
    { path: "project/media/shot.png", blob: a },
    { path: "other/shot.png", blob: b },
  ]);
  expect(store.locate("C:\\work\\project\\media\\shot.png")).toBe(a);
  expect(store.locate("/Volumes/x/other/SHOT.png")).toBe(b);
  expect(store.locate("D:/elsewhere/shot.png")).toBe(a);
  expect(store.locate("D:/elsewhere/clip.mov")).toBeUndefined();
});

test("the fixture's footage is located from refs/media, except the deleted file and the placeholder", () => {
  const project = parseProject(new Uint8Array(readFileSync(join(refs, "fixtures", "footage.aep"))));
  const store = new FootageStore();
  const footage = [...project.items.values()].filter((i): i is FootageItem => i.kind === "footage" && i.mainSource.sourceType !== "SolidSource");
  expect(footage.every((item) => !store.isLocated(item))).toBe(true);
  store.addFiles(files(join(refs, "media")).map((path) => ({ path: relative(refs, path), blob: new Blob([readFileSync(path)]) })));
  const missing = footage.filter((item) => !store.isLocated(item)).map((item) => item.name);
  expect(missing.sort()).toEqual(["footage placeholder", "gone.png"]);
  const sequence = footage.find((item) => item.name.startsWith("seq_["))!;
  expect(store.frame(sequence, 11).status).not.toBe("missing");
  expect(store.frame(sequence, 12)).toEqual({ status: "missing", path: expect.stringMatching(/seq_0001\.png$/) });
});

test("source frames follow AE: floor of time x rate at exact boundaries, loops wrap, the end holds", () => {
  const item = { frameRate: 30, duration: 1, mainSource: { isStill: false, loop: 1 } } as FootageItem;
  expect([0, 1, 2, 3, 4, 8].map((k) => footageFrameIndex(item, k / 24))).toEqual([0, 1, 2, 3, 5, 10]);
  expect(footageFrameIndex(item, 5)).toBe(29);
  expect(footageFrameIndex(item, -1)).toBe(0);
  const looped = { frameRate: 24, duration: 1.5, mainSource: { isStill: false, loop: 3 } } as FootageItem;
  expect([0, 11, 12, 13, 35].map((k) => footageFrameIndex(looped, k / 24))).toEqual([0, 11, 0, 1, 11]);
  const still = { frameRate: 0, duration: 0, mainSource: { isStill: true, loop: 1 } } as FootageItem;
  expect(footageFrameIndex(still, 3.7)).toBe(0);
});
