// Builds a Quick Start template's project around the user's song: a 1920×1080 comp as
// long as the song holding, top to bottom,
//   Controls  a null whose "Bass" slider is keyed from the song (bass.ts), with the
//             "Bounce" and "Shake" amounts the expressions read;
//   Shake     a null that wiggles with the bass, parent of Bounce and the background;
//   Bounce    a null that scales up with the bass, parent of the logo and the ring;
//   Logo      the logo image (else the background image, else a gradient) in a circle;
//   Spectrum  Audio Spectrums of the song stacked on one solid, back to front, made a
//             ring by a half-circle mask (2018) or by Polar Coordinates (2020), mirrored;
//   Particles Trapcode Particular, sped up with the bass (optional);
//   Background the background image or a gradient, blurred and darkened;
//   the song.
// The effects come from the effect library and the masks from masks.ts, so After Effects
// opens the project as it opens the editor's other projects; only Particular is a
// third-party plug-in. The project opens as a new, unsaved one, without undo history.
import type { CompItem, Layer, Property, PropertyGroup } from "../aep/model.ts";
import type { Chunk } from "../aep/riff.ts";
import type { Editor } from "../edit/editor.ts";
import { effectLibrary } from "../edit/effectLibrary.ts";
import { addEffects, newInstance, setInstanceColor, setInstanceName, setInstanceNumber, setInstancePoint, type EffectTemplate } from "../edit/effects.ts";
import { addLayer } from "../edit/layers.ts";
import { addMasks, arcShape, ellipseShape, MaskMode } from "../edit/masks.ts";
import { DEFAULT_COMP_SETTINGS, importFootage, newComposition, newProject, validateCompSettings, type FootageFile } from "../edit/project.ts";
import { editable, setParentKeepingTransform, writeTransform } from "../edit/transform-ops.ts";
import type { AudioData } from "../media/audio.ts";
import { bassLevels, levelKeyframes } from "./bass.ts";
import { quickStartTemplate, type QuickStartId } from "./catalog.ts";

const rgb = (hex: number): [number, number, number] => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

interface Style {
  frameRate: number;
  /** How the spectrum becomes a ring: along a half-circle mask, or drawn straight and bent by Polar Coordinates. */
  ring: "mask" | "polar";
  frequencies: [number, number];
  bands: number;
  maxHeight: number;
  /** Audio Offset, milliseconds. */
  offset: number;
  thickness: number;
  softness: number;
  /**
   * The Audio Duration (ms) of each spectrum, back to front (the palette gives their colours):
   * the shorter windows peak higher and show around the ones in front.
   */
  durations: number[];
  glow?: { threshold: number; radius: number; intensity: number };
  background: { blur: number; brightness: number };
  /** The Controls sliders: Scale added at full bass (%), and the shake's reach at full bass (px). */
  bounce: number;
  shake: number;
  particles: { rate: number; wind: number };
}

// The Audio Spectrum settings are those of the user's own Trap Nation projects (the
// fxmisc_as_user_* fixtures): 2000 bands of bass, Side B, Thickness 4, Softness 50 %.
const STYLES: Record<QuickStartId, Style> = {
  "trap-nation-2018": {
    frameRate: 30,
    ring: "mask",
    frequencies: [20, 250],
    bands: 2000,
    maxHeight: 600,
    offset: 0,
    thickness: 4,
    softness: 0.5,
    durations: [90, 130, 170],
    background: { blur: 4, brightness: -25 },
    bounce: 10,
    shake: 24,
    particles: { rate: 90, wind: 140 },
  },
  "trap-nation-2020": {
    frameRate: 60,
    ring: "polar",
    frequencies: [25, 125],
    bands: 2000,
    maxHeight: 600,
    offset: 88,
    thickness: 4,
    softness: 0.5,
    durations: [95, 125, 160, 195],
    glow: { threshold: 128, radius: 30, intensity: 1 },
    background: { blur: 14, brightness: -40 },
    bounce: 7,
    shake: 14,
    particles: { rate: 120, wind: 200 },
  },
};

