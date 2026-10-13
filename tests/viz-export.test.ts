// Projects as Avee Player templates (src/viz/export.ts): a converted template exports back to the template it came
// from, and a Quick Start project exports its rings, mirror, particles and beat as Avee elements.
import { describe, expect, it } from "vitest";
import { valueAtTime } from "../src/aep/evaluate.ts";
import type { CompItem, FootageItem } from "../src/aep/model.ts";
import type { Chunk } from "../src/aep/riff.ts";
import { effectLibrary } from "../src/edit/effectLibrary.ts";
import { addEffects, newInstance, setInstanceColor, setInstanceNumber } from "../src/edit/effects.ts";
import { addLayer } from "../src/edit/layers.ts";
import { DEFAULT_COMP_SETTINGS, newComposition, newProject } from "../src/edit/project.ts";
import { FootageStore } from "../src/media/store.ts";
import { writeZip } from "../src/media/zip.ts";
import { buildQuickStart, effectsOf, param } from "../src/quickstart/build.ts";
import { convertViz } from "../src/viz/convert.ts";
import schema from "../src/viz/data/schema.json" with { type: "json" };
import { exportViz, hslaText, packArgb } from "../src/viz/export.ts";
import { argb, child, color, hsla, imageSource, measure, num, parseScene, text, vector, vizFromArchive, type VizElement, type VizScene } from "../src/viz/scene.ts";
import { kicks, SONG, template } from "./vizTemplate.ts";

function exported(project: Parameters<typeof exportViz>[0], comp: CompItem, store: FootageStore) {
  const { files, report } = exportViz(project, comp, (item: FootageItem) => store.sourceFiles(item));
  const scene = parseScene(new TextDecoder().decode(files[0].data as Uint8Array));
  return { files, report, scene };
}

const all = (scene: VizScene) => scene.compositions.flat();
const ofType = (scene: VizScene, type: string) => all(scene).filter((e) => e.objType === type);
const providerOf = (scene: VizScene, bars: VizElement) => ofType(scene, "AudioProvider")[num(bars, "audioProviderIndex") - 1];

