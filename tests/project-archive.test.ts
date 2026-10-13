// Projects saved as a .zip with their footage: the ZIP format (checked against fflate's own reader and writer), the
// collected layout and the relative links the archived project records, and opening the archive again.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { utf8Of } from "../src/aep/decode.ts";
import type { FootageItem } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { findChild, findList } from "../src/aep/riff.ts";
import { archiveContents, archiveFootage, collectProject, FOOTAGE_FOLDER } from "../src/edit/collect.ts";
import { Editor } from "../src/edit/editor.ts";
import { FootageStore } from "../src/media/store.ts";
import { crc32, isZipHeader, readZip, writeZip, type ZipEntry } from "../src/media/zip.ts";

const media = resolve("refs/media");
const bytesOf = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

async function contents(entries: ZipEntry[]): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  for (const e of entries) out[e.path] = await bytesOf(await e.read());
  return out;
}

describe("zip format", () => {
  const inputs = () => [
    { path: "Project.aep", data: strToU8("RIFX project bytes ".repeat(50)), compress: true },
    { path: "(Footage)/Música/clip ñ.mp4", data: new Blob([readFileSync(join(media, "clip.mp4"))]) },
    { path: "(Footage)/empty.png", data: new Uint8Array(0) },
  ];

  test("CRC-32 matches the standard check value, in one go or in parts", () => {
    const text = strToU8("123456789");
    expect(crc32(text)).toBe(0xcbf43926);
    expect(crc32(text.subarray(5), crc32(text.subarray(0, 5)))).toBe(0xcbf43926);
    const long = new Uint8Array(100_003).map((_, i) => (i * 7919) & 0xff);
    let bitwise = ~0;
    for (const b of long) {
      bitwise ^= b;
      for (let k = 0; k < 8; k++) bitwise = bitwise & 1 ? 0xedb88320 ^ (bitwise >>> 1) : bitwise >>> 1;
    }
    expect(crc32(long)).toBe(~bitwise >>> 0);
  });

  for (const zip64 of [false, true]) {
    test(`archives fflate reads back${zip64 ? " (ZIP64 records)" : ""}`, async () => {
      const { blob, offsets } = await writeZip(inputs(), { zip64 });
      const bytes = await bytesOf(blob);
      expect(isZipHeader(bytes)).toBe(true);
      const unzipped = unzipSync(bytes);
      expect(Object.keys(unzipped)).toEqual(inputs().map((i) => i.path));
      for (const input of inputs()) {
        const expected = input.data instanceof Blob ? await bytesOf(input.data) : input.data;
        expect(unzipped[input.path]).toEqual(expected);
      }
      // Stored entries sit as they are at their offsets: what a written archive's footage is read from.
      const clip = await bytesOf(inputs()[1].data as Blob);
      expect(await bytesOf(blob.slice(offsets[1], offsets[1] + clip.length))).toEqual(clip);
      const read = await readZip(blob);
      expect(read.map((e) => [e.path, e.stored])).toEqual([
        ["Project.aep", false],
        ["(Footage)/Música/clip ñ.mp4", true],
        ["(Footage)/empty.png", true],
      ]);
      expect(await contents(read)).toEqual(unzipped);
    });
  }

  test("reads archives other tools write, deflated or stored, leaving folders out", async () => {
    const bytes = zipSync({
      "Proj folder/": {},
      "Proj folder/Proj.aep": [strToU8("x".repeat(4000)), { level: 9 }],
      "Proj folder/clip.mp4": [readFileSync(join(media, "clip.mp4")), { level: 0 }],
    });
    const read = await readZip(new Blob([bytes as BlobPart]));
    expect(read.map((e) => [e.path, e.stored])).toEqual([
      ["Proj folder/Proj.aep", false],
      ["Proj folder/clip.mp4", true],
    ]);
    const files = await contents(read);
    expect(files["Proj folder/Proj.aep"]).toEqual(strToU8("x".repeat(4000)));
    expect(files["Proj folder/clip.mp4"]).toEqual(new Uint8Array(readFileSync(join(media, "clip.mp4"))));
  });

  test("refuses what is not an archive", async () => {
    await expect(readZip(new Blob([readFileSync(resolve("refs/fixtures/footage.aep"))]))).rejects.toThrow("not a ZIP archive");
    expect(isZipHeader(strToU8("RIFX"))).toBe(false);
  });
});