const WIDTH = 1920;
const HEIGHT = 1080;
/** The ring's radius: where the bars start and the logo ends. */
export const RING_RADIUS = 270;
/** How much larger than the frame the background is, so the shake never shows its edges. */
const OVERSCAN = 1.1;

export const AUDIO_SPECTRUM = "ADBE AudSpect";
export const SLIDER = "ADBE Slider Control";
const RAMP = "ADBE Ramp";
export const MIRROR = "ADBE Mirror";
const POLAR = "ADBE Polar Coordinates";
const GLOW = "ADBE Glo2";
export const BLUR = "ADBE Gaussian Blur 2";
const BRIGHTNESS = "ADBE Brightness & Contrast 2";
export const PARTICULAR = "tc Particular";

/** Audio Spectrum's parameters, by number. */
export const AS = {
  audioLayer: 1,
  start: 2,
  end: 3,
  path: 4,
  startFrequency: 6,
  endFrequency: 7,
  bands: 8,
  maxHeight: 9,
  duration: 10,
  offset: 11,
  thickness: 12,
  softness: 13,
  insideColor: 14,
  outsideColor: 15,
  display: 20,
  side: 21,
  compositeOnOriginal: 23,
} as const;
export const DIGITAL = 1;
export const SIDE_A = 1;
export const SIDE_B = 2;
const RADIAL_RAMP = 2;
const RECT_TO_POLAR = 1;
export const PHYSICS_TIME_FACTOR = 25;

// The user's "Particles" layer (bass-supreme.aep, the fxextra_particular_white fixture):
// a wide box of glowing dots drifting sideways on the wind.
export const PARTICLE_NUMBERS: [number, number][] = [
  [5, 2], // Emitter Type: Box
  [113, 1], // Direction: Uniform
  [10, 20], // Direction Spread
  [111, 55], // Y Rotation
  [11, 15], // Velocity
  [12, 50], // Velocity Random
  [577, 2], // Emitter Size: XYZ Individual
  [14, 3400],
  [15, 960],
  [16, 1280],
  [2, 10], // Life [sec]
  [26, 2], // Particle Type: Glow Sphere
  [29, 44], // Particle Feather
  [27, 3.5], // Size
  [74, 100], // Size Random
  [33, 100], // Opacity
  [75, 100], // Opacity Random
  [227, 100], // Pre Run: the frame is full of particles from the first frame
];
export const PARTICLE_POSITION = [0.5, 0.5, -653];

// Effect parameters go by index: After Effects localises their names ("Slider" is "Deslizador" in Spanish).
const BASS = 'thisComp.layer("Controls").effect("Bass")(1) / 100';
const SHAKE_EXPRESSION = `var bass = ${BASS};\nwiggle(12, thisComp.layer("Controls").effect("Shake")(1) * bass * bass)`;
const BOUNCE_EXPRESSION = `var bass = ${BASS};\nvar s = 100 + thisComp.layer("Controls").effect("Bounce")(1) * bass;\n[s, s]`;
const PARTICLES_EXPRESSION = `var bass = ${BASS};\n0.5 + 2.5 * bass`;

export interface QuickStartMedia {
  /** An audio file, or a movie with sound. */
  song: FootageFile;
  background?: FootageFile;
  logo?: FootageFile;
}

export interface QuickStartOptions {
  /** The song's decoded sound, which the Bass keyframes follow; without it Bass stays at 0. */
  audio?: AudioData;
  /** Trapcode Particular particles; on unless false. */
  particles?: boolean;
}

export interface QuickStartProject {
  editor: Editor;
  comp: CompItem;
}

const isVisual = (file: FootageFile) => file.info.kind !== "audio" && file.info.width > 0 && file.info.height > 0;
const fileName = (file: FootageFile) => file.path.replace(/^.*[\\/]/, "");

/** The effects of `matchName` on a layer, in stack order. */
export function effectsOf(layer: Layer, matchName: string): PropertyGroup[] {
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
  return (parade?.children ?? []).filter((n): n is PropertyGroup => n.kind === "group" && n.matchName === matchName);
}

