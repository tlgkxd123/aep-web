// Projects as Avee Player templates (.viz), the other way from convert.ts: a comp
// becomes composition 0 and the comps it shows the others, its layers elements, bottom
// first, placed as they rest at the comp's start (parenting baked in):
//   footage images  Image elements over the template's own copies of the files;
//   solids          white or black Images tinted their colour;
//   precomps        Images of their compositions;
//   Audio Spectrum  Bars over Audio Providers (the inverse of convert.ts's rings);
//   Particular      Particles;
//   Mirror, Gaussian Blur  Mirror and Blur Effects drawing the layer's own composition;
//   track mattes    mask images; a circle mask, an Image's Circle shape.
// The beat expressions convert.ts and the Quick Start templates write become Avee's
// measures. Every element carries each property Avee Player stores (data/schema.json).
// Keyframes, other effects and other expressions have no place in a template; the report
// lists them.
import { valueAtTime } from "../aep/evaluate.ts";
import type { CompItem, FootageItem, Layer, Project, Property, PropertyGroup, Shape } from "../aep/model.ts";
import { localMatrix, Mat4, type LocalTransform } from "../aep/transform.ts";
import { safeName, type SourceFile } from "../edit/collect.ts";
import { PARTICULAR_PARAM } from "../extra/pmatch/particular.ts";
import type { ZipInput } from "../media/zip.ts";
import { AS, AUDIO_SPECTRUM, BLUR, effectsOf, MIRROR, param, PARTICULAR, RING_RADIUS, SIDE_A, SIDE_B } from "../quickstart/build.ts";
import { matteLayerOf } from "../render/composition.ts";
import { BLUR_PIXELS, FILL, MATTES, PARTICLE_GRAVITY, PARTICLE_SIZE, PARTICLE_VELOCITY, Report, RING_BAR_HEIGHT, RING_MAX_HEIGHT, SHAKE_PIXELS } from "./convert.ts";
import schema from "./data/schema.json" with { type: "json" };
import { effectShader, SHADER_EFFECTS, SHADER_VERTEX, type EffectReader } from "./shaders.ts";

type Json = Record<string, unknown>;
interface Prop {
  v?: unknown;
  t?: string;
  [key: string]: unknown;
}

export interface VizExport {
  /** scene.json, then the template's images. */
  files: ZipInput[];
  /** What the template leaves out or approximates, one line each. */
  report: string[];
}

const NORMAL = 5212;
const ADD = 5220;
const SCREEN = 5222;
const POLAR = "ADBE Polar Coordinates";
const P = PARTICULAR_PARAM;
const UNIFORM = 1;
/** Effects the conversion of their layer takes in. */
const ABSORBED = new Set([AUDIO_SPECTRUM, PARTICULAR]);
/** Expression controls, which draw nothing. */
const CONTROLS = /^ADBE (Slider|Point|Point3D|Angle|Checkbox|Color|Layer|Dropdown) Control$/;
/** Blurs Avee's Blur Effect draws: their Gaussian Blur blurriness (pixels), from their parameters. */
type Read = (n: number) => unknown;
const num0 = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, v) : 0);
const BLURS: Record<string, (value: Read) => number> = {
  [BLUR]: (value) => num0(value(1)),
  "ADBE Gaussian Blur": (value) => num0(value(1)),
  "ADBE Fast Blur": (value) => num0(value(1)),
  // Iterations of a box of radius r: variance iterations · r(r + 1) / 3, as a Gaussian's blurriness (2.4 σ).
  "ADBE Box Blur2": (value) => {
    const r = num0(value(1));
    const iterations = Math.max(1, num0(value(2)) || 1);
    return 2.4 * Math.sqrt((iterations * r * (r + 1)) / 3);
  },
};

/** A shader's uniform floats as Avee's variable group, each a constant value. */
function shaderVariables(variables: [string, number][]): Json {
  const group: Json = { t: "_dyn", o: 17, tag: "variables" };
  variables.forEach(([name, value], i) => {
    const lo = Math.min(0, value);
    const hi = Math.max(1, value * 2);
    group[`var${i}`] = {
      v: "Value",
      t: "_child None Value Checkbox Texture",
      o: i,
      tag: "dyn",
      name: { v: name, t: "ptxt", o: 0, tag: "misc" },
      value: { v: `Constant ${Number(value.toFixed(6))} 1.0`, t: `mvarf ${lo.toFixed(1)} ${hi.toFixed(1)}`, o: 1, tag: "misc" },
    };
  });
  group.newVariable = { v: "None", t: "_child None Value Checkbox Texture", o: variables.length, tag: "dyn" };
  return group;
}
const MASK_MODES: Record<number, string> = Object.fromEntries(Object.entries(MATTES).map(([mode, type]) => [type, mode]));

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, digits = 6) => Number(v.toFixed(digits));
const f2 = (x: number, y: number) => `${x.toFixed(6)} ${y.toFixed(6)}`;

/** An RGB colour (0–1) as Avee's packed, signed ARGB integer. */
export function packArgb([r, g, b]: readonly number[], a = 1): number {
  const c = (x: number) => Math.round(clamp(x, 0, 1) * 255);
  return ((c(a) << 24) | (c(r) << 16) | (c(g) << 8) | c(b)) | 0;
}

