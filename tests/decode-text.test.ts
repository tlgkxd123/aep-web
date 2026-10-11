// The parser reads chunk types, match names and strings without a TextDecoder when they are short and ASCII, as
// most of a project's are; what it reads must be exactly what the decoders read.
import { expect, test } from "vitest";
import { Bytes, matchNameOf, utf8Of } from "../src/aep/decode.ts";
import { readRifx, type Chunk } from "../src/aep/riff.ts";

const utf8 = new TextDecoder("utf-8");
const latin1 = new TextDecoder("latin1");
const encode = (text: string) => [...new TextEncoder().encode(text)];
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const untilNul = (bytes: Uint8Array) => {
  const nul = bytes.indexOf(0);
  return nul >= 0 ? bytes.subarray(0, nul) : bytes;
};

const SAMPLES: [string, number[]][] = [
  ["a match name padded with NULs", [...encode("ADBE Transform Group"), 0, 0, 0, 0]],
  ["nothing but NULs", [0, 0, 0, 0]],
  ["nothing", []],
  ["control characters", [9, 10, 13, 0x7f, 65]],
  ["UTF-8 text", [...encode("Capa 1 – ñandú 日本 🎬"), 0, 0]],
  ["a byte-order mark", [0xef, 0xbb, 0xbf, ...encode("abc")]],
  ["bytes latin1 reads as windows-1252", [0x41, 0x80, 0x8a, 0x9f, 0xa0, 0xff, 0x42]],
  ["long ASCII", encode("a".repeat(300))],
  ["long text ending in UTF-8", encode(`${"b".repeat(299)}é`)],
];

test.each(SAMPLES)("strings of %s read as the decoders read them", (_, sample) => {
  const bytes = Uint8Array.from(sample);
  const b = new Bytes(Uint8Array.from([7, 7, 7, ...sample]).subarray(1));
  for (const size of [sample.length, sample.length + 8]) {
    expect(b.cstr(2, size)).toBe(utf8.decode(untilNul(bytes)));
    expect(b.ascii(2, size)).toBe(latin1.decode(untilNul(bytes)));
  }
  const chunk: Chunk = { type: "tdmn", offset: 0, data: bytes };
  expect(matchNameOf(chunk)).toBe(utf8.decode(untilNul(bytes)));
  expect(utf8Of(chunk)).toBe(utf8.decode(bytes));
});

test("chunk types read as latin1 reads them, ASCII or not", () => {
  const chunk = (type: number[], body: number[]) => [...type, ...be32(body.length), ...body, ...(body.length & 1 ? [0] : [])];
  const types = [encode("tdmn"), [0x80, 0x41, 0x9f, 0xff], encode("Utf8"), [0x20, 0x7f, 0x00, 0x7e]];
  const body = [...encode("Egg!"), ...types.flatMap((type) => chunk(type, encode("xyz")))];
  const { root } = readRifx(Uint8Array.from([...encode("RIFX"), ...be32(body.length), ...body]));
  expect(root.listType).toBe("Egg!");
  expect(root.children?.map((c) => c.type)).toEqual(types.map((type) => latin1.decode(Uint8Array.from(type))));
  expect(root.children?.map((c) => utf8Of(c))).toEqual(["xyz", "xyz", "xyz", "xyz"]);
});