describe("an Avee template exported from its conversion", () => {
  async function roundTrip() {
    const converted = await convertViz(template(), { song: SONG, audio: kicks() });
    const store = new FootageStore(64 << 20);
    store.addFiles(converted.footage);
    return { converted, ...exported(converted.editor.project, converted.comp, store) };
  }

  it("draws what the template drew, element for element", async () => {
    const { scene, files } = await roundTrip();
    expect(files.map((f) => f.path)).toEqual(["scene.json", "bg.png", "logo.jpg"]);
    const [main] = scene.compositions;
    expect(main.map((e) => e.objType)).toEqual(["AudioProvider", "Image", "Image", "Image", "Image"]);
    const [, background, ring, fade, shake] = main;
    expect(text(background, "customImage")).toBe("local:bg.png");
    expect(vector(background, "position", [0, 0])).toEqual([0.5, 0.5]);
    // The precomp the beat bounces by 20 %, at 115 %.
    expect(imageSource(text(ring, "customImage")).kind).toBe("composition");
    expect(vector(ring, "scale", [0, 0]).map((v) => Math.round(v * 1e4) / 1e4)).toEqual([1.15, 1.15]);
    expect(measure(ring, "measureScale")).toEqual({ what: "Beat", a: 0.2, b: 0.2 });
    // The fade from black over the first tenth of the song.
    expect(text(fade, "customImage")).toBe("internalres:black");
    expect([hsla(fade, "Color")[3], hsla(fade, "ColorTo")[3]]).toEqual([1, 0]);
    expect(measure(fade, "MeasureColorBlend")).toMatchObject({ what: "TrackPosition", a: 10 });
    // The shake shader's beat wiggle.
    expect(measure(shake, "MeasurePos")?.what).toBe("BeatRandomShake");
  });

  it("gives the ring its whole frequency range back, mirrored and masked as before", async () => {
    const { scene } = await roundTrip();
    const [bars] = ofType(scene, "Bars");
    const provider = providerOf(scene, bars);
    expect(num(provider, "lowerHz")).toBeCloseTo(45, 3);
    expect(num(provider, "higherHz")).toBeCloseTo(500, 3);
    expect(num(provider, "audioDurationMs")).toBe(150);
    expect(text(bars, "ShapePath")).toBe("Circle");
    expect(vector(bars, "scale", [0, 0]).map((v) => Math.round(v * 1e4) / 1e4)).toEqual([0.455, 0.455]);
    expect(num(bars, "heightScale")).toBeCloseTo(2.75, 3);
    const segment = child(bars, "Segment1");
    expect([color(segment, "colorFrom"), color(segment, "colorTo")]).toEqual([argb(-65536), argb(-16776961)]);

    const [mirror] = ofType(scene, "MirrorEffect");
    expect(text(mirror, "mirrorMode")).toBe("Horizontal");
    expect(vector(mirror, "scale", [0, 0]).map((v) => Math.round(v * 1e4) / 1e4)).toEqual([0.9, 0.9]);
    const ringComposition = imageSource(text(mirror, "TargetImage"));
    expect(ringComposition.kind === "composition" && scene.compositions[ringComposition.index].map((e) => e.objType)).toEqual(["Bars"]);

    const logo = ofType(scene, "Image").find((e) => text(e, "tag") === "Logo")!;
    expect(text(logo, "customImage")).toBe("local:logo.jpg");
    expect(text(logo, "Shape")).toBe("Circle");
    expect(text(logo, "maskMode")).toBe("InvertedTransparency");
    // The mask image: the white composition, placed relative to the logo's box (through a composition of its own
    // when the logo's box is not the mask's).
    let mask = imageSource(text(logo, "MaskImage"));
    while (mask.kind === "composition" && scene.compositions[mask.index].length === 1 && imageSource(text(scene.compositions[mask.index][0], "customImage")).kind === "composition") {
      mask = imageSource(text(scene.compositions[mask.index][0], "customImage"));
    }
    expect(mask.kind === "composition" && scene.compositions[mask.index].map((e) => text(e, "customImage"))).toEqual(["internalres:white"]);
  });

  it("writes every property Avee Player stores, and converts again", async () => {
    const { scene, files } = await roundTrip();
    for (const e of all(scene)) {
      const keys = Object.keys((schema as Record<string, object>)[e.objType]);
      expect(keys.filter((k) => !(k in e))).toEqual([]);
    }
    const ids = all(scene).map((e) => num(e, "_id"));
    expect(new Set(ids).size).toBe(ids.length);
    const { blob } = await writeZip(files);
    const again = await vizFromArchive(blob, "Ring Test.viz");
    const { report, editor } = await convertViz(again!, { song: SONG, audio: kicks() });
    expect(report.filter((line) => /could not be converted|missing/.test(line))).toEqual([]);
    expect([...editor.project.items.values()].filter((i) => i.kind === "comp").length).toBeGreaterThanOrEqual(4);
  });
});