/** An RGB colour (0–1) and alpha as Avee's "h s l a" string. */
export function hslaText([r, g, b]: readonly number[], a = 1): string {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max > min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l, a].map((x) => clamp(x, 0, 1).toFixed(6)).join(" ");
}

const elementOf = (type: string): Json => {
  const proto = (schema as Record<string, Json>)[type];
  if (!proto) throw new Error(`no ${type} element in the template schema`);
  const element = clone(proto);
  // A measure the schema's template happened to use is not this element's: nothing animates until set.
  for (const [key, value] of Object.entries(element)) {
    const what = (value as Prop | undefined)?.measureWhat as Prop | undefined;
    if (what && key !== "measureAnimationSpeed") what.v = "Nothing";
  }
  return element;
};

function set(e: Json, key: string, v: unknown): void {
  const prop = e[key] as Prop | undefined;
  if (prop && typeof prop === "object") prop.v = v;
  else e[key] = { v, t: typeof v === "number" ? "f" : "ptxt", o: Object.keys(e).length, tag: "misc" };
}

function setSub(e: Json, key: string, sub: string, v: unknown): void {
  const prop = e[key] as Prop | undefined;
  if (!prop) return;
  const child = prop[sub] as Prop | undefined;
  if (child && typeof child === "object") child.v = v;
  else prop[sub] = { v, t: typeof v === "number" ? "f -1.0 1.0" : "b", o: Object.keys(prop).length, tag: "misc" };
}

function setMeasure(e: Json, key: string, what: string, a = 0, b = 0): void {
  const prop = e[key] as Prop | undefined;
  if (!prop) return;
  const measured = prop.measureWhat as Prop | undefined;
  if (measured) measured.v = what;
  setSub(e, key, "A", round(a));
  setSub(e, key, "B", round(b));
}

const transformProp = (layer: Layer, matchName: string): Property | undefined =>
  (layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Transform Group")?.children ?? []).find(
    (n): n is Property => n.kind === "property" && n.matchName === matchName,
  );

/** A transform value as it rests at time 0, before expressions. */
function rest(layer: Layer, matchName: string, fallback: number[]): number[] {
  const prop = transformProp(layer, matchName);
  const value = prop ? valueAtTime(prop, 0, layer) : undefined;
  if (typeof value === "number") return [value];
  return Array.isArray(value) ? (value as number[]) : fallback;
}

/** Layer space to comp space at rest (pre-expression values at time 0), through the parent chain. */
function restMatrix(layer: Layer, comp: CompItem): Mat4 {
  let m = new Mat4();
  const chain: Layer[] = [];
  for (let l: Layer | undefined = layer; l && !chain.includes(l); l = l.parentId ? comp.layers.find((p) => p.id === l!.parentId) : undefined) chain.push(l);
  for (const l of chain.reverse()) {
    const v3 = (v: number[]) => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0] as [number, number, number];
    const t: LocalTransform = {
      position: v3(rest(l, "ADBE Position", [0, 0, 0])),
      anchor: v3(rest(l, "ADBE Anchor Point", [0, 0, 0])),
      scale: v3(rest(l, "ADBE Scale", [100, 100, 100])),
      orientation: [0, 0, 0],
      rotateX: 0,
      rotateY: 0,
      rotateZ: rest(l, "ADBE Rotate Z", [0])[0],
      opacity: 100,
    };
    m = m.mul(localMatrix(t));
  }
  return m;
}

/** The layer and its parents, nearest first. */
function lineage(layer: Layer, comp: CompItem): Layer[] {
  const out: Layer[] = [];
  for (let l: Layer | undefined = layer; l && !out.includes(l); l = l.parentId ? comp.layers.find((p) => p.id === l!.parentId) : undefined) out.push(l);
  return out;
}

const numberIn = (text: string, pattern: RegExp): number[] | undefined => {
  const m = pattern.exec(text);
  return m ? m.slice(1).map(Number) : undefined;
};

/** The value of a Controls slider an expression names (the Quick Start's Bounce and Shake amounts). */
function sliderValue(comp: CompItem, name: string): number | undefined {
  const controls = comp.layers.find((l) => l.name === "Controls");
  const effect = controls && effectsOf(controls, "ADBE Slider Control").find((e) => e.name === name);
  const value = effect ? valueAtTime(param(effect, 1), 0, controls!) : undefined;
  return typeof value === "number" ? value : undefined;
}

const BEAT = /effect\("(Beat|Bass)"\)/;

