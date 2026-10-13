// Avee Player templates (src/viz/): reading scene.json and the .viz container, and the After Effects project a
// template converts to, as it reads back from the saved file. The template here is authored by the test, with the
// property shapes Avee Player writes (docs/viz-format.md); the user's own templates are converted when present.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentValue, setExpressionScope } from "../src/aep/evaluate.ts";
import type { CompItem, Layer, Property, PropertyGroup } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";
import "../src/expressions/install.ts";
import { writeZip } from "../src/media/zip.ts";
import { AS } from "../src/quickstart/build.ts";
import { convertViz } from "../src/viz/convert.ts";
import { argb, hsla, imageSource, measure, parseScene, referencedCompositions, vector, vizFromArchive, vizFromFiles, type VizElement } from "../src/viz/scene.ts";
import { kicks, PNG, sceneJson, SECONDS, SONG, template } from "./vizTemplate.ts";

afterEach(() => setExpressionScope(undefined));

// ---------------------------------------------------------------- reading back

const comps = (editor: Editor) => {
  const project = Editor.fromBytes(editor.save()).project;
  const byName = new Map([...project.items.values()].filter((i): i is CompItem => i.kind === "comp").map((c) => [c.name, c]));
  return { project, byName };
};
const groupOf = (layer: Layer, matchName: string) =>
  (layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === matchName)?.children ?? []).filter((n): n is PropertyGroup => n.kind === "group");
const effects = (layer: Layer) => groupOf(layer, "ADBE Effect Parade");
const masks = (layer: Layer) => groupOf(layer, "ADBE Mask Parade").filter((m) => !!m.mask);
const param = (effect: PropertyGroup, n: number) =>
  effect.children.find((c): c is Property => c.kind === "property" && c.matchName === `${effect.matchName}-${String(n).padStart(4, "0")}`)!;
const transform = (layer: Layer, matchName: string) =>
  layer.properties.find((n): n is PropertyGroup => n.matchName === "ADBE Transform Group")!.children.find((c) => c.matchName === matchName) as Property;

describe("scene.json", () => {
  it("reads the self-describing properties", () => {
    const scene = parseScene(sceneJson());
    expect(scene.compositions.map((c) => c.map((e) => e.objType))).toEqual([
      ["AudioProvider", "Image", "Image", "Image", "CustomShader", "Text"],
      ["MirrorEffect", "Image"],
      ["Bars"],
      ["Image"],
      ["Image"],
    ]);
    const bars = scene.compositions[2][0];
    expect(vector(bars, "scale", [1, 1])).toEqual([0.455, 0.455]);
    expect(argb(-65536)).toEqual([1, 0, 0, 1]);
    const fade = scene.compositions[0][3];
    expect(hsla(fade, "ColorTo")).toEqual([1, 1, 1, 0]);
    // Amounts are kept past the slider ranges their types declare.
    expect(measure(fade, "MeasureColorBlend")).toEqual({ what: "TrackPosition", a: 10, b: 0 });
    expect(measure(fade, "measureScale")).toBeUndefined();
    expect(imageSource("local:1000160814 (2)null")).toEqual({ kind: "asset", name: "1000160814 (2)null" });
    expect(imageSource("internalres:transparent")).toEqual({ kind: "none" });
    expect(referencedCompositions(scene.compositions[1][1])).toEqual([3]);
  });

  it("refuses what is not an Avee Player scene", () => {
    expect(() => parseScene("{")).toThrow("not valid JSON");
    expect(() => parseScene(JSON.stringify({ objType: "Root" }))).toThrow("no compositions");
  });

  it("comes from a .viz archive or an unpacked folder, with the template's images beside it", async () => {
    const files = [
      { path: "Ring Test/scene.json", data: new TextEncoder().encode(sceneJson()) },
      { path: "Ring Test/bg", data: PNG },
    ];
    const { blob } = await writeZip(files);
    const zipped = await vizFromArchive(blob, "Ring Test.viz");
    expect(zipped?.name).toBe("Ring Test");
    expect([...(zipped?.assets.keys() ?? [])]).toEqual(["bg"]);
    const unpacked = await vizFromFiles(files.map((f) => ({ path: f.path, blob: new Blob([f.data]) })));
    expect(unpacked?.name).toBe("Ring Test");
    expect(unpacked?.scene.compositions).toHaveLength(5);
    // An archive holding an After Effects project is a project, not a template.
    const { blob: project } = await writeZip([...files, { path: "Ring Test/Ring Test.aep", data: new Uint8Array(4) }]);
    expect(await vizFromArchive(project, "Ring Test.zip")).toBeUndefined();
  });
});

