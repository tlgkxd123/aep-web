// A synthetic Avee Player template for the tests, authored with the property shapes Avee Player writes
// (docs/viz-format.md): a background, a beat-bounced precomp of a mirrored ring and a masked logo, a fade-in, a shake
// shader and an element type the converter does not know; and a song of bass kicks.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FootageFile } from "../src/edit/project.ts";
import type { AudioData } from "../src/media/audio.ts";
import { parseScene, type VizTemplate } from "../src/viz/scene.ts";

export const RATE = 48000;
export const SECONDS = 4;

/** Kicks twice a second (55 Hz, decaying) over a quiet 440 Hz tone. */
export function kicks(seconds = SECONDS, rate = RATE): AudioData {
  const data = new Float32Array(seconds * rate);
  for (let i = 0; i < data.length; i++) {
    const t = i / rate;
    data[i] = 0.05 * Math.sin(2 * Math.PI * 440 * t) + 0.8 * Math.exp(-((t * 2) % 1) * 12) * Math.sin(2 * Math.PI * 55 * t);
  }
  return { sampleRate: rate, numberOfChannels: 1, length: data.length, getChannelData: () => data };
}

export const SONG: FootageFile = {
  path: "C:\\music\\song.wav",
  info: { kind: "audio", format: "WAVE", width: 0, height: 0, duration: SECONDS, frameRate: 0, hasAlpha: false, audio: { sampleRate: RATE, samples: RATE * SECONDS } },
};

// ---------------------------------------------------------------- authoring, as Avee Player writes properties

let order = 0;
const p = (v: unknown, t: string) => ({ v, t, o: order++, tag: "0_general" });
const measured = (what: string, a = 0, b = 0) => ({ v: "", t: "_child", o: order++, tag: "0_general", measureWhat: p(what, "_child Nothing Beat"), A: p(a, "f 0.0 1.0"), B: p(b, "f 0.0 1.0") });
const placed = (fields: { position?: string; scale?: string; tag?: string; blend?: string; visible?: number } = {}) => ({
  tag: p(fields.tag ?? "", "ptxt"),
  visible: p(fields.visible ?? 1, "b"),
  blendMode: p(fields.blend ?? "PreMulAlpha", "_child Alpha PreMulAlpha Screen Add AddAlpha"),
  position: p(fields.position ?? "0.500000 0.500000", "f2 -1.0 1.0"),
  alignmentPosition: p("0.500000 0.500000", "f2 0.0 1.0"),
  scaleIsUniform: p(0, "b"),
  scale: p(fields.scale ?? "1.000000 1.000000", "f2 0.0 2.0"),
  rotation: p(0, "f 0.0 300.0"),
  MeasurePos: measured("Nothing"),
  measureScale: measured("Nothing"),
  measureRot: measured("Nothing"),
});
const image = (source: string, fields: Parameters<typeof placed>[0] & { crop?: number; shape?: string; mask?: string; maskMode?: string } = {}, extra: object = {}) => ({
  objType: "Image",
  ...placed(fields),
  customImage: p(source, "img internalres:white composition:0"),
  keepAspectRatioAndCropToFit: p(fields.crop ?? 0, "b"),
  keepAspectRatio: p(1, "b"),
  Color: p("0.000000 0.000000 1.000000 1.000000", "chsla4f"),
  ColorTo: p("0.000000 0.000000 1.000000 1.000000", "chsla4f"),
  MeasureColorBlend: measured("Nothing"),
  Shape: p(fields.shape ?? "None", "_child None Circle SidedPolygon"),
  MaskImage: p(fields.mask ?? "", "img internalres:transparent composition:0"),
  maskMode: p(fields.maskMode ?? "Transparency", "sel Transparency TransparencyAndBlacks TransparencyAndWhites InvertedTransparency"),
  ...extra,
});

export const PNG = new Uint8Array(readFileSync(resolve("refs/media/straight.png")));
export const JPEG = new Uint8Array(readFileSync(resolve("refs/media/photo.jpg")));

/** A template like the Trap Nation ones: a background, a beat-bounced precomp of a mirrored ring and a masked logo. */
export function sceneJson(): string {
  order = 0;
  const compositions = [
    [
      {
        objType: "AudioProvider",
        sampleProvider: p("Spectrum2", "_child Waveform Spectrum Spectrum2"),
        audioDurationMs: p(150, "i 20 300"),
        sampleOutCount: p(199, "i 0 512"),
        lowerHz: p(45, "f 0.0 300.0"),
        higherHz: p(500, "f 300.0 18000.0"),
      },
      image("local:bg", { crop: 1, tag: "Background", blend: "Alpha" }),
      image("composition:1", { scale: "1.150000 1.150000" }, { measureScale: measured("Beat", 0.2, 0.2) }),
      image("internalres:black", { tag: "Fade in", blend: "Alpha" }, {
        ColorTo: p("0.000000 0.000000 1.000000 0.000000", "chsla4f"),
        MeasureColorBlend: { ...measured("TrackPosition"), A: p(10, "f 0.0 1.0") },
      }),
      { objType: "CustomShader", ...placed({ tag: "shake by someone" }), TargetImage: p("composition:2", "img composition:0") },
      { objType: "Text", ...placed() },
    ],
    [
      { objType: "MirrorEffect", ...placed({ scale: "0.900000 0.900000" }), TargetImage: p("composition:2", "img composition:0"), mirrorMode: p("Horizontal", "sel Horizontal Vertical HorizontalAndVertical"), flipMirror: p(0, "b") },
      image("local:logo", { tag: "Logo", scale: "0.410000 0.410000", shape: "Circle", mask: "composition:3", maskMode: "InvertedTransparency" }),
    ],
    [
      {
        objType: "Bars",
        ...placed({ scale: "0.455000 0.455000" }),
        heightScale: p(2.75, "f -10.0 10.0"),
        ShapePath: { v: "Circle", t: "_child HorizontalLine Circle SidedPolygon Letter", o: order++, tag: "1_bars", radius: p(1, "f 0.5 3.0"), gap: p(0, "f 0.0 0.9") },
        audioProviderIndex: p(1, "i 1 4"),
        flipInput: p(0, "b"),
        Segment1: { v: "Line", t: "_child None Bars Line SharpBars RoundBars", o: order++, tag: "1_bars", colorFrom: p(-65536, "crgba"), colorTo: p(-16776961, "crgba"), barHeightMultiplier: p(0.1, "f -2.0 2.0") },
        Segment2: { v: "None", t: "_child None Bars Line SharpBars RoundBars", o: order++, tag: "1_bars" },
      },
    ],
    [image("internalres:white", { tag: "Mask" })],
    [image("local:unused")],
  ];
  return JSON.stringify({ compositions: compositions.map((elements) => ({ objType: "Composition", elements })), ver: "10", template: 1, objType: "Root" });
}

export const template = (): VizTemplate => ({
  name: "Ring Test",
  scene: parseScene(sceneJson()),
  assets: new Map([
    ["bg", new Blob([PNG])],
    ["logo", new Blob([JPEG])],
  ]),
});