export function exportViz(project: Project, main: CompItem, filesOf: (item: FootageItem) => SourceFile[] | undefined): VizExport {
  const report = new Report();
  const compositions: Json[][] = [];
  const indexOf = new Map<number, number>();
  const pending: CompItem[] = [];
  const providers: Json[] = [];
  const files: ZipInput[] = [];
  const assetNames = new Map<number, string>();
  const takenNames = new Set<string>();
  let nextId = 1;

  /** Comps a Mirror on one of their layers reflects left to right (their rings show half the circle). */
  const mirroredComps = new Set<number>();
  for (const item of project.items.values()) {
    if (item.kind !== "comp") continue;
    for (const layer of item.layers) {
      const mirror = effectsOf(layer, MIRROR)[0];
      const source = project.items.get(layer.sourceId);
      if (mirror && source?.kind === "comp" && Math.abs(Math.sin((((valueAtTime(param(mirror, 2), 0, layer) as number) || 0) * Math.PI) / 180)) < 0.01) mirroredComps.add(source.id);
    }
  }

  const newComposition = () => compositions.push([]) - 1;
  const compositionOf = (comp: CompItem): number => {
    let index = indexOf.get(comp.id);
    if (index === undefined) {
      index = newComposition();
      indexOf.set(comp.id, index);
      pending.push(comp);
      if (Math.abs(comp.width / comp.height - main.width / main.height) > 0.01) report.add(`Comp "${comp.name}" is not the shape of "${main.name}"; Avee draws every composition the template's shape.`);
    }
    return index;
  };

  const asset = (item: FootageItem): string | undefined => {
    let name = assetNames.get(item.id);
    if (name) return name;
    const file = filesOf(item)?.[0];
    if (!file) {
      report.add(`The footage "${item.name}" is missing; what shows it is left out.`);
      return undefined;
    }
    const base = safeName(file.name);
    name = base;
    for (let n = 2; takenNames.has(name.toLowerCase()); n++) name = base.replace(/(\.[^.]+)?$/, ` ${n}$1`);
    takenNames.add(name.toLowerCase());
    assetNames.set(item.id, name);
    files.push({ path: name, data: file.blob, modified: (file.blob as Partial<File>).lastModified });
    return name;
  };

  const base = (type: string, layer: Layer | undefined): Json => {
    const e = elementOf(type);
    set(e, "_id", nextId++);
    if (layer) set(e, "tag", layer.name);
    return e;
  };

  /** Comp space to the frame elements are placed in: the comp, or the box of the element a mask image is for. */
  let frame: Mat4 | undefined;

  /** Places an element over content of `width` × `height` in layer pixels, as the layer rests in its comp. */
  const place = (e: Json, layer: Layer, comp: CompItem, width: number, height: number) => {
    const m = frame ? frame.mul(restMatrix(layer, comp)) : restMatrix(layer, comp);
    const c = m.transformPoint([width / 2, height / 2, 0]);
    const x = m.transformPoint([width / 2 + 1, height / 2, 0]);
    const y = m.transformPoint([width / 2, height / 2 + 1, 0]);
    const sx = Math.hypot(x[0] - c[0], x[1] - c[1]);
    const sy = Math.hypot(y[0] - c[0], y[1] - c[1]);
    set(e, "position", f2(c[0] / comp.width, c[1] / comp.height));
    set(e, "alignmentPosition", f2(0.5, 0.5));
    set(e, "scale", f2((width * sx) / comp.width, (height * sy) / comp.height));
    set(e, "scaleIsUniform", 0);
    set(e, "rotation", round((((Math.atan2(x[1] - c[1], x[0] - c[0]) * 180) / Math.PI) % 360 + 360) % 360, 4));
    if (e.keepAspectRatio) set(e, "keepAspectRatio", Math.abs(sx - sy) < 1e-3 * Math.max(sx, sy) ? 1 : 0);
    if (e.keepAspectRatioAndCropToFit) set(e, "keepAspectRatioAndCropToFit", 0);
  };

  /** Blend mode, visibility and the beat measures of the layer's (and its parents') expressions. */
  const finish = (e: Json, layer: Layer, comp: CompItem, premultiplied: boolean) => {
    const mode = layer.blendingMode;
    set(e, "blendMode", mode === ADD ? "Add" : mode === SCREEN ? "Screen" : premultiplied ? "PreMulAlpha" : "Alpha");
    if (mode !== NORMAL && mode !== ADD && mode !== SCREEN) report.add("Blending modes other than Normal, Add and Screen are drawn Normal.");
    set(e, "visible", layer.enabled ? 1 : 0);
    if (layer.threeDLayer) report.add("3D layers are placed flat.");
    for (const l of lineage(layer, comp)) {
      for (const node of l.properties) {
        if (node.kind !== "group" || node.matchName !== "ADBE Transform Group") continue;
        for (const prop of node.children) {
          if (prop.kind === "property" && prop.keyframes.length) report.add("Keyframed animation is left out; elements rest as at the comp's start.");
        }
      }
      const expression = (matchName: string) => {
        const prop = transformProp(l, matchName);
        return prop?.expressionEnabled ? prop.expression : "";
      };
      const scale = expression("ADBE Scale");
      const beatScale = numberIn(scale, /value\[0\] \* \(1 \+ (-?[\d.e-]+) \* b\), value\[1\] \* \(1 \+ (-?[\d.e-]+) \* b\)/);
      if (beatScale) setMeasure(e, "measureScale", "Beat", beatScale[0], beatScale[1]);
      else if (/effect\("Bounce"\)/.test(scale)) {
        const bounce = (sliderValue(comp, "Bounce") ?? 10) / 100;
        setMeasure(e, "measureScale", "Beat", bounce, bounce);
      } else if (scale) report.add("Expressions other than the beat ones this app writes are left out.");

      const position = expression("ADBE Position");
      const wiggle = numberIn(position, /wiggle\(([\d.]+),\s*([\d.]+)/);
      if (/effect\("Shake"\)/.test(position)) setMeasure(e, "MeasurePos", "BeatRandomShake", (sliderValue(comp, "Shake") ?? 24) / SHAKE_PIXELS, 0.5);
      else if (wiggle) setMeasure(e, "MeasurePos", BEAT.test(position) ? "BeatRandomShake" : "ConstantShake", wiggle[1] / SHAKE_PIXELS, 0.5);
      else if (position) report.add("Expressions other than the beat ones this app writes are left out.");

      const rotation = expression("ADBE Rotate Z");
      const spin = numberIn(rotation, /value \+ (-?[\d.e-]+) \* time(?: \+ (-?[\d.e-]+) \*)?/);
      const shake = numberIn(rotation, /wiggle\(([\d.]+),\s*([\d.]+)\)/);
      if (spin && spin[1] !== undefined && !Number.isNaN(spin[1])) setMeasure(e, "measureRot", "TotalTimeAndBeat", spin[0] / 360, spin[1] / 90);
      else if (spin) setMeasure(e, "measureRot", spin[0] >= 0 ? "TotalTime" : "TotalTimeBackward", Math.abs(spin[0]) / 360);
      else if (shake) setMeasure(e, "measureRot", "ConstantShakeRotMore", shake[1] / 45, shake[0] / 40);
      else if (rotation) report.add("Expressions other than the beat ones this app writes are left out.");
    }
  };

  /** The element's colour: white (or `rgb`) at the layer's opacity, blended by its opacity expression's measure. */
  const tint = (e: Json, layer: Layer, rgb: readonly number[] = [1, 1, 1]) => {
    const opacity = rest(layer, "ADBE Opacity", [100])[0] / 100;
    set(e, "Color", hslaText(rgb, opacity));
    set(e, "ColorTo", hslaText(rgb, opacity));
    const prop = transformProp(layer, "ADBE Opacity");
    const text = prop?.expressionEnabled ? prop.expression : "";
    if (!text) return;
    const blend = numberIn(text, /\((-?[\d.e-]+) \+ (-?[\d.e-]+) \* f\) \* 100/);
    const track = numberIn(text, /time \/ thisComp\.duration \* ([\d.e-]+)/);
    const beat = numberIn(text, /\/ 100\) \* ([\d.e-]+)\)/);
    if (!blend) return void report.add("Expressions other than the beat ones this app writes are left out.");
    set(e, "Color", hslaText(rgb, blend[0]));
    set(e, "ColorTo", hslaText(rgb, blend[0] + blend[1]));
    if (track) setMeasure(e, "MeasureColorBlend", "TrackPosition", track[0], 0.5);
    else setMeasure(e, "MeasureColorBlend", "Beat", beat?.[0] ?? 1, 0.5);
  };

  /** A circle mask (as convert.ts and the Quick Start draw them) is an Image's Circle shape; other masks are left out. */
  const shapeOf = (e: Json, layer: Layer) => {
    const masks = (layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Mask Parade")?.children ?? []).filter(
      (n): n is PropertyGroup => n.kind === "group" && !!n.mask,
    );
    if (!masks.length) return;
    const shape = valueAtTime(masks[0].children.find((c) => c.matchName === "ADBE Mask Shape") as Property, 0, layer) as unknown as Shape | undefined;
    const box = shape && boundsOf(shape.vertices);
    const circle = masks.length === 1 && shape?.closed && shape.vertices.length === 4 && box && Math.abs(box.w - box.h) < 1e-3 * box.w;
    if (circle && e.Shape) set(e, "Shape", "Circle");
    else report.add("Masks other than a circle are left out.");
  };

  /**
   * The layer's track matte as the element's mask image, which Avee lays over the element's box: the matte layer
   * placed relative to that box, in a composition of its own (or the matte's composition itself, when it fills the box).
   */
  const matteOf = (e: Json, layer: Layer, comp: CompItem) => {
    if (!layer.trackMatteType || layer.trackMatteType === 5012) return;
    const matte = matteLayerOf(layer, comp);
    if (!matte || !e.MaskImage) return;
    const [px, py] = ((e.position as Prop).v as string).split(" ").map(Number);
    const [sx, sy] = ((e.scale as Prop).v as string).split(" ").map(Number);
    const box = Mat4.translation(px * comp.width, py * comp.height, 0)
      .mul(Mat4.rotateZ(Number((e.rotation as Prop).v) || 0))
      .mul(Mat4.scale(sx || 1, sy || 1, 1))
      .mul(Mat4.translation(-comp.width / 2, -comp.height / 2, 0));
    const outer = frame;
    frame = box.inverse();
    let elements: Json[];
    try {
      elements = elementsOf(matte, comp, { matte: true });
    } finally {
      frame = outer;
    }
    const only = elements.length === 1 ? elements[0] : undefined;
    const whole = only && /^composition:\d+$/.test(String((only.customImage as Prop | undefined)?.v)) && (only.position as Prop).v === f2(0.5, 0.5) && (only.scale as Prop).v === f2(1, 1) && !Number((only.rotation as Prop).v);
    if (whole) set(e, "MaskImage", (only.customImage as Prop).v);
    else {
      const index = newComposition();
      compositions[index].push(...elements);
      set(e, "MaskImage", `composition:${index}`);
    }
    set(e, "maskMode", MASK_MODES[layer.trackMatteType] ?? "Transparency");
  };

  /** The layer's content as an element: an Image of its footage, solid, precomp or fill. */
  const contentOf = (layer: Layer, comp: CompItem): Json | undefined => {
    const source = project.items.get(layer.sourceId);
    const e = base("Image", layer);
    if (layer.adjustmentLayer) {
      const fill = effectsOf(layer, FILL)[0];
      if (!fill) return void report.add("Adjustment layers are left out.");
      const rgb = (valueAtTime(param(fill, 2), 0, layer) as number[]).slice(0, 3);
      const white = rgb.some((c) => c > 0.5);
      set(e, "customImage", white ? "internalres:white" : "internalres:black");
      place(e, layer, comp, comp.width, comp.height);
      tint(e, layer, white ? rgb : [1, 1, 1]);
      finish(e, layer, comp, false);
      return e;
    }
    if (source?.kind === "comp") {
      set(e, "customImage", `composition:${compositionOf(source)}`);
      place(e, layer, comp, source.width, source.height);
      tint(e, layer);
      finish(e, layer, comp, true);
    } else if (source?.kind === "footage" && source.mainSource.sourceType === "SolidSource") {
      const rgb = source.mainSource.color;
      const black = rgb.every((c) => c < 1e-3);
      set(e, "customImage", black ? "internalres:black" : "internalres:white");
      set(e, "keepAspectRatio", 0);
      place(e, layer, comp, source.width, source.height);
      tint(e, layer, black ? [1, 1, 1] : rgb);
      finish(e, layer, comp, false);
    } else if (source?.kind === "footage" && source.mainSource.sourceType === "FileSource") {
      if (!source.hasVideo) return undefined;
      if (source.mainSource.sequence || (!source.mainSource.isStill && !/\.gif$/i.test(source.mainSource.fileName))) {
        return void report.add(`Movies and image sequences cannot go into an Avee template; "${source.name}" is left out.`);
      }
      const name = asset(source);
      if (!name) return undefined;
      set(e, "customImage", `local:${name}`);
      place(e, layer, comp, source.width, source.height);
      tint(e, layer);
      finish(e, layer, comp, false);
    } else return void report.add(`"${layer.name}" has nothing Avee can draw; it is left out.`);
    shapeOf(e, layer);
    matteOf(e, layer, comp);
    return e;
  };

  /** A layer's Audio Spectrums as Bars over Audio Providers (convert.ts's rings, the other way). */
  const barsOf = (layer: Layer, comp: CompItem, spectra: PropertyGroup[]): Json[] => {
    const m = restMatrix(layer, comp);
    const num = (effect: PropertyGroup, n: number) => valueAtTime(param(effect, n), 0, layer) as number;
    const polar = effectsOf(layer, POLAR).length > 0;
    const masks = (layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Mask Parade")?.children ?? []).filter(
      (n): n is PropertyGroup => n.kind === "group" && !!n.mask,
    );
    type Ring = { effect: PropertyGroup; lo: number; hi: number; cx: number; cy: number; radius: number; sweep: number; line?: [number[], number[]] };
    const rings: Ring[] = [];
    for (const effect of spectra) {
      const lo = num(effect, AS.startFrequency);
      const hi = num(effect, AS.endFrequency);
      const pathIndex = num(effect, AS.path);
      const mask = pathIndex > 0 ? masks[pathIndex - 1] : undefined;
      const shape = mask ? (valueAtTime(mask.children.find((c) => c.matchName === "ADBE Mask Shape") as Property, 0, layer) as unknown as Shape) : undefined;
      if (shape && shape.vertices.length >= 2) {
        const points = curvePoints(shape).map((v) => m.transformPoint([v[0], v[1], 0]));
        const circle = circleThrough(points[0], points[Math.floor(points.length / 2)], points.at(-1)!);
        if (circle) {
          let sweep = 0;
          for (let i = 1; i < points.length; i++) {
            const a = Math.atan2(points[i - 1][1] - circle.cy, points[i - 1][0] - circle.cx);
            const b = Math.atan2(points[i][1] - circle.cy, points[i][0] - circle.cx);
            sweep += ((((b - a) * 180) / Math.PI + 540) % 360) - 180;
          }
          rings.push({ effect, lo, hi, ...circle, sweep: shape.closed ? -360 : sweep });
          continue;
        }
        rings.push({ effect, lo, hi, cx: 0, cy: 0, radius: 0, sweep: 0, line: [points[0], points.at(-1)!] });
        continue;
      }
      if (polar) {
        // Rect to Polar puts row y at radius y / 2 around the layer's centre (the Quick Start's 2020 ring).
        const start = valueAtTime(param(effect, AS.start), 0, layer) as number[];
        const c = m.transformPoint([layer.width / 2, layer.height / 2, 0]);
        rings.push({ effect, lo, hi, cx: c[0], cy: c[1], radius: (start[1] ?? 0) / 2, sweep: -180 });
        continue;
      }
      const start = m.transformPoint([...(valueAtTime(param(effect, AS.start), 0, layer) as number[]).slice(0, 2), 0]);
      const end = m.transformPoint([...(valueAtTime(param(effect, AS.end), 0, layer) as number[]).slice(0, 2), 0]);
      rings.push({ effect, lo, hi, cx: 0, cy: 0, radius: 0, sweep: 0, line: [start, end] });
    }
    // Spectrums sharing a path's frequencies are stacked rings, each its own Bars; consecutive frequency ranges
    // are pieces of one (convert.ts cuts a ring into pieces of its frequencies).
    const groups: Ring[][] = [];
    for (const ring of rings) {
      const last = groups.at(-1)?.at(-1);
      const joined = last && Math.abs(last.hi - ring.lo) < Math.max(0.05, 1e-4 * ring.hi) && Math.abs(last.lo - ring.lo) > 1e-3;
      if (last && joined && !ring.line && !last.line && Math.hypot(last.cx - ring.cx, last.cy - ring.cy) < 1) groups.at(-1)!.push(ring);
      else groups.push([ring]);
    }
    const mirrored = mirroredComps.has(comp.id) || effectsOf(layer, MIRROR).length > 0;
    const out: Json[] = [];
    for (const group of groups) {
      const first = group[0];
      const effect = first.effect;
      const lo = first.lo;
      let hi = group.at(-1)!.hi;
      const sweep = group.reduce((s, r) => s + r.sweep, 0);
      const half = mirrored && Math.abs(Math.abs(sweep) - 180) < 20;
      // Mirrored, the ring shows the lower half of what Avee spreads over the whole circle.
      if (half) hi = lo + 2 * (hi - lo);
      const bands = group.reduce((n, r) => n + num(r.effect, AS.bands), 0) * (half ? 2 : 1);
      const maxHeight = Math.min(...group.map((r) => num(r.effect, AS.maxHeight)));
      const color = (n: number) => (valueAtTime(param(effect, n), 0, layer) as number[]).slice(0, 3);
      const provider = base("AudioProvider", undefined);
      set(provider, "sampleProvider", "Spectrum2");
      set(provider, "lowerHz", round(lo, 3));
      set(provider, "higherHz", round(hi, 3));
      set(provider, "hzLinearFactor", 1);
      set(provider, "audioDurationMs", Math.round(num(effect, AS.duration)));
      set(provider, "sampleOutCount", Math.round(clamp(bands >= 500 ? 199 : bands, 1, 512)));
      set(provider, "mirrorSamples", 0);
      set(provider, "repeatSamples", 1);
      providers.push(provider);

      const e = base("Bars", layer);
      const line = first.line;
      const radius = line ? Math.hypot(line[1][0] - line[0][0], line[1][1] - line[0][1]) / 2 : first.radius;
      const cx = line ? (line[0][0] + line[1][0]) / 2 : first.cx;
      const cy = line ? (line[0][1] + line[1][1]) / 2 : first.cy;
      const scale = (2 * radius) / Math.min(comp.width, comp.height);
      set(e, "position", f2(cx / comp.width, cy / comp.height));
      set(e, "alignmentPosition", f2(0.5, 0.5));
      set(e, "scale", line ? f2((2 * radius) / comp.width, scale) : f2(scale, scale));
      set(e, "scaleIsUniform", 0);
      set(e, "rotation", 0);
      set(e, "ShapePath", line ? "HorizontalLine" : "Circle");
      setSub(e, "ShapePath", "radius", 1);
      setSub(e, "ShapePath", "gap", 0);
      const outward = line || sweep >= 0 ? SIDE_A : SIDE_B;
      const sign = num(effect, AS.side) === outward ? 1 : -1;
      const height = (maxHeight / (RING_MAX_HEIGHT * (radius / RING_RADIUS || 1))) * RING_BAR_HEIGHT;
      set(e, "heightScale", round(clamp((sign * height) / 0.1, -10, 10), 4));
      set(e, "Segment1", bands >= 500 ? "Line" : "Bars");
      setSub(e, "Segment1", "colorFrom", packArgb(color(AS.insideColor)));
      setSub(e, "Segment1", "colorTo", packArgb(color(AS.outsideColor)));
      setSub(e, "Segment1", "barHeightMultiplier", 0.1);
      set(e, "Segment2", "None");
      set(e, "flipInput", 0);
      set(e, "audioProviderIndex", providers.length);
      finish(e, layer, comp, true);
      out.push(e);
    }
    return out;
  };

  /** Particular as Particles (convert.ts's mapping, the other way). */
  const particlesOf = (layer: Layer, comp: CompItem, particular: PropertyGroup): Json => {
    const value = (n: number, fallback: number) => {
      const prop = particular.children.find((c): c is Property => c.kind === "property" && c.matchName === `${PARTICULAR}-${String(n).padStart(4, "0")}`);
      const v = prop ? valueAtTime(prop, 0, layer) : undefined;
      return typeof v === "number" ? v : Array.isArray(v) ? (v as number[]) : fallback;
    };
    const n = (k: number, fallback: number) => {
      const v = value(k, fallback);
      return typeof v === "number" ? v : fallback;
    };
    const e = base("Particles", layer);
    const position = value(P.position, 0);
    const [px, py] = Array.isArray(position) ? position : [comp.width / 2, comp.height / 2];
    set(e, "position", f2(px / comp.width, py / comp.height));
    set(e, "alignmentPosition", f2(0.5, 0.5));
    set(e, "scale", f2(n(P.emitterSizeX, comp.width) / comp.width, n(P.emitterSizeY, comp.height) / comp.height));
    set(e, "perspectiveDepth", clamp(n(P.emitterSizeZ, 0), 0, 1000));
    const life = clamp(n(P.life, 3), 0.1, 10);
    const rate = Math.max(1e-3, n(P.rate, 100));
    set(e, "lifetime", round(life, 3));
    set(e, "spawnTime", round(1 / rate, 6));
    set(e, "CountLimit", Math.round(clamp(rate * life, 1, 5000)));
    const speed = n(P.velocity, 100) / PARTICLE_VELOCITY;
    set(e, "Speed", round(speed, 4));
    set(e, "speedRandom", round((speed * n(P.velocityRandom, 0)) / 100, 4));
    const size = n(P.size, 4) / PARTICLE_SIZE;
    const random = clamp(n(P.sizeRandom, 0), 0, 99) / 100;
    set(e, "startSize", 0);
    set(e, "fadeInSize", round(size, 4));
    set(e, "endSize", round(size, 4));
    set(e, "endSizeRandom", round((size * random) / (1 - random), 4));
    const color = value(P.color, 0);
    if (Array.isArray(color)) {
      set(e, "ColorFrom", hslaText(color.slice(0, 3)));
      set(e, "ColorTo", hslaText(color.slice(0, 3)));
    }
    set(e, "gravity", f2(n(22, 0) / PARTICLE_GRAVITY, n(17, 0) / PARTICLE_GRAVITY));
    setSub(e, "SpawnArea", "useRandomVectorInstead", n(P.direction, UNIFORM) === UNIFORM ? 1 : 0);
    set(e, "customImage", "internalres:particle_blur01");
    for (const mirror of effectsOf(layer, MIRROR)) {
      const angle = ((((valueAtTime(param(mirror, 2), 0, layer) as number) || 0) % 180) + 180) % 180;
      set(e, angle > 45 && angle < 135 ? "mirrorY" : "mirrorX", 1);
    }
    const factor = particular.children.find((c): c is Property => c.kind === "property" && c.matchName === `${PARTICULAR}-${String(P.timeFactor).padStart(4, "0")}`);
    const boost = factor?.expressionEnabled ? numberIn(factor.expression, /^1 \+ ([\d.e-]+) \*/) : undefined;
    if (boost) setMeasure(e, "MeasureOverallSpeed", "Beat", boost[0], boost[0]);
    else if (factor?.expressionEnabled && BEAT.test(factor.expression)) setMeasure(e, "MeasureOverallSpeed", "Beat", 2, 2);
    finish(e, layer, comp, false);
    report.add("Particular becomes Avee's Particles; its sprites, curves and physics are approximated.");
    return e;
  };

  /** A layer's elements: its content (or what its effects make of it), wrapped in its Mirror and Blur effects. */
  function elementsOf(layer: Layer, comp: CompItem, options: { matte?: boolean } = {}): Json[] {
    if (layer.layerType !== "AVLayer") {
      report.add(`${layer.layerType.replace(/Layer$/, "")} layers are left out.`);
      return [];
    }
    if (layer.guideLayer || layer.nullLayer) return [];
    const effects = (layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade")?.children ?? []).filter(
      (n): n is PropertyGroup => n.kind === "group" && n.enabled !== false,
    );
    const particular = effects.find((fx) => fx.matchName === PARTICULAR);
    if (particular) return [particlesOf(layer, comp, particular)];
    const spectra = effects.filter((fx) => fx.matchName === AUDIO_SPECTRUM);
    let elements: Json[];
    if (spectra.length) elements = barsOf(layer, comp, spectra);
    else {
      const content = contentOf(layer, comp);
      elements = content ? [content] : [];
    }
    if (!elements.length || options.matte) return elements;

    // The layer's effects in stack order, each drawing what the ones before it made: Avee's own Mirror and Blur
    // Effects where it has them, shaders (shaders.ts) where it does not.
    const source = project.items.get(layer.sourceId);
    // A ring's Polar Coordinates is in its Bars' circle; an adjustment layer's Fill is its black or white image.
    const absorbed = new Set([...ABSORBED, ...(spectra.length ? [POLAR] : []), ...(layer.adjustmentLayer ? [FILL] : [])]);
    for (const fx of effects) {
      if (absorbed.has(fx.matchName) || CONTROLS.test(fx.matchName)) continue;
      const native = fx.matchName === MIRROR ? "MirrorEffect" : BLURS[fx.matchName] ? "BlurEffect" : undefined;
      if (!native && !SHADER_EFFECTS.has(fx.matchName)) {
        report.add(`The effect "${fx.effectName ?? fx.name}" is left out.`);
        continue;
      }
      // A precomp with the effect is the effect drawing the precomp's composition where the layer is (After Effects
      // applies effects before the layer's transform); else the effect draws a composition holding what it applies to.
      const content = elements[0];
      const direct =
        elements.length === 1 &&
        source?.kind === "comp" &&
        /^composition:\d+$/.test(String((content.customImage as Prop | undefined)?.v)) &&
        !(content.MaskImage as Prop | undefined)?.v &&
        (content.Shape as Prop | undefined)?.v !== "Circle";
      let target: number;
      let size: number[];
      let toTexture: (point: number[]) => number[];
      let lengthScale: number;
      if (direct) {
        target = Number(((content.customImage as Prop).v as string).slice("composition:".length));
        size = [source.width, source.height];
        toTexture = (pt) => pt;
        lengthScale = 1;
      } else {
        target = newComposition();
        compositions[target].push(...elements);
        size = [comp.width, comp.height];
        const m = restMatrix(layer, comp);
        toTexture = (pt) => m.transformPoint([pt[0], pt[1], 0]).slice(0, 2);
        const o = m.transformPoint([0, 0, 0]);
        const x = m.transformPoint([1, 0, 0]);
        lengthScale = Math.hypot(x[0] - o[0], x[1] - o[1]);
      }
      const value = (n: number) => {
        try {
          return valueAtTime(param(fx, n), 0, layer);
        } catch {
          return undefined;
        }
      };
      let effect: Json | undefined;
      if (native) {
        effect = base(native, layer);
        if (native === "MirrorEffect") {
          const angle = ((((value(2) as number) || 0) % 360) + 360) % 360;
          set(effect, "TargetImage", `composition:${target}`);
          set(effect, "mirrorMode", angle % 180 > 45 && angle % 180 < 135 ? "Vertical" : "Horizontal");
          set(effect, "flipMirror", angle >= 135 && angle < 315 ? 1 : 0);
        } else {
          const blur = (BLURS[fx.matchName](value) * lengthScale) / BLUR_PIXELS;
          const radius = clamp(blur, 0, 3);
          set(effect, "sourceCompositionIndex", target);
          set(effect, "blurRadius", round(radius, 4));
          set(effect, "blurMultiplier", round(radius > 0 ? clamp(blur / radius, 1, 6) : 1, 4));
          set(effect, "showUnblurredContent", 0);
          set(effect, "showUnblurredContentUnder", 0);
        }
      } else {
        const reader: EffectReader = {
          scale: lengthScale,
          num: (n, fallback) => {
            const v = value(n);
            return typeof v === "number" && Number.isFinite(v) ? v : fallback;
          },
          rgb: (n, fallback) => {
            const v = value(n);
            return Array.isArray(v) && v.length >= 3 ? (v as number[]).slice(0, 3) : fallback;
          },
          point: (n, fallback) => {
            const v = value(n);
            return toTexture(Array.isArray(v) && v.length >= 2 ? (v as number[]) : fallback);
          },
        };
        const shader = effectShader(fx.matchName, reader, size);
        if (!shader) {
          report.add(`The effect "${fx.effectName ?? fx.name}" is left out.`);
          if (!direct) compositions[target].length = 0;
          continue;
        }
        effect = base("CustomShader", layer);
        set(effect, "tag", `${layer.name} (${fx.effectName ?? fx.name})`);
        set(effect, "TargetImage", `composition:${target}`);
        set(effect, "shaderFragment", shader.fragment);
        set(effect, "shaderVertex", SHADER_VERTEX);
        effect.varGroup = shaderVariables(shader.variables);
        report.add("Effects Avee has no element for are drawn by shaders written for them (GLSL; untried in Avee Player).");
      }
      if (direct) {
        for (const key of ["position", "alignmentPosition", "scale", "scaleIsUniform", "rotation", "measureScale", "measureRot", "MeasurePos", "blendMode", "visible"]) {
          if (content[key] !== undefined) effect[key] = clone(content[key]);
        }
      } else {
        set(effect, "blendMode", "PreMulAlpha");
        set(effect, "visible", layer.enabled ? 1 : 0);
      }
      if (native === "BlurEffect") set(effect, "blendModeContent", (effect.blendMode as Prop | undefined)?.v ?? "PreMulAlpha");
      elements = [effect];
    }
    return elements;
  }

  // The comp, then every other comp of the project, each with the comps it shows: a template holds them all.
  const comps = [main, ...[...project.items.values()].filter((i): i is CompItem => i.kind === "comp" && i.id !== main.id)];
  for (const start of comps) {
    if (indexOf.has(start.id)) continue;
    compositionOf(start);
    while (pending.length) {
      const comp = pending.shift()!;
      const index = indexOf.get(comp.id)!;
      const mattes = new Set(comp.layers.filter((l) => l.trackMatteType && l.trackMatteType !== 5012).map((l) => matteLayerOf(l, comp)?.id));
      for (const layer of [...comp.layers].reverse()) {
        if (mattes.has(layer.id)) continue;
        try {
          compositions[index].push(...elementsOf(layer, comp));
        } catch (error) {
          report.add(`"${layer.name}" could not be exported: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  compositions[0].unshift(...providers);
  const scene = {
    compositions: compositions.map((elements) => ({ ...clone((schema as Record<string, Json>).Composition), elements })),
    ver: "10",
    template: 1,
    objType: "Root",
  };
  return { files: [{ path: "scene.json", data: new TextEncoder().encode(JSON.stringify(scene)), compress: true }, ...files], report: report.list() };
}

/** Points along a path: each vertex and the middle of the curve to the next, so even a short arc gives three. */
function curvePoints(shape: Shape): number[][] {
  const n = shape.vertices.length;
  const out: number[][] = [];
  const segments = shape.closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const a = shape.vertices[i];
    const b = shape.vertices[(i + 1) % n];
    const c1 = [a[0] + shape.outTangents[i][0], a[1] + shape.outTangents[i][1]];
    const c2 = [b[0] + shape.inTangents[(i + 1) % n][0], b[1] + shape.inTangents[(i + 1) % n][1]];
    out.push(a, [0.125 * a[0] + 0.375 * c1[0] + 0.375 * c2[0] + 0.125 * b[0], 0.125 * a[1] + 0.375 * c1[1] + 0.375 * c2[1] + 0.125 * b[1]]);
  }
  out.push(shape.vertices[shape.closed ? 0 : n - 1]);
  return out;
}

function boundsOf(points: number[][]): { w: number; h: number } {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** The circle through three points, or null when they are on a line. */
function circleThrough(a: number[], b: number[], c: number[]): { cx: number; cy: number; radius: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const sq = (p: number[]) => p[0] * p[0] + p[1] * p[1];
  const cx = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
  const cy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
  return { cx, cy, radius: Math.hypot(a[0] - cx, a[1] - cy) };
}