export function param(effect: PropertyGroup, n: number): Property {
  const name = `${effect.matchName}-${String(n).padStart(4, "0")}`;
  const prop = effect.children.find((c): c is Property => c.kind === "property" && c.matchName === name);
  if (!prop) throw new Error(`${effect.name} has no parameter ${n}`);
  return prop;
}

/** The frame rate a template's comp runs at, which the Bass keyframes are computed for. */
export const quickStartFrameRate = (id: QuickStartId): number => STYLES[id].frameRate;

/** Throws, saying why, unless the song has sound and the background and logo are pictures. */
export function checkQuickStartMedia(media: QuickStartMedia): void {
  const { song } = media;
  if (song.info.kind !== "audio" && !(song.info.kind === "video" && song.info.audioTrackRate)) throw new Error(`"${fileName(song)}" has no sound`);
  if (!(song.info.duration > 0)) throw new Error(`"${fileName(song)}" has no length`);
  for (const image of [media.background, media.logo]) {
    if (image && !isVisual(image)) throw new Error(`"${fileName(image)}" is not an image or a movie`);
  }
}

/** Builds the template `id` around `media`. */
export async function buildQuickStart(id: QuickStartId, media: QuickStartMedia, options: QuickStartOptions = {}): Promise<QuickStartProject> {
  const template = quickStartTemplate(id);
  if (!template) throw new Error(`there is no Quick Start template "${id}"`);
  const style = STYLES[id];
  const { palette } = template;
  if (palette.spectra.length !== style.durations.length) throw new Error(`${template.name} has ${palette.spectra.length} spectrum colours for ${style.durations.length} spectra`);
  const { song } = media;
  checkQuickStartMedia(media);
  const frames = Math.max(1, Math.ceil(song.info.duration * style.frameRate - 1e-6));
  const settings = { ...DEFAULT_COMP_SETTINGS, name: template.name, width: WIDTH, height: HEIGHT, frameRate: style.frameRate, duration: frames / style.frameRate };
  validateCompSettings(settings);

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
  const ramp = ([inner, outer]: [number, number], end: number[]) =>
    instance(RAMP, (sspc) => {
      setInstancePoint(sspc, RAMP, 1, [0.5, 0.5]);
      setInstanceColor(sspc, RAMP, 2, rgb(inner));
      setInstancePoint(sspc, RAMP, 3, end);
      setInstanceColor(sspc, RAMP, 4, rgb(outer));
      setInstanceNumber(sspc, RAMP, 5, RADIAL_RAMP);
    });
  const slider = (name: string, value: number) =>
    instance(SLIDER, (sspc) => {
      setInstanceName(sspc, name);
      setInstanceNumber(sspc, SLIDER, 1, value);
    });

  const editor = newProject();
  const comp = newComposition(editor, settings);
  const files = [song, media.background, media.logo].filter((f): f is FootageFile => !!f);
  const items = importFootage(editor, files);
  const itemOf = (file: FootageFile | undefined) => (file ? items[files.indexOf(file)] : undefined);
  const layerOf = (layerId: number): Layer => {
    const layer = comp.layers.find((l) => l.id === layerId);
    if (!layer) throw new Error(`layer ${layerId} is missing from "${comp.name}"`);
    return layer;
  };
  const solid = (name: string, width: number, height: number) => addLayer(editor, comp, { kind: "solid", name, color: [0, 0, 0], width, height, pixelAspect: 1 });
  const nullLayer = (name: string) => {
    const layerId = addLayer(editor, comp, { kind: "null" });
    editor.renameLayer(comp, layerOf(layerId), name);
    return layerId;
  };
  const expression = (layerId: number, prop: Property | undefined, text: string) => {
    if (!prop) throw new Error(`"${layerOf(layerId).name}" has no property for its expression`);
    editor.setExpression(comp, layerOf(layerId), prop, text);
  };
  const transformExpression = (layerId: number, matchName: string, text: string) => expression(layerId, editable(editor, comp, layerId, matchName)?.prop, text);

  editor.perform(`New Project from Template (${template.name})`, [comp], () => {
    const songId = addLayer(editor, comp, { kind: "item", itemId: itemOf(song)!.id });
    if (song.info.kind === "video") editor.setLayerSwitch(comp, layerOf(songId), "enabled", false);

    // Background: the image covering the frame with room to shake, or a gradient.
    let backgroundId: number;
    const background = itemOf(media.background);
    if (media.background && background) {
      backgroundId = addLayer(editor, comp, { kind: "item", itemId: background.id });
      const s = 100 * OVERSCAN * Math.max(WIDTH / media.background.info.width, HEIGHT / media.background.info.height);
      writeTransform(editor, comp, backgroundId, { scale: [s, s] }, 0);
    } else {
      backgroundId = solid("Background", Math.round(WIDTH * OVERSCAN), Math.round(HEIGHT * OVERSCAN));
      addEffects(editor, comp, backgroundId, [ramp(palette.background, [1, 1])]);
    }
    addEffects(editor, comp, backgroundId, [
      instance(BLUR, (sspc) => {
        setInstanceNumber(sspc, BLUR, 1, style.background.blur);
        setInstanceNumber(sspc, BLUR, 3, 1);
      }),
      instance(BRIGHTNESS, (sspc) => setInstanceNumber(sspc, BRIGHTNESS, 1, style.background.brightness)),
    ]);

    let particlesId: number | undefined;
    if (options.particles !== false) {
      particlesId = solid("Particles", WIDTH, HEIGHT);
      addEffects(editor, comp, particlesId, [
        instance(PARTICULAR, (sspc) => {
          setInstanceNumber(sspc, PARTICULAR, 146, style.particles.rate);
          for (const [n, value] of PARTICLE_NUMBERS) setInstanceNumber(sspc, PARTICULAR, n, value);
          setInstanceNumber(sspc, PARTICULAR, 22, style.particles.wind);
          setInstancePoint(sspc, PARTICULAR, 581, PARTICLE_POSITION);
          setInstanceColor(sspc, PARTICULAR, 70, rgb(palette.particles));
        }),
      ]);
    }

    // The ring: the spectra stacked back to front, each later one drawn over the ones before.
    const spectrumId = solid("Spectrum", WIDTH, HEIGHT);
    if (style.ring === "mask") {
      addMasks(editor, comp, spectrumId, [{ shape: arcShape(WIDTH / 2, HEIGHT / 2, RING_RADIUS, -90, -270), mode: MaskMode.NONE, name: "Ring" }]);
    }
    const spectra = style.durations.map((duration, i) =>
      instance(AUDIO_SPECTRUM, (sspc) => {
        const set = (n: number, value: number) => setInstanceNumber(sspc, AUDIO_SPECTRUM, n, value);
        if (style.ring === "polar") {
          // Rect to Polar puts row y at radius y / 2 and column x at x / width of a turn
          // anticlockwise from the top: a line across the left half, at twice the ring's radius
          // from the top, becomes the ring's left half, its bars (Side B, downwards) pointing out.
          setInstancePoint(sspc, AUDIO_SPECTRUM, AS.start, [0, (2 * RING_RADIUS) / HEIGHT]);
          setInstancePoint(sspc, AUDIO_SPECTRUM, AS.end, [0.5, (2 * RING_RADIUS) / HEIGHT]);
        }
        set(AS.startFrequency, style.frequencies[0]);
        set(AS.endFrequency, style.frequencies[1]);
        set(AS.bands, style.bands);
        set(AS.maxHeight, style.maxHeight);
        set(AS.duration, duration);
        set(AS.offset, style.offset);
        set(AS.thickness, style.thickness);
        set(AS.softness, style.softness);
        setInstanceColor(sspc, AUDIO_SPECTRUM, AS.insideColor, rgb(palette.spectra[i]));
        setInstanceColor(sspc, AUDIO_SPECTRUM, AS.outsideColor, rgb(palette.spectra[i]));
        set(AS.display, DIGITAL);
        set(AS.side, SIDE_B);
        set(AS.compositeOnOriginal, i > 0 ? 1 : 0);
      }),
    );
    const ringEffects = [...spectra];
    if (style.ring === "polar") {
      ringEffects.push(
        instance(POLAR, (sspc) => {
          setInstanceNumber(sspc, POLAR, 1, 1);
          setInstanceNumber(sspc, POLAR, 2, RECT_TO_POLAR);
        }),
      );
    }
    ringEffects.push(
      instance(MIRROR, (sspc) => {
        setInstancePoint(sspc, MIRROR, 1, [0.5, 0.5]);
        setInstanceNumber(sspc, MIRROR, 2, 0);
      }),
    );
    if (style.glow) {
      const { threshold, radius, intensity } = style.glow;
      ringEffects.push(
        instance(GLOW, (sspc) => {
          setInstanceNumber(sspc, GLOW, 2, threshold);
          setInstanceNumber(sspc, GLOW, 3, radius);
          setInstanceNumber(sspc, GLOW, 4, intensity);
        }),
      );
    }
    addEffects(editor, comp, spectrumId, ringEffects);
    effectsOf(layerOf(spectrumId), AUDIO_SPECTRUM).forEach((_, i) => {
      const effect = () => effectsOf(layerOf(spectrumId), AUDIO_SPECTRUM)[i];
      editor.setLayerReference(comp, layerOf(spectrumId), param(effect(), AS.audioLayer), layerOf(songId));
      editor.setMaskReference(comp, layerOf(spectrumId), param(effect(), AS.path), style.ring === "mask" ? 1 : 0);
    });

    // The logo in a circle the ring goes around.
    const logoFile = media.logo ?? media.background;
    const logoItem = itemOf(logoFile);
    let logoId: number;
    if (logoFile && logoItem) {
      logoId = addLayer(editor, comp, { kind: "item", itemId: logoItem.id });
      const { width, height } = logoFile.info;
      const side = Math.min(width, height);
      const s = (100 * 2 * RING_RADIUS) / side;
      writeTransform(editor, comp, logoId, { scale: [s, s] }, 0);
      addMasks(editor, comp, logoId, [{ shape: ellipseShape(width / 2, height / 2, side / 2, side / 2), name: "Circle" }]);
    } else {
      logoId = solid("Logo", 2 * RING_RADIUS, 2 * RING_RADIUS);
      addEffects(editor, comp, logoId, [ramp(palette.logo, [0.5, 1])]);
      addMasks(editor, comp, logoId, [{ shape: ellipseShape(RING_RADIUS, RING_RADIUS, RING_RADIUS, RING_RADIUS), name: "Circle" }]);
    }

    const bounceId = nullLayer("Bounce");
    const shakeId = nullLayer("Shake");
    const controlsId = nullLayer("Controls");
    addEffects(editor, comp, controlsId, [slider("Bass", 0), slider("Bounce", style.bounce), slider("Shake", style.shake)]);

    setParentKeepingTransform(editor, comp, layerOf(bounceId), shakeId, 0);
    for (const child of [logoId, spectrumId]) setParentKeepingTransform(editor, comp, layerOf(child), bounceId, 0);
    setParentKeepingTransform(editor, comp, layerOf(backgroundId), shakeId, 0);

    transformExpression(shakeId, "ADBE Position", SHAKE_EXPRESSION);
    transformExpression(bounceId, "ADBE Scale", BOUNCE_EXPRESSION);
    if (particlesId !== undefined) {
      expression(particlesId, param(effectsOf(layerOf(particlesId), PARTICULAR)[0], PHYSICS_TIME_FACTOR), PARTICLES_EXPRESSION);
    }

    if (options.audio) {
      const keys = levelKeyframes(bassLevels(options.audio, style.frameRate, frames), style.frameRate);
      const bass = effectsOf(layerOf(controlsId), SLIDER).find((e) => e.name === "Bass");
      if (!bass) throw new Error("the Controls layer has no Bass slider");
      editor.replaceKeyframes(comp, layerOf(controlsId), [{ prop: param(bass, 1), keys }], 0, comp.duration, "Bass");
    }
  });
  editor.clearHistory();
  return { editor, comp };
}
