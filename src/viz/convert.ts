// Avee Player templates (scene.ts) as After Effects projects, built through the
// editor like the Quick Start templates (src/quickstart/build.ts). Each
// composition the template shows becomes a comp of the template's frame, each
// element one layer or two, bottom first:
//   Image          its asset, a precomp, or a black or white solid, fitted in its box;
//   Bars           Audio Spectrum of the song along the element's circle or line;
//   Mirror Effect  the precomp it draws, mirrored by Mirror;
//   Blur Effect    the precomp blurred by Gaussian Blur, over or under the sharp one;
//   Particles      Trapcode Particular, set up as the Quick Start's particles;
//   other effects  the precomp drawn as it is.
// What follows the beat reads the main comp's Controls layer, whose Beat slider is
// keyed from the song's bass (src/quickstart/bass.ts). What has no After Effects
// counterpart is approximated or left out, and the report says which.
import type { CompItem, Layer, Shape } from "../aep/model.ts";
import type { Chunk } from "../aep/riff.ts";
import { safeName } from "../edit/collect.ts";
import type { Editor } from "../edit/editor.ts";
import { effectLibrary } from "../edit/effectLibrary.ts";
import {
  addEffects,
  newInstance,
  setInstanceColor,
  setInstanceData,
  setInstanceName,
  setInstanceNumber,
  setInstancePoint,
  setInstanceReference,
  type EffectTemplate,
} from "../edit/effects.ts";
import { addLayer, compUses } from "../edit/layers.ts";
import { addMasks, arcShape, ellipseShape, MaskMode } from "../edit/masks.ts";
import { DEFAULT_COMP_SETTINGS, importFootage, newComposition, newFolder, newProject, validateCompSettings, type FootageFile } from "../edit/project.ts";
import { editable, setParentKeepingTransform, writeTransform } from "../edit/transform-ops.ts";
import type { AudioData } from "../media/audio.ts";
import { probeMedia } from "../media/probe.ts";
import { bassLevels, levelKeyframes } from "../quickstart/bass.ts";
import { PARTICULAR_PARAM } from "../extra/pmatch/particular.ts";
import { drawnCurve } from "../render/effects/particularCurves.ts";
import { AS, AUDIO_SPECTRUM, BLUR, DIGITAL, effectsOf, MIRROR, param, PARTICULAR, RING_RADIUS, SIDE_A, SIDE_B, SLIDER } from "../quickstart/build.ts";
import { shaderEffect } from "./shaders.ts";
import { spectrumGains } from "./spectrumGains.ts";
import { assetFile, bool, child, color, hsla, imageSource, measure, num, referencedCompositions, text, vector, type Measure, type VizElement, type VizTemplate } from "./scene.ts";

/** Avee Player renders at the size the user exports at; the converted comps take the Quick Start's. */
export const VIZ_WIDTH = 1920;
export const VIZ_HEIGHT = 1080;
export const VIZ_FRAME_RATE = 30;
/** How long the comps are without a song. */
const DEFAULT_SECONDS = 30;
/** The Quick Start ring's Max Height, at RING_RADIUS. */
export const RING_MAX_HEIGHT = 600;
/** A Bars element's height (heightScale × the segment's barHeightMultiplier) that peaks like the Quick Start's ring: the Trap Nation template's. */
export const RING_BAR_HEIGHT = 2.75 * 0.1;
/** Gaussian Blur pixels per unit of a Blur Effect's radius × multiplier (Avee's unit is unknown; set by eye). */
export const BLUR_PIXELS = 4;
/** Pixels a beat shake reaches at full beat, per unit of its amount. */
export const SHAKE_PIXELS = 40;
/** Particular's Velocity (px/s), particle Size (px) and Gravity per unit of Avee's speed, size and gravity (set by eye). */
export const PARTICLE_VELOCITY = 60;
export const PARTICLE_SIZE = 2;
export const PARTICLE_GRAVITY = 1;
/** Pieces a spectrum's path is cut into, each with its own Max Height, and the most Audio Spectrums on one Bars layer. */
const SPECTRUM_PIECES = 8;
const MAX_SPECTRA = 24;
/** How many times faster particles fly at full beat, at most. */
const MAX_BEAT_BOOST = 4;
const P = PARTICULAR_PARAM;
const PARTICULAR_GRAVITY = 17;
const PARTICULAR_WIND_X = 22;
const EMITTER_BOX = 2;
const SIZE_XYZ = 2;
const UNIFORM = 1;
const DIRECTIONAL = 2;
const GLOW_SPHERE = 2;

export const FILL = "ADBE Fill";
/** Track matte types for Avee's mask modes. */
export const MATTES: Record<string, number> = { Transparency: 5013, InvertedTransparency: 5014, TransparencyAndBlacks: 5015, TransparencyAndWhites: 5016 };
const NORMAL = 5212;
const ADD = 5220;
const SCREEN = 5222;
const BLEND_MODES: Record<string, number> = { Alpha: NORMAL, PreMulAlpha: NORMAL, Over: NORMAL, Screen: SCREEN, Add: ADD, AddAlpha: ADD };
const BEAT_MEASURES = new Set(["Beat", "BeatTriggerAnim", "BeatRandomShake", "BeatCamShakeMore", "BeatCamShakeLess", "BeatCamShakeRotMore", "BeatCamShakeRotLess"]);

export interface VizMedia {
  /** An audio file, or a movie with sound: what the spectra show and the beat follows. */
  song?: FootageFile;
  /** The song's decoded sound, which the Beat keyframes follow. */
  audio?: AudioData;
}

export interface VizProject {
  editor: Editor;
  comp: CompItem;
  /** What was approximated or left out, one line each. */
  report: string[];
  /** The template's images under the paths the project records, for the footage store. */
  footage: { path: string; blob: Blob }[];
}