describe("a Quick Start project exported", () => {
  it("has its stacked rings, mirrored, bouncing and shaking with the beat, and its particles", async () => {
    const { editor, comp } = await buildQuickStart("trap-nation-2018", { song: SONG }, { audio: kicks() });
    const { scene, report } = exported(editor.project, comp, new FootageStore(1 << 20));
    const bars = ofType(scene, "Bars");
    expect(bars.map((b) => num(providerOf(scene, b), "audioDurationMs"))).toEqual([90, 130, 170]);
    // The Quick Start draws 20–250 Hz on the half of the circle its Mirror reflects: Avee's lower half of 20–480 Hz.
    expect(bars.map((b) => [num(providerOf(scene, b), "lowerHz"), num(providerOf(scene, b), "higherHz")])).toEqual([
      [20, 480],
      [20, 480],
      [20, 480],
    ]);
    for (const b of bars) {
      expect(measure(b, "measureScale")).toEqual({ what: "Beat", a: 0.1, b: 0.1 });
      expect(measure(b, "MeasurePos")?.what).toBe("BeatRandomShake");
    }
    const [mirror] = ofType(scene, "MirrorEffect");
    const target = imageSource(text(mirror, "TargetImage"));
    expect(target.kind === "composition" && scene.compositions[target.index].map((e) => e.objType)).toEqual(["Bars", "Bars", "Bars"]);
    const [particles] = ofType(scene, "Particles");
    expect(measure(particles, "MeasureOverallSpeed")?.what).toBe("Beat");
    // The background's gradient and brightness are shaders over the solid; its blur is Avee's Blur Effect.
    const effects = ofType(scene, "CustomShader").map((s) => text(s, "shaderFragment").split(" | ")[0].replace("// aep-web effect: ", ""));
    expect(effects.sort()).toEqual(["ADBE Brightness & Contrast 2", "ADBE Ramp", "ADBE Ramp"]);
    expect(ofType(scene, "BlurEffect")).toHaveLength(1);
    expect(report.some((line) => /left out/.test(line) && /Ramp|Brightness|Blur/.test(line))).toBe(false);
  });
});