describe("a converted template", () => {
  it("makes the compositions the template shows, its images footage, and reports what it leaves out", async () => {
    const { editor, report, footage } = await convertViz(template(), { song: SONG, audio: kicks() });
    expect(editor.history).toEqual([]);
    const { project, byName } = comps(editor);
    expect([...byName.keys()].sort()).toEqual(["Ring Test", "Ring Test 1", "Ring Test 2", "Ring Test 3"]);
    expect(project.items.get(byName.get("Ring Test 1")!.parentFolderId)?.name).toBe("Ring Test Compositions");
    expect(footage.map((f) => f.path)).toEqual(["Ring Test/bg.png", "Ring Test/logo.jpg"]);
    expect(report).toContain('"Text" elements are not converted.');
    expect(report).toContain('Custom shader "shake by someone" is approximated by a shake that follows the beat (After Effects cannot run its GLSL).');
    expect(report.some((line) => /could not be converted/.test(line))).toBe(false);
  });

  it("stacks the main comp bottom first, with the beat keyed on Controls and followed by expressions", async () => {
    const { editor } = await convertViz(template(), { song: SONG, audio: kicks() });
    const { project, byName } = comps(editor);
    const main = byName.get("Ring Test")!;
    expect(main).toMatchObject({ width: 1920, height: 1080, frameRate: 30 });
    expect(main.duration).toBeCloseTo(SECONDS, 6);
    expect(main.layers.map((l) => l.name)).toEqual(["shake by someone", "Fade in", "Ring Test 1", "Background", "Controls", "song.wav"]);

    const [shake, fade, ring, background] = main.layers;
    // The background covers the frame; the precomp keeps its box.
    const png = new DataView(PNG.buffer, PNG.byteOffset);
    const [width, height] = [png.getUint32(16), png.getUint32(20)];
    expect((transform(background, "ADBE Scale").value as number[])[0]).toBeCloseTo(100 * Math.max(1920 / width, 1080 / height), 3);
    expect((transform(ring, "ADBE Scale").value as number[]).slice(0, 2).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([115, 115]);
    // A black image over what the comp drew dims it, without covering what lies under the comp.
    expect(fade.adjustmentLayer).toBe(true);
    expect(effects(fade).map((e) => e.matchName)).toEqual(["ADBE Fill"]);

    setExpressionScope({ project, warn: (message) => expect.fail(message) });
    const controls = main.layers.find((l) => l.name === "Controls")!;
    const beat = param(effects(controls).find((e) => e.name === "Beat")!, 1);
    expect(beat.keyframes.length).toBeGreaterThan(4);
    const at = (layer: Layer, matchName: string, t: number) => currentValue(transform(layer, matchName), t, layer) as number | number[];
    // On a kick the ring grows by up to 20 %, between kicks it rests at its size.
    const level = (t: number) => (currentValue(beat, t, controls) as number) / 100;
    expect((at(ring, "ADBE Scale", 1 + 1 / 30) as number[])[0]).toBeCloseTo(115 * (1 + 0.2 * level(1 + 1 / 30)), 3);
    expect(level(1 + 1 / 30)).toBeGreaterThan(0.7);
    expect((at(ring, "ADBE Scale", 1.4) as number[])[0]).toBeCloseTo(115 * (1 + 0.2 * level(1.4)), 3);
    // The fade-in reaches full transparency a tenth of the way through the song.
    expect(at(fade, "ADBE Opacity", 0)).toBeCloseTo(100, 6);
    expect(at(fade, "ADBE Opacity", (0.05 * SECONDS) as number)).toBeCloseTo(50, 3);
    expect(at(fade, "ADBE Opacity", 0.2 * SECONDS)).toBeCloseTo(0, 6);
    // The shake shader moves its precomp with the beat.
    expect(transform(shake, "ADBE Position").expression).toMatch(/wiggle\(/);
  });

  it("mirrors the ring, masks the logo with its mask composition, and draws the bars from the song", async () => {
    const { editor } = await convertViz(template(), { song: SONG, audio: kicks() });
    const { byName } = comps(editor);
    const mirror = byName.get("Ring Test 1")!;
    expect(mirror.layers.map((l) => l.name)).toEqual(["Logo (mask)", "Logo", "Ring Test 2"]);
    const [matte, logo, ring] = mirror.layers;
    expect(effects(ring).map((e) => [e.matchName, param(e, 2).value])).toEqual([["ADBE Mirror", 0]]);
    expect((transform(ring, "ADBE Scale").value as number[]).slice(0, 2).map((v) => Math.round(v * 1e6) / 1e6)).toEqual([90, 90]);
    expect(masks(logo).map((m) => m.name)).toEqual(["Circle"]);
    expect({ type: logo.trackMatteType, matte: logo.trackMatteLayerId }).toEqual({ type: 5014, matte: matte.id });
    expect(matte.parentId).toBe(logo.id);
    expect(matte.enabled).toBe(false);

    const barsComp = byName.get("Ring Test 2")!;
    expect(barsComp.layers.map((l) => l.name)).toEqual(["Bars", "song.wav"]);
    const [bars, song] = barsComp.layers;
    // The spectra read the comp's own song layer, heard in the main comp only.
    expect(song.audioEnabled).toBe(false);
    const spectra = effects(bars);
    expect(spectra.map((e) => e.matchName)).toEqual(Array(8).fill("ADBE AudSpect"));
    const value = (n: number) => spectra.map((s) => param(s, n).value as number);
    // Mirrored by its parent, the ring shows the lower half of what Avee spreads round the circle (45–500 Hz), cut
    // into consecutive pieces, each along its own path and reading the comp's song layer.
    expect(value(AS.startFrequency)[0]).toBeCloseTo(45, 6);
    expect(value(AS.endFrequency).at(-1)).toBeCloseTo(272.5, 6);
    value(AS.startFrequency).slice(1).forEach((lo, i) => expect(lo).toBeCloseTo(value(AS.endFrequency)[i], 6));
    expect(value(AS.path)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(value(AS.audioLayer))).toEqual(new Set([song.index]));
    expect(new Set(value(AS.duration))).toEqual(new Set([150]));
    expect(value(AS.bands).reduce((a, b) => a + b)).toBe(2000);
    expect(param(spectra[0], AS.insideColor).value).toEqual([1, 0, 0, 1]);
    expect(param(spectra[0], AS.outsideColor).value).toEqual([0, 0, 1, 1]);
    // The loudest piece (the kicks' 55 Hz) keeps the template's height; quieter pieces are drawn taller, so the whole
    // ring moves as Avee's does.
    const heights = value(AS.maxHeight);
    const base = (2.75 * 0.1 / (2.75 * 0.1)) * 600 * (((0.455 * 1080) / 2) / 270);
    expect(Math.min(...heights)).toBeCloseTo(base, 3);
    expect(heights[0]).toBeCloseTo(base, 3);
    expect(Math.max(...heights)).toBeGreaterThan(base * 2);
    // The pieces run from the top of a circle 0.455 of the frame's height across, round its left half to the bottom.
    const radius = (0.455 * 1080) / 2;
    const vertices = masks(bars).flatMap((m) => ((m.children.find((c) => c.matchName === "ADBE Mask Shape") as Property).value as unknown as { vertices: number[][] }).vertices);
    expect(vertices[0][0]).toBeCloseTo(960, 3);
    expect(vertices[0][1]).toBeCloseTo(540 - radius, 3);
    expect(vertices.at(-1)![1]).toBeCloseTo(540 + radius, 3);
    expect(Math.min(...vertices.map((v) => v[0]))).toBeCloseTo(960 - radius, 3);
  });

  it("converts without a song into still 30-second comps, and says so", async () => {
    const { editor, report } = await convertViz(template());
    const { byName } = comps(editor);
    expect(byName.get("Ring Test")!.duration).toBeCloseTo(30, 6);
    const [bars] = byName.get("Ring Test 2")!.layers;
    expect(bars.name).toBe("Bars");
    // Without the song to measure, the ring is one piece.
    expect(effects(bars).map((e) => [param(e, AS.startFrequency).value, param(e, AS.endFrequency).value])).toEqual([[45, 272.5]]);
    expect(report).toContain("Without a song, the spectrum bars stay flat and nothing follows the beat.");
  });
});

// The user's own templates, when this machine has them: they convert with nothing failing.
const downloads = join(homedir(), "Downloads");
const samples = existsSync(downloads) ? readdirSync(downloads).filter((n) => /\.viz$/i.test(n)).map((n) => join(downloads, n)) : [];
describe.skipIf(!samples.length)("the templates in Downloads", () => {
  const filesBelow = (dir: string): { path: string; blob: Blob }[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? filesBelow(full) : [{ path: relative(join(dir, ".."), full).replace(/\\/g, "/"), blob: new Blob([readFileSync(full)]) }];
    });
  it.each(samples)("%s converts", async (path) => {
    const viz = statSync(path).isDirectory() ? await vizFromFiles(filesBelow(path)) : await vizFromArchive(new Blob([readFileSync(path)]), path);
    expect(viz).toBeDefined();
    const { editor, report } = await convertViz(viz!, { song: SONG, audio: kicks() });
    expect(report.filter((line) => /could not be converted/.test(line))).toEqual([]);
    expect(() => Editor.fromBytes(editor.save())).not.toThrow();
  });
});

// Keeps the authoring helpers typed against the reader.
export type { VizElement };