/** Lines saying what the conversion approximated or left out, each said once with how often. */
export class Report {
  private readonly lines = new Map<string, number>();
  add(line: string): void {
    this.lines.set(line, (this.lines.get(line) ?? 0) + 1);
  }
  list(): string[] {
    return [...this.lines].map(([line, n]) => (n > 1 ? `${line} (${n}×)` : line));
  }
}

const fmt = (n: number) => String(Number(n.toFixed(4)));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** An element's tag on one line, else its kind. */
const label = (e: VizElement) => text(e, "tag").replace(/\s+/g, " ").trim() || (typeof e._name === "string" ? e._name : e.objType);

/** The compositions composition 0 shows, directly or through others, in that order. */
function usedCompositions(compositions: VizElement[][]): number[] {
  const used: number[] = [];
  const visit = (index: number) => {
    if (used.includes(index) || !compositions[index]) return;
    used.push(index);
    for (const e of compositions[index]) for (const target of referencedCompositions(e)) visit(target);
  };
  visit(0);
  return used;
}

/** The asset names the used compositions' images and particles show. */
function assetNames(compositions: VizElement[][], used: number[]): string[] {
  const names = new Set<string>();
  for (const index of used) {
    for (const e of compositions[index]) {
      const source = imageSource(text(e, "customImage"));
      if (source.kind === "asset" && (e.objType === "Image" || e.objType === "Particles")) names.add(source.name);
    }
  }
  return [...names];
}

/** Compositions a Mirror Effect reflects left to right: their circles only need their left half drawn. */
function horizontallyMirrored(compositions: VizElement[][], used: number[]): Set<number> {
  const out = new Set<number>();
  for (const index of used) {
    for (const e of compositions[index]) {
      if (e.objType !== "MirrorEffect" || !/Horizontal/.test(text(e, "mirrorMode", "Horizontal"))) continue;
      const source = imageSource(text(e, "TargetImage"));
      if (source.kind === "composition") out.add(source.index);
    }
  }
  return out;
}