/** A footage store holding refs/media under the folders the fixture's project recorded. */
function storeWithMedia(): FootageStore {
  const store = new FootageStore(64 << 20);
  const files = readdirSync(media, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  const frames = readdirSync(join(media, "seq")).map((n) => `seq/${n}`);
  store.addFiles([...files, ...frames].map((name) => ({ path: `refs/media/${name}`, blob: new Blob([readFileSync(join(media, name))]) })));
  return store;
}

const fileFootage = (items: Iterable<unknown>) =>
  [...items].filter((i): i is FootageItem => (i as FootageItem).kind === "footage" && (i as FootageItem).mainSource.sourceType === "FileSource");
const sourceOf = (item: FootageItem) => item.mainSource as Extract<FootageItem["mainSource"], { sourceType: "FileSource" }>;

describe("collected project", () => {
  const original = new Uint8Array(readFileSync(resolve("refs/fixtures/footage.aep")));

  test("lays the footage out in (Footage) once per file and links the archived project to it", () => {
    const editor = Editor.fromBytes(original);
    const store = storeWithMedia();
    const { entries, missing } = collectProject(editor, "Footage Test.zip", (item) => store.sourceFiles(item));
    expect(missing.map((m) => m.name)).toEqual(["gone.png"]);
    expect(entries[0].path).toBe("Footage Test.aep");
    const paths = entries.slice(1).map((e) => e.path);
    // Items sharing a file share its one copy; the sequence keeps its folder and frame names.
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.filter((p) => p.endsWith("/straight.png"))).toHaveLength(1);
    expect(paths.filter((p) => /\/seq\/seq_\d{4}\.png$/.test(p))).toHaveLength(12);
    expect(paths.length).toBe(10 + 12);
    expect(paths.every((p) => p.startsWith(`${FOOTAGE_FOLDER}/`))).toBe(true);

    const archived = parseProject(entries[0].data as Uint8Array);
    for (const item of fileFootage(archived.items.values())) {
      const source = sourceOf(item);
      if (item.name === "gone.png") {
        expect(source.file).toContain("aep-footage-");
        continue;
      }
      // The relative link names the file in the archive, below the folder the project shares with it.
      expect(paths).toContain(source.relativePath);
      expect(source.file.replace(/\\/g, "/")).toBe(`C:/Footage Test/${source.relativePath}`);
      const alas = JSON.parse(utf8Of(findChild(findList(findList(item.chunk, "Pin "), "Als2"), "alas")!)) as Record<string, unknown>;
      expect(alas.ascendcount_base).toBe(1);
      expect(alas.ascendcount_target).toBe(source.relativePath.split("/").length);
    }
    // The project being edited keeps its paths.
    expect(sourceOf(fileFootage(editor.project.items.values())[0]).file).toContain("aep-wt");
  });

  test("opens again with every collected file located, from the archive alone", async () => {
    const store = storeWithMedia();
    const { entries } = collectProject(Editor.fromBytes(original), "Footage Test.zip", (item) => store.sourceFiles(item));
    const { blob } = await writeZip(entries);

    const { project, files } = archiveContents(await readZip(blob));
    expect(project.path).toBe("Footage Test.aep");
    const reopened = parseProject(await bytesOf(await project.read()));
    const { footage, complete } = await archiveFootage(files, reopened);
    expect(complete).toBe(true);
    const fresh = new FootageStore(64 << 20);
    fresh.addFiles(footage);
    for (const item of fileFootage(reopened.items.values())) {
      expect([item.name, fresh.isLocated(item)]).toEqual([item.name, item.name !== "gone.png"]);
    }
    const sequence = fileFootage(reopened.items.values()).find((i) => sourceOf(i).sequence)!;
    const frames = fresh.sourceFiles(sequence)!;
    expect(frames.map((f) => f.name)).toEqual(Array.from({ length: 12 }, (_, i) => `seq_${String(i + 1).padStart(4, "0")}.png`));
    expect(await bytesOf(frames[11].blob)).toEqual(new Uint8Array(readFileSync(join(media, "seq", "seq_0012.png"))));
    const clip = fileFootage(reopened.items.values()).find((i) => i.name === "clip.mp4")!;
    expect(await bytesOf(fresh.sourceFiles(clip)![0].blob)).toEqual(new Uint8Array(readFileSync(join(media, "clip.mp4"))));
  });

  test("an archive's project is the .aep nearest its top, and files no footage names make it incomplete", async () => {
    const aep = readFileSync(resolve("refs/fixtures/footage.aep"));
    const bytes = zipSync({
      "__MACOSX/Proj/._Proj.aep": strToU8("junk"),
      "Proj/Adobe After Effects Auto-Save/Proj auto-save 1.aep": [aep, { level: 0 }],
      "Proj/Proj.aep": [aep, { level: 0 }],
      "Proj/footage/photo.jpg": [readFileSync(join(media, "photo.jpg")), { level: 6 }],
      "Proj/notes.txt": [strToU8("unrelated"), { level: 6 }],
    });
    const { project, files } = archiveContents(await readZip(new Blob([bytes as BlobPart])));
    expect(project.path).toBe("Proj/Proj.aep");
    const { footage, complete } = await archiveFootage(files, parseProject(new Uint8Array(aep)));
    expect(footage.map((f) => f.path)).toEqual(["Proj/footage/photo.jpg"]);
    expect(complete).toBe(false);
    await expect(readZip(new Blob([zipSync({ "a.txt": strToU8("a") }) as BlobPart])).then(archiveContents)).rejects.toThrow("no After Effects project");
  });
});

test("rebinding swaps the Blobs located files are read from", async () => {
  const store = new FootageStore(1 << 20);
  const before = new Blob([strToU8("old")]);
  const after = new Blob([strToU8("new")]);
  store.addFiles([{ path: "a/b/photo.jpg", blob: before }]);
  const version = store.filesVersion;
  store.rebind(new Map([[before, after]]));
  expect(store.locate("C:/x/b/photo.jpg")).toBe(after);
  expect(store.filesVersion).toBeGreaterThan(version);
});