describe("effects Avee has no element for", () => {
  /** A comp with a solid under Tint, Gradient Ramp, Minimax (no shader) and a Slider Control, a precomp glowing, and a comp nothing uses. */
  async function project() {
    const library = new Map((await effectLibrary()).map((e) => [e.matchName, e.template]));
    const fx = (matchName: string, fill: (sspc: Chunk) => void = () => {}) => {
      const template = library.get(matchName)!;
      const instance = newInstance(template);
      fill(instance);
      return { template, instance };
    };
    const editor = newProject();
    const settings = { ...DEFAULT_COMP_SETTINGS, width: 1920, height: 1080, frameRate: 30, duration: 4 };
    const inner = newComposition(editor, { ...settings, name: "Inner" });
    const main = newComposition(editor, { ...settings, name: "Main" });
    newComposition(editor, { ...settings, name: "Unused" });
    editor.perform("build", [inner, main], () => {
      addLayer(editor, inner, { kind: "solid", name: "Fill me", color: [0.2, 0.4, 0.8], width: 400, height: 300 });
      const solid = addLayer(editor, main, { kind: "solid", name: "Back", color: [0.5, 0.5, 0.5], width: 1920, height: 1080 });
      addEffects(editor, main, solid, [
        fx("ADBE Tint", (s) => {
          setInstanceColor(s, "ADBE Tint", 1, [0.1, 0, 0.3]);
          setInstanceColor(s, "ADBE Tint", 2, [1, 0.9, 0.2]);
          setInstanceNumber(s, "ADBE Tint", 3, 80);
        }),
        fx("ADBE Ramp"),
        fx("ADBE Minimax"),
        fx("ADBE Slider Control"),
      ]);
      const glowing = addLayer(editor, main, { kind: "item", itemId: inner.id });
      addEffects(editor, main, glowing, [fx("ADBE Glo2", (s) => setInstanceNumber(s, "ADBE Glo2", 4, 2))]);
    });
    return { editor, main: editor.project.items.get(main.id) as CompItem };
  }

  it("are Avee shaders over the compositions they apply to, in stack order, with their settings as variables", async () => {
    const { editor, main } = await project();
    const { scene, report } = exported(editor.project, main, new FootageStore(1 << 20));
    const shaders = ofType(scene, "CustomShader");
    const effectOf = (s: VizElement) => text(s, "shaderFragment").split("\n", 1)[0].split(" | ")[0].replace("// aep-web effect: ", "");
    expect(shaders.map(effectOf).sort()).toEqual(["ADBE Glo2", "ADBE Ramp", "ADBE Tint"]);
    // The Ramp draws the Tint's result, which draws the solid.
    const [ramp, tint, glow] = ["ADBE Ramp", "ADBE Tint", "ADBE Glo2"].map((m) => shaders.find((s) => effectOf(s) === m)!);
    const inside = (e: VizElement) => {
      const s = imageSource(text(e, "TargetImage"));
      return s.kind === "composition" ? scene.compositions[s.index] : [];
    };
    expect(inside(ramp)).toEqual([tint]);
    expect(inside(tint).map((e) => text(e, "customImage"))).toEqual(["internalres:white"]);
    // The precomp's Glow draws the precomp's own composition, where the layer is.
    expect(inside(glow).map((e) => text(e, "tag"))).toEqual(["Fill me"]);
    expect(scene.compositions[0].at(-1)).toBe(glow);
    // Scalar settings are variables Avee shows; the shader declares a uniform for each, and Avee's interface.
    const variables = (e: VizElement) => {
      const group = e.varGroup as Record<string, { v?: string; name?: { v: string }; value?: { v: string } }>;
      return Object.values(group)
        .filter((v) => v && typeof v === "object" && v.v === "Value")
        .map((v) => [v.name!.v, v.value!.v]);
    };
    expect(variables(tint)).toEqual([["u_amount", "Constant 0.8 1.0"]]);
    for (const shader of shaders) {
      const fragment = text(shader, "shaderFragment");
      expect(fragment).toMatch(/uniform sampler2D u_texture;[\s\S]*varying vec2 vTexCoord;[\s\S]*gl_FragColor/);
      const uniforms = [...fragment.matchAll(/uniform float (\w+);/g)].map((m) => m[1]).sort();
      expect(uniforms).toEqual(variables(shader).map(([name]) => name).sort());
      expect(text(shader, "shaderVertex")).toMatch(/uniform mat4 u_projView;[\s\S]*attribute vec2 TexCoord;/);
    }
    expect(report.some((line) => /Minimax/.test(line) && /left out/.test(line))).toBe(true);
    expect(report.some((line) => /Slider/.test(line))).toBe(false);
  });

  it("include every comp of the project, and convert back to the effects themselves", async () => {
    const { editor, main } = await project();
    const store = new FootageStore(1 << 20);
    const { scene, files } = exported(editor.project, main, store);
    // Main, Inner, Unused, and the compositions the shaders draw.
    expect(scene.compositions.length).toBeGreaterThanOrEqual(3 + 2);
    expect(scene.compositions.some((c) => c.length === 0)).toBe(true);
    const { blob } = await writeZip(files);
    const again = await vizFromArchive(blob, "Main.viz");
    const { editor: converted } = await convertViz(again!);
    const effectsIn = [...converted.project.items.values()]
      .filter((i): i is CompItem => i.kind === "comp")
      .flatMap((c) => c.layers.flatMap((l) => effectsOf(l, "ADBE Tint").map((e) => ({ e, l }))));
    expect(effectsIn).toHaveLength(1);
    const { e: restored, l } = effectsIn[0];
    const value = (n: number) => valueAtTime(param(restored, n), 0, l);
    expect((value(1) as number[]).slice(0, 3).map((c) => Math.round(c * 1000) / 1000)).toEqual([0.1, 0, 0.3]);
    expect((value(2) as number[]).slice(0, 3).map((c) => Math.round(c * 1000) / 1000)).toEqual([1, 0.9, 0.2]);
    expect(value(3)).toBe(80);
  });
});

it("writes colours as Avee stores them", () => {
  expect(packArgb([1, 0, 0])).toBe(-65536);
  expect(packArgb([0, 0, 1], 1)).toBe(-16776961);
  const e = { objType: "Image", Color: { v: hslaText([0.2, 0.6, 0.4], 0.5), t: "chsla4f" } } as VizElement;
  expect(hsla(e, "Color").map((c) => Math.round(c * 1000) / 1000)).toEqual([0.2, 0.6, 0.4, 0.5]);
});