/** The extension an asset's bytes call for (the template stores its images without one). */
async function assetExtension(blob: Blob, name: string): Promise<string | undefined> {
  const named = /\.(png|jpe?g|gif|bmp|tiff?|mp4|m4v|mov)$/i.exec(name)?.[1];
  if (named) return named.toLowerCase();
  const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "gif";
  if (b[0] === 0x42 && b[1] === 0x4d) return "bmp";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return "tif";
  if (String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp") return "mp4";
  return undefined;
}

type Fit = "contain" | "cover" | "stretch";

/** Converts `template` into a new project around `media`. */
export async function convertViz(template: VizTemplate, media: VizMedia = {}): Promise<VizProject> {
  const report = new Report();
  const { compositions } = template.scene;
  const used = usedCompositions(compositions);
  const providers = compositions.flat().filter((e) => e.objType === "AudioProvider");
  const mirrored = horizontallyMirrored(compositions, used);
  const folderName = safeName(template.name);

  const assets = new Map<string, FootageFile>();
  const footage: { path: string; blob: Blob }[] = [];
  for (const name of assetNames(compositions, used)) {
    const found = assetFile(template, name);
    const blob = found?.blob;
    const extension = found && (await assetExtension(found.blob, found.name));
    if (!blob || !extension) {
      report.add(blob ? `The template's image "${name}" is in a format this app cannot import; what shows it is left out.` : `The template's image "${name}" is missing from it; what shows it is left out.`);
      continue;
    }
    const path = `${folderName}/${safeName(name.replace(/\.[a-z0-9]+$/i, ""))}.${extension}`;
    try {
      assets.set(name, { path, info: await probeMedia(blob, path) });
      footage.push({ path, blob });
    } catch {
      report.add(`The template's image "${name}" cannot be read; what shows it is left out.`);
    }
  }

  const { song } = media;
  const seconds = song && song.info.duration > 0 ? song.info.duration : DEFAULT_SECONDS;
  const frames = Math.max(1, Math.ceil(seconds * VIZ_FRAME_RATE - 1e-6));
  const settings = (name: string) => ({
    ...DEFAULT_COMP_SETTINGS,
    name,
    width: VIZ_WIDTH,
    height: VIZ_HEIGHT,
    frameRate: VIZ_FRAME_RATE,
    duration: frames / VIZ_FRAME_RATE,
  });
  const mainName = template.name;
  validateCompSettings(settings(mainName));
  if (!song) report.add("Without a song, the spectrum bars stay flat and nothing follows the beat.");

  const library = new Map((await effectLibrary()).map((e) => [e.matchName, e.template]));
  const fx = (matchName: string): EffectTemplate => {
    const found = library.get(matchName);
    if (!found) throw new Error(`the effect library has no ${matchName}`);
    return found;
  };
  const instance = (matchName: string, fill: (sspc: Chunk) => void) => {
    const sspc = newInstance(fx(matchName));
    fill(sspc);
    return { template: fx(matchName), instance: sspc };
  };

  const gainCache = new Map<string, number[]>();
  const gainsFor = (audio: AudioData, lo: number, hi: number, durationMs: number, pieces: number) => {
    const key = `${lo}|${hi}|${durationMs}|${pieces}`;
    let gains = gainCache.get(key);
    if (!gains) gainCache.set(key, (gains = spectrumGains(audio, lo, hi, durationMs, pieces)));
    return gains;
  };

  const editor = newProject();
  const folder = used.length > 1 ? newFolder(editor, 0, `${mainName} Compositions`) : undefined;
  const comps = new Map<number, CompItem>();
  for (const index of used) {
    comps.set(index, newComposition(editor, settings(index === 0 ? mainName : `${mainName} ${index}`), index === 0 || !folder ? 0 : folder.id));
  }
  const files = [...(song ? [song] : []), ...assets.values()];
  const items = importFootage(editor, files);
  const itemOf = (file: FootageFile) => items[files.indexOf(file)];
  const main = comps.get(0)!;
  // Effect parameters go by index: After Effects localises their names ("Slider" is "Deslizador" in Spanish).
  const beat = `comp(${JSON.stringify(mainName)}).layer("Controls").effect("Beat")(1) / 100`;

  const layerOf = (comp: CompItem, layerId: number): Layer => {
    const layer = comp.layers.find((l) => l.id === layerId);
    if (!layer) throw new Error(`layer ${layerId} is missing from "${comp.name}"`);
    return layer;
  };
  const transformExpression = (comp: CompItem, layerId: number, matchName: string, expression: string) => {
    const target = editable(editor, comp, layerId, matchName);
    if (target) editor.setExpression(comp, target.layer, target.prop, expression);
  };
  const solid = (comp: CompItem, name: string, rgb: [number, number, number]) =>
    addLayer(editor, comp, { kind: "solid", name, color: rgb, width: VIZ_WIDTH, height: VIZ_HEIGHT, pixelAspect: 1 });

  const label_ = `Convert Avee Player Template (${mainName})`;
  (() => {
    const songLayers = new Map<number, number>();
    /** The song's layer in a comp, which its spectra read: heard in the main comp only. */
    const songLayer = (index: number): number | undefined => {
      if (!song) return undefined;
      let layerId = songLayers.get(index);
      if (layerId === undefined) {
        const comp = comps.get(index)!;
        layerId = addLayer(editor, comp, { kind: "item", itemId: itemOf(song).id });
        if (song.info.kind === "video") editor.setLayerSwitch(comp, layerOf(comp, layerId), "enabled", false);
        if (index !== 0) editor.setLayerSwitch(comp, layerOf(comp, layerId), "audioEnabled", false);
        songLayers.set(index, layerId);
      }
      return layerId;
    };
    let controlsId = 0;
    editor.perform(label_, [main], () => {
      songLayer(0);
      controlsId = addLayer(editor, main, { kind: "null" });
      editor.renameLayer(main, layerOf(main, controlsId), "Controls");
      addEffects(editor, main, controlsId, [
        instance(SLIDER, (sspc) => {
          setInstanceName(sspc, "Beat");
          setInstanceNumber(sspc, SLIDER, 1, 0);
        }),
      ]);
    });

    /** Puts content of `width` × `height` in the element's box: centred on its position, scaled to its size. */
    const place = (comp: CompItem, layerId: number, e: VizElement, width: number, height: number, fit: Fit) => {
      const [px, py] = vector(e, "position", [0.5, 0.5]);
      const [ax, ay] = vector(e, "alignmentPosition", [0.5, 0.5]);
      const [sx, sy] = scaleOf(e);
      let kx = (sx * VIZ_WIDTH) / width;
      let ky = (sy * VIZ_HEIGHT) / height;
      if (fit === "contain") kx = ky = Math.min(kx, ky);
      else if (fit === "cover") kx = ky = Math.max(kx, ky);
      writeTransform(
        editor,
        comp,
        layerId,
        { anchor: [ax * width, ay * height], position: [px * VIZ_WIDTH, py * VIZ_HEIGHT], scale: [100 * kx, 100 * ky], rotation: num(e, "rotation") },
        0,
      );
    };

    /**
     * A measure's 0–1 drive as an expression, for the measures this converter follows: the beat (times the
     * Beat measure's amount; the shakes' amounts are distances), or the share of the song played (times its amount).
     */
    const drive = (m: Measure): string | undefined => {
      if (m.what === "Beat") return `Math.min(1, Math.max(0, (${beat}) * ${fmt(Math.abs(m.a) || 1)}))`;
      if (BEAT_MEASURES.has(m.what)) return `Math.min(1, Math.max(0, ${beat}))`;
      if (m.what === "TrackPosition") return `Math.min(1, Math.max(0, time / thisComp.duration * ${fmt(m.a || 1)}))`;
      return undefined;
    };

    /** Blend mode, visibility, opacity and the animated properties every drawn element has. */
    const finish = (comp: CompItem, layerId: number, e: VizElement, blend = text(e, "blendMode", "Alpha")) => {
      if (text(e, "tag").trim()) editor.renameLayer(comp, layerOf(comp, layerId), label(e));
      const mode = BLEND_MODES[blend] ?? NORMAL;
      if (mode !== NORMAL) editor.setBlendingMode(comp, layerOf(comp, layerId), mode);
      if (!bool(e, "visible", true)) editor.setLayerSwitch(comp, layerOf(comp, layerId), "enabled", false);

      const scale = measure(e, "measureScale");
      if (scale?.what === "Beat") {
        const [a, b] = [clamp(scale.a, -1, 1), clamp(scale.b, -1, 1)];
        transformExpression(comp, layerId, "ADBE Scale", `var b = ${beat};\n[value[0] * (1 + ${fmt(a)} * b), value[1] * (1 + ${fmt(b)} * b)]`);
      } else if (scale) report.add(`Scale following "${scale.what}" is left out.`);

      const rotation = measure(e, "measureRot");
      if (rotation?.what === "TotalTime" || rotation?.what === "TotalTimeBackward") {
        const sign = rotation.what === "TotalTime" ? 1 : -1;
        transformExpression(comp, layerId, "ADBE Rotate Z", `value + ${fmt(sign * rotation.a * 360)} * time`);
        report.add("Rotation over time is approximated (one turn a second per unit of speed).");
      } else if (rotation?.what === "TotalTimeAndBeat") {
        transformExpression(comp, layerId, "ADBE Rotate Z", `value + ${fmt(rotation.a * 360)} * time + ${fmt(rotation.b * 90)} * (${beat})`);
        report.add("Rotation over time and with the beat is approximated.");
      } else if (rotation && /^ConstantShakeRot/.test(rotation.what)) {
        const reach = 30 * (Math.abs(rotation.a) || 1) * (/More$/.test(rotation.what) ? 1.5 : 0.5);
        transformExpression(comp, layerId, "ADBE Rotate Z", `wiggle(${fmt(Math.max(0.5, Math.abs(rotation.b) * 40))}, ${fmt(reach)})`);
        report.add("Rotation shakes are approximated by wiggles.");
      } else if (rotation) report.add(`Rotation following "${rotation.what}" is left out.`);

      const position = measure(e, "MeasurePos");
      if (position && /Shake/.test(position.what)) {
        const reach = SHAKE_PIXELS * (Math.abs(position.a) || 1) * (/More/.test(position.what) ? 1.5 : /Less/.test(position.what) ? 0.5 : 1);
        transformExpression(comp, layerId, "ADBE Position", /^Constant/.test(position.what) ? `wiggle(8, ${fmt(reach)})` : `wiggle(12, ${fmt(reach)} * (${beat}))`);
      } else if (position) report.add(`Position following "${position.what}" is left out.`);
    };

    /** Opacity from an element's colour alpha, blended to its second colour by its colour measure. */
    const opacity = (comp: CompItem, layerId: number, e: VizElement, tinted: boolean) => {
      const from = hsla(e, "Color");
      const to = hsla(e, "ColorTo");
      const blend = measure(e, "MeasureColorBlend");
      const factor = blend && drive(blend);
      if (blend && !factor) report.add(`Colour blending following "${blend.what}" is left out.`);
      if (factor && Math.abs(from[3] - to[3]) > 1e-3) {
        transformExpression(comp, layerId, "ADBE Opacity", `var f = ${factor};\n(${fmt(from[3])} + ${fmt(to[3] - from[3])} * f) * 100`);
      } else if (from[3] < 1) writeTransform(editor, comp, layerId, { opacity: 100 * from[3] }, 0);
      const white = (c: number[]) => c[0] > 0.999 && c[1] > 0.999 && c[2] > 0.999;
      if (tinted && (!white(from) || (factor && !white(to)))) report.add("Colour tints of images are left out.");
    };

    /** A layer of composition `target`, unless that would make a comp contain itself. */
    const precomp = (comp: CompItem, target: number, e: VizElement): number | undefined => {
      const source = comps.get(target);
      if (!source) {
        report.add(`${label(e)} draws a composition the template does not have; it is left out.`);
        return undefined;
      }
      if (compUses(editor.project, source, comp.id)) {
        report.add(`${label(e)} draws a composition that contains it; it is left out.`);
        return undefined;
      }
      return addLayer(editor, comp, { kind: "item", itemId: source.id });
    };

    /**
     * The element's mask image as a track matte: the masking image or composition in the element's box, directly
     * above the layer and parented to it, so it follows the layer's motion.
     */
    const addMask = (comp: CompItem, layerId: number, e: VizElement) => {
      const source = imageSource(text(e, "MaskImage"));
      const mode = text(e, "maskMode", "Transparency");
      if (source.kind === "none") return;
      if (source.kind === "builtin") {
        // Opaque white, or opaque black where only transparency hides, shows the whole element.
        if (source.name === "white" || (source.name === "black" && !/Blacks/.test(mode))) return;
        report.add(`Avee's built-in mask image "${source.name}" is not available; the element is drawn unmasked.`);
        return;
      }
      let matteId: number | undefined;
      let size: [number, number] = [VIZ_WIDTH, VIZ_HEIGHT];
      if (source.kind === "composition") matteId = precomp(comp, source.index, e);
      else {
        const file = assets.get(source.name);
        if (file) {
          matteId = addLayer(editor, comp, { kind: "item", itemId: itemOf(file).id });
          size = [file.info.width, file.info.height];
        }
      }
      if (matteId === undefined) return;
      place(comp, matteId, e, size[0], size[1], "stretch");
      editor.renameLayer(comp, layerOf(comp, matteId), `${label(e)} (mask)`);
      editor.setTrackMatte(comp, layerOf(comp, layerId), MATTES[mode] ?? MATTES.Transparency, matteId);
      setParentKeepingTransform(editor, comp, layerOf(comp, matteId), layerId, 0);
      if (mode === "TransparencyAndWhites") report.add("Masks hiding white areas are approximated by inverted luma mattes.");
    };

    const addImage = (comp: CompItem, index: number, e: VizElement) => {
      const source = imageSource(text(e, "customImage"));
      // A circle stays a circle: shaped images keep their proportions even when their aspect ratio is not kept.
      const circle = text(e, "Shape", "None") === "Circle";
      const fit: Fit = bool(e, "keepAspectRatioAndCropToFit") ? "cover" : bool(e, "keepAspectRatio", true) || circle ? "contain" : "stretch";
      let layerId: number | undefined;
      let size: [number, number] = [VIZ_WIDTH, VIZ_HEIGHT];
      if (source.kind === "composition") layerId = precomp(comp, source.index, e);
      else if (source.kind === "asset") {
        const file = assets.get(source.name);
        if (!file) return;
        layerId = addLayer(editor, comp, { kind: "item", itemId: itemOf(file).id });
        size = [file.info.width, file.info.height];
      } else if (source.kind === "builtin" && (source.name === "black" || source.name === "white")) {
        const tint = hsla(e, "Color");
        const rgb: [number, number, number] = source.name === "black" ? [0, 0, 0] : [tint[0], tint[1], tint[2]];
        // Blended normally over what a composition already drew, Avee's black and white images tint it without
        // covering what lies under the composition where it shows (they keep the alpha they are drawn over): an
        // adjustment layer filling with their colour, which is a solid with Preserve Underlying Transparency.
        const normal = (BLEND_MODES[text(e, "blendMode", "Alpha")] ?? NORMAL) === NORMAL;
        const over = normal && comp.layers.some((l) => l.id !== songLayers.get(index) && l.id !== controlsId);
        if (over) {
          layerId = addLayer(editor, comp, { kind: "adjustment" });
          editor.renameLayer(comp, layerOf(comp, layerId), label(e) || source.name);
          addEffects(editor, comp, layerId, [
            instance(FILL, (sspc) => {
              setInstanceColor(sspc, FILL, 2, rgb);
              setInstanceNumber(sspc, FILL, 5, 1);
            }),
          ]);
        } else layerId = solid(comp, label(e) || source.name, rgb);
        place(comp, layerId, e, VIZ_WIDTH, VIZ_HEIGHT, "stretch");
        finish(comp, layerId, e);
        opacity(comp, layerId, e, false);
        return;
      } else if (source.kind === "builtin") {
        report.add(`Avee's built-in image "${source.name}" is not available; what shows it is left out.`);
        return;
      }
      if (layerId === undefined) return;
      place(comp, layerId, e, size[0], size[1], fit);
      if (circle) {
        const side = Math.min(size[0], size[1]);
        addMasks(editor, comp, layerId, [{ shape: ellipseShape(size[0] / 2, size[1] / 2, side / 2, side / 2), name: "Circle" }]);
      } else if (text(e, "Shape", "None") !== "None") report.add(`Image shape "${text(e, "Shape")}" is left out.`);
      if (bool(e, "colorKeyEnabled")) report.add("Colour keying is left out.");
      if (text(e, "saturation", "Constant 1.0 1.0").split(/\s+/)[1] !== "1.0") report.add("Image saturation changes are left out.");
      if (bool(e, "blurEnabled")) {
        addEffects(editor, comp, layerId, [
          instance(BLUR, (sspc) => {
            setInstanceNumber(sspc, BLUR, 1, num(e, "blurRadius", 7) * 2);
            setInstanceNumber(sspc, BLUR, 3, 1);
          }),
        ]);
      }
      finish(comp, layerId, e);
      opacity(comp, layerId, e, true);
      addMask(comp, layerId, e);
    };

    const addBars = (comp: CompItem, index: number, e: VizElement) => {
      const segments = [child(e, "Segment1"), child(e, "Segment2")].filter((s) => s.objType && s.objType !== "None");
      if (!segments.length) return;
      if (segments.length > 1) report.add("Bars' second segments are left out.");
      const segment = segments[0];
      const provider = providers[num(e, "audioProviderIndex", 1) - 1] ?? providers[0];
      if (!provider) report.add("Bars without an audio provider take default spectrum settings.");
      const audioId = songLayer(index);

      const [px, py] = vector(e, "position", [0.5, 0.5]);
      const [ax, ay] = vector(e, "alignmentPosition", [0.5, 0.5]);
      const [sx, sy] = scaleOf(e);
      const boxW = sx * VIZ_WIDTH;
      const boxH = sy * VIZ_HEIGHT;
      const cx = px * VIZ_WIDTH + (0.5 - ax) * boxW;
      const cy = py * VIZ_HEIGHT + (0.5 - ay) * boxH;
      const shape = child(e, "ShapePath");
      const radius = num(shape, "radius", 1) * (Math.min(boxW, boxH) / 2);
      const flip = bool(e, "flipInput");
      const lower = clamp(provider ? num(provider, "lowerHz", 20) : 20, 1, 20000);
      const higher = clamp(provider ? num(provider, "higherHz", 500) : 500, lower + 1, 22050);
      const samples = provider ? num(provider, "sampleOutCount", 64) : 64;
      const linear = clamp(provider ? num(provider, "hzLinearFactor", 1) : 1, 0, 1);
      if (linear < 0.999) report.add("Bars spacing their frequencies logarithmically are spaced evenly (as Audio Spectrum spaces them).");
      /** The frequency halfway along the spectrum: Avee blends even and logarithmic spacing by hzLinearFactor. */
      const middle = linear * ((lower + higher) / 2) + (1 - linear) * Math.sqrt(lower * higher);

      // The paths the spectrum runs along, each with the frequencies it shows: Avee spreads the provider's samples
      // over the whole circle, from the top anticlockwise; a Mirror Effect then shows the left half twice, so the
      // ring shows the lower half of the frequencies. Mirrored samples run up both halves; repeated ones go round
      // again. Drawn anticlockwise, Side B points out of the circle.
      // Each part is drawn as pieces, each a slice of its frequencies with its own Max Height (spectrumGains.ts).
      type Segment = { from: number; to: number; lo: number; hi: number; outward: number; turns: number; gain: number; share: number; line?: boolean };
      const arc = (from: number, to: number, lo: number, hi: number): Segment => ({ from, to, lo, hi, outward: (to < from) !== flip ? SIDE_B : SIDE_A, turns: Math.abs(to - from) / 360, gain: 1, share: 1 });
      let whole: Segment[];
      if (shape.objType === "HorizontalLine") {
        // From the left to the right edge of the box; drawn left to right, Side B points down, so bars rise on Side A.
        whole = [{ from: 0, to: 1, lo: lower, hi: higher, outward: flip ? SIDE_B : SIDE_A, turns: 1, gain: 1, share: 1, line: true }];
      } else {
        if (shape.objType !== "Circle") report.add(`Bars shaped "${shape.objType}" are drawn on a circle.`);
        const repeat = clamp(Math.round(provider ? num(provider, "repeatSamples", 1) : 1), 1, 6);
        // The element's rotation turns where the circle starts (degrees, clockwise); its gap leaves the end of the
        // turn empty. Where Avee starts a circle at rotation 0 is not known: the top is taken.
        const start = -90 + num(e, "rotation", 0);
        const turn = 360 * (1 - clamp(num(shape, "gap", 0), 0, 0.9));
        if (mirrored.has(index)) whole = [arc(start, start - 180, lower, middle)];
        else if (provider && bool(provider, "mirrorSamples")) whole = [arc(start, start - turn / 2, lower, higher), arc(start, start + turn / 2, lower, higher)];
        else whole = Array.from({ length: repeat }, (_, k) => arc(start - (k * turn) / repeat, start - ((k + 1) * turn) / repeat, lower, higher));
        report.add("Bars on a circle start at its top at rotation 0 (where Avee starts them is not known).");
      }
      const duration = clamp(provider ? num(provider, "audioDurationMs", 90) : 90, 1, 3000);
      const pieces = media.audio ? Math.max(1, Math.min(SPECTRUM_PIECES, Math.floor(MAX_SPECTRA / whole.length))) : 1;
      const parts = whole.flatMap((s) => {
        const gains = media.audio && pieces > 1 ? gainsFor(media.audio, s.lo, s.hi, duration, pieces) : [1];
        return gains.map((gain, k) => ({
          ...s,
          from: s.from + ((s.to - s.from) * k) / gains.length,
          to: s.from + ((s.to - s.from) * (k + 1)) / gains.length,
          lo: s.lo + ((s.hi - s.lo) * k) / gains.length,
          hi: s.lo + ((s.hi - s.lo) * (k + 1)) / gains.length,
          turns: s.turns / gains.length,
          gain,
          share: 1 / gains.length,
        }));
      });
      const pathOf = (s: Segment): Shape => {
        const [from, to] = flip ? [s.to, s.from] : [s.from, s.to];
        if (!s.line) return arcShape(cx, cy, radius, from, to);
        const x = (f: number) => cx - boxW / 2 + boxW * (flip ? 1 - f : f);
        return { closed: false, vertices: [[x(s.from), cy], [x(s.to), cy]], inTangents: [[0, 0], [0, 0]], outTangents: [[0, 0], [0, 0]] };
      };
      // The provider's output multiplier scales its samples, so the bars' heights.
      const height = num(e, "heightScale", 1) * num(segment, "barHeightMultiplier", 0.1) * (provider ? num(provider, "outputMultiplier", 1) : 1);
      const line = segment.objType === "Line";
      const [inside, outside] = [color(segment, "colorFrom"), color(segment, "colorTo")];

      const layerId = solid(comp, label(e) || "Bars", [0, 0, 0]);
      writeTransform(editor, comp, layerId, { anchor: [cx, cy], position: [cx, cy] }, 0);
      addMasks(editor, comp, layerId, parts.map((part, i) => ({ shape: pathOf(part), mode: MaskMode.NONE, name: parts.length > 1 ? `Path ${i + 1}` : "Path" })));
      addEffects(
        editor,
        comp,
        layerId,
        parts.map((part, i) =>
          instance(AUDIO_SPECTRUM, (sspc) => {
            const set = (n: number, value: number) => setInstanceNumber(sspc, AUDIO_SPECTRUM, n, value);
            // As many bars along the piece as Avee draws there: each repeat or mirrored half of the samples holds
            // them all, the half of the circle a Mirror Effect keeps holds half, and a piece its share.
            const bands = clamp(Math.round((line ? 2000 : mirrored.has(index) ? samples / 2 : samples) * part.share), 1, 4096);
            set(AS.startFrequency, part.lo);
            set(AS.endFrequency, part.hi);
            set(AS.bands, bands);
            set(AS.maxHeight, clamp((Math.abs(height) / RING_BAR_HEIGHT) * RING_MAX_HEIGHT * (radius / RING_RADIUS) * part.gain, 0, 4000));
            set(AS.duration, duration);
            set(AS.offset, 0);
            set(AS.thickness, line ? 4 : clamp(((2 * Math.PI * radius * part.turns) / bands) * 0.6, 1, 64));
            set(AS.softness, 0.5);
            setInstanceColor(sspc, AUDIO_SPECTRUM, AS.insideColor, inside.slice(0, 3));
            setInstanceColor(sspc, AUDIO_SPECTRUM, AS.outsideColor, outside.slice(0, 3));
            set(AS.display, DIGITAL);
            set(AS.side, height >= 0 ? part.outward : part.outward === SIDE_B ? SIDE_A : SIDE_B);
            set(AS.compositeOnOriginal, i > 0 ? 1 : 0);
            if (audioId !== undefined) setInstanceReference(sspc, AUDIO_SPECTRUM, AS.audioLayer, audioId);
            setInstanceReference(sspc, AUDIO_SPECTRUM, AS.path, i + 1);
          }),
        ),
      );
      finish(comp, layerId, e);
    };

    const addMirror = (comp: CompItem, e: VizElement) => {
      const source = imageSource(text(e, "TargetImage"));
      const layerId = source.kind === "composition" ? precomp(comp, source.index, e) : undefined;
      if (layerId === undefined) return;
      place(comp, layerId, e, VIZ_WIDTH, VIZ_HEIGHT, "contain");
      const mode = text(e, "mirrorMode", "Horizontal");
      const turn = bool(e, "flipMirror") ? 180 : 0;
      const angles = [...(/Horizontal/.test(mode) ? [turn] : []), ...(/Vertical/.test(mode) ? [90 + turn] : [])];
      addEffects(
        editor,
        comp,
        layerId,
        angles.map((angle) =>
          instance(MIRROR, (sspc) => {
            setInstancePoint(sspc, MIRROR, 1, [0.5, 0.5]);
            setInstanceNumber(sspc, MIRROR, 2, angle);
          }),
        ),
      );
      finish(comp, layerId, e);
    };

    const addBlur = (comp: CompItem, e: VizElement) => {
      const target = num(e, "sourceCompositionIndex", -1);
      const sharp = bool(e, "showUnblurredContent");
      const under = bool(e, "showUnblurredContentUnder");
      const addSharp = () => {
        const layerId = precomp(comp, target, e);
        if (layerId === undefined) return;
        place(comp, layerId, e, VIZ_WIDTH, VIZ_HEIGHT, "contain");
        finish(comp, layerId, e);
        addMask(comp, layerId, e);
      };
      if (sharp && under) addSharp();
      const layerId = precomp(comp, target, e);
      if (layerId === undefined) return;
      place(comp, layerId, e, VIZ_WIDTH, VIZ_HEIGHT, "contain");
      addEffects(editor, comp, layerId, [
        instance(BLUR, (sspc) => {
          setInstanceNumber(sspc, BLUR, 1, num(e, "blurRadius", 1) * num(e, "blurMultiplier", 1) * BLUR_PIXELS);
          setInstanceNumber(sspc, BLUR, 3, 1);
        }),
      ]);
      finish(comp, layerId, e, sharp ? text(e, "blendModeContent", "Alpha") : text(e, "blendMode", "Alpha"));
      addMask(comp, layerId, e);
      if (sharp && !under) addSharp();
    };

    /** An effect this converter draws without its effect: the composition it draws, as it is. */
    const addPassThrough = (comp: CompItem, e: VizElement, note: string) => {
      const [target] = referencedCompositions({ ...e, MaskImage: undefined });
      const layerId = target !== undefined ? precomp(comp, target, e) : undefined;
      if (layerId === undefined) return;
      place(comp, layerId, e, VIZ_WIDTH, VIZ_HEIGHT, "contain");
      finish(comp, layerId, e);
      if (bool(e, "visible", true)) report.add(note);
      return layerId;
    };

    const addShader = (comp: CompItem, e: VizElement) => {
      // A shader this app wrote for an After Effects effect (shaders.ts) is that effect again.
      const written = shaderEffect(text(e, "shaderFragment"));
      if (written && library.has(written.matchName)) {
        const [target] = referencedCompositions({ ...e, MaskImage: undefined });
        const layerId = target !== undefined ? precomp(comp, target, e) : undefined;
        if (layerId === undefined) return;
        place(comp, layerId, e, VIZ_WIDTH, VIZ_HEIGHT, "contain");
        addEffects(editor, comp, layerId, [
          instance(written.matchName, (sspc) => {
            for (const [n, { kind, value }] of Object.entries(written.settings)) {
              try {
                if (kind === "color" && Array.isArray(value)) setInstanceColor(sspc, written.matchName, Number(n), value);
                else if (kind === "point" && Array.isArray(value)) setInstancePoint(sspc, written.matchName, Number(n), value);
                else if (typeof value === "number") setInstanceNumber(sspc, written.matchName, Number(n), value);
              } catch {
                // A setting the library's definition does not hold keeps its default.
              }
            }
          }),
        ]);
        finish(comp, layerId, e);
        return;
      }
      const name = label(e);
      if (!/shake/i.test(name)) {
        addPassThrough(comp, e, `Custom shader "${name}" is left out (After Effects cannot run its GLSL); what it draws is shown as it is.`);
        return;
      }
      const layerId = addPassThrough(comp, e, `Custom shader "${name}" is approximated by a shake that follows the beat (After Effects cannot run its GLSL).`);
      if (layerId !== undefined) transformExpression(comp, layerId, "ADBE Position", `wiggle(12, ${fmt(SHAKE_PIXELS / 2)} * (${beat}))`);
    };

    /**
     * Particles as Trapcode Particular: Avee's spawn area is a Box emitter (its depth the perspective depth), its
     * spawn time and count limit the rate, its random vectors Uniform emission, its lifetime, speed, sizes and fade
     * Life, Velocity and the Size and Opacity over Life curves, its gravity Gravity and Wind; a speed that follows
     * the beat drives Physics Time Factor, and mirroring adds Mirror.
     */
    const addParticles = (comp: CompItem, e: VizElement) => {
      const [px, py] = vector(e, "position", [0.5, 0.5]);
      const [sx, sy] = scaleOf(e);
      const area = child(e, "SpawnArea");
      const lifetime = clamp(num(e, "lifetime", 3), 0.1, 30);
      const rate = Math.min(1 / Math.max(0.001, num(e, "spawnTime", 0.02)), clamp(num(e, "CountLimit", 1000), 1, 100_000) / lifetime);
      const speed = Math.abs(num(e, "Speed", 1));
      const sizes = [num(e, "startSize", 0), num(e, "fadeInSize", 4), num(e, "endSize", 4)].map((s) => Math.max(0, s));
      const peak = Math.max(...sizes, 1e-6);
      const spread = num(e, "endSizeRandom", 0);
      const fade = clamp(num(e, "fadeInAndOutTime", 0.2), 0, 0.5);
      const [r, g, b] = hsla(e, "ColorFrom");
      const [gx, gy] = vector(e, "gravity", [0, 0]);
      const random = bool(area, "useRandomVectorInstead", true);
      const sizeCurve: [number, number][] = [[0, sizes[0] / peak], [Math.max(fade, 0.01), sizes[1] / peak], [1, sizes[2] / peak]];
      const opacityCurve: [number, number][] = fade > 0 ? [[0, 0], [fade, 1], ...(fade < 0.5 ? [[1 - fade, 1] as [number, number]] : []), [1, 0]] : [[0, 1], [1, 1]];
      const numbers: [number, number][] = [
        [P.emitterType, EMITTER_BOX],
        [P.emitterSize, SIZE_XYZ],
        [P.emitterSizeX, sx * VIZ_WIDTH],
        [P.emitterSizeY, area.objType === "HorizontalLine" ? 1 : sy * VIZ_HEIGHT],
        [P.emitterSizeZ, clamp(num(e, "perspectiveDepth", 0), 0, 5000)],
        [P.direction, random ? UNIFORM : DIRECTIONAL],
        [P.spread, random ? 100 : clamp(num(area, "vectorAngle", 0) / 3.6, 0, 100)],
        [P.velocity, speed * PARTICLE_VELOCITY],
        [P.velocityRandom, speed > 0 ? clamp((100 * Math.abs(num(e, "speedRandom", 0))) / speed, 0, 100) : 0],
        [P.life, lifetime],
        [P.lifeRandom, 0],
        [P.rate, rate],
        [P.particleType, GLOW_SPHERE],
        [P.size, peak * PARTICLE_SIZE],
        [P.sizeRandom, clamp((100 * spread) / (peak + spread), 0, 100)],
        [P.feather, 50],
        [P.opacity, 100],
        [P.opacityRandom, 0],
        [PARTICULAR_GRAVITY, gy * PARTICLE_GRAVITY],
        [PARTICULAR_WIND_X, gx * PARTICLE_GRAVITY],
        [P.preRun, 100],
      ];
      const layerId = solid(comp, label(e) || "Particles", [0, 0, 0]);
      const effects = [
        instance(PARTICULAR, (sspc) => {
          for (const [n, value] of numbers) setInstanceNumber(sspc, PARTICULAR, n, value);
          setInstancePoint(sspc, PARTICULAR, P.position, [px, py, 0]);
          setInstanceColor(sspc, PARTICULAR, P.color, [r, g, b]);
          setInstanceData(sspc, PARTICULAR, P.sizeOverLife, (data) => drawnCurve(data, sizeCurve));
          setInstanceData(sspc, PARTICULAR, P.opacityOverLife, (data) => drawnCurve(data, opacityCurve));
        }),
      ];
      for (const [mirror, angle] of [["mirrorX", 0], ["mirrorY", 90]] as const) {
        if (!bool(e, mirror)) continue;
        effects.push(
          instance(MIRROR, (sspc) => {
            setInstancePoint(sspc, MIRROR, 1, [px, py]);
            setInstanceNumber(sspc, MIRROR, 2, angle);
          }),
        );
      }
      addEffects(editor, comp, layerId, effects);
      const overall = measure(e, "MeasureOverallSpeed");
      if (overall && BEAT_MEASURES.has(overall.what)) {
        const boost = clamp(Math.abs(overall.a) || 1, 0, MAX_BEAT_BOOST);
        editor.setExpression(comp, layerOf(comp, layerId), param(effectsOf(layerOf(comp, layerId), PARTICULAR)[0], P.timeFactor), `1 + ${fmt(boost)} * (${beat})`);
      }
      // Scaling the layer would not scale the particles' world; Avee's particle scale measure is left to them.
      finish(comp, layerId, { ...e, measureScale: undefined });
      report.add("Particles use Trapcode Particular (a plug-in After Effects needs installed); their speed and size units are approximated.");
      if (imageSource(text(e, "customImage")).kind !== "none") report.add("Particle sprites are drawn as glowing dots.");
      if (num(e, "trailLength", 0) > 0) report.add("Particle trails are left out.");
      if (num(e, "sideSineWaveMag", 0) > 0) report.add("Particles' sideways waves are left out.");
      if (text(e, "ForceField", "None") !== "None") report.add("Particle force fields are left out.");
    };

    // A command per comp: the editor refreshes the comps a command names after each of its steps.
    for (const index of used) {
      const comp = comps.get(index)!;
      editor.perform(label_, [comp], () => buildComposition(comp, index));
    }

    if (media.audio) {
      editor.perform(label_, [main], () => {
        const keys = levelKeyframes(bassLevels(media.audio!, VIZ_FRAME_RATE, frames), VIZ_FRAME_RATE);
        const slider = effectsOf(layerOf(main, controlsId), SLIDER).find((e) => e.name === "Beat");
        if (!slider) throw new Error("the Controls layer has no Beat slider");
        editor.replaceKeyframes(main, layerOf(main, controlsId), [{ prop: param(slider, 1), keys }], 0, main.duration, "Beat");
      });
    }

    function buildComposition(comp: CompItem, index: number) {
      for (const e of compositions[index]) {
        try {
          switch (e.objType) {
            case "AudioProvider":
              break;
            case "Image":
              addImage(comp, index, e);
              break;
            case "Bars":
              addBars(comp, index, e);
              break;
            case "MirrorEffect":
              addMirror(comp, e);
              break;
            case "BlurEffect":
              addBlur(comp, e);
              break;
            case "MotionBlurEffect":
              addPassThrough(comp, e, "Motion Blur Effect is drawn without its blur.");
              break;
            case "RgbSplitEffect":
              addPassThrough(comp, e, "RGB Split Effect is drawn without its split.");
              break;
            case "CustomShader":
            case "DummyElement":
              addShader(comp, e);
              break;
            case "Particles":
              addParticles(comp, e);
              break;
            case "FOV":
              addPassThrough(comp, e, "FOV elements are drawn without their curvature.");
              break;
            default:
              // An effect this converter does not know still shows the composition it draws.
              if (referencedCompositions(e).length) addPassThrough(comp, e, `"${e.objType}" elements are drawn without their effect.`);
              else report.add(`"${e.objType}" elements are not converted.`);
          }
        } catch (error) {
          report.add(`${label(e)} could not be converted: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  })();
  editor.clearHistory();
  return { editor, comp: main, report: report.list(), footage };
}

/** An element's scale; both axes the first when it is uniform. */
function scaleOf(e: VizElement): [number, number] {
  const [sx, sy] = vector(e, "scale", [1, 1]);
  return bool(e, "scaleIsUniform") ? [sx, sx] : [sx, sy];
}
