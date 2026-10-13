// Avee Player visualizer templates (.viz): a ZIP of `scene.json` and the template's
// images, or the same files unpacked in a folder. The scene is a list of
// compositions, each a list of elements drawn bottom first; every property is
// self-describing, `{ v: value, t: "type range…", o: order, tag: group }`.
// What the fields mean, and how sure that is, is in docs/viz-format.md.
import { readZip, type ZipEntry } from "../media/zip.ts";

/** An element: its type and its properties, read through the accessors below. */
export type VizElement = { objType: string } & Record<string, unknown>;

export interface VizScene {
  /** Each composition's elements, bottom first; composition 0 is what the template shows. */
  compositions: VizElement[][];
}

export interface VizTemplate {
  name: string;
  scene: VizScene;
  /** The template's own files (its images), by their path beside scene.json. */
  assets: Map<string, Blob>;
}

/** Limits against damaged or hostile files. */
const MAX_SCENE_BYTES = 64 << 20;
const MAX_COMPOSITIONS = 1000;
const MAX_ELEMENTS = 20_000;
const SCENE = "scene.json";

interface Prop {
  v?: unknown;
  t?: string;
  hint?: string;
  [key: string]: unknown;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Reads scene.json; throws, saying why, when it is not an Avee Player scene. */
export function parseScene(text: string): VizScene {
  if (text.length > MAX_SCENE_BYTES) throw new Error("The template's scene is too large");
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error("The template's scene.json is not valid JSON");
  }
  if (!isObject(root) || !Array.isArray(root.compositions)) throw new Error("This is not an Avee Player template (its scene has no compositions)");
  if (root.compositions.length > MAX_COMPOSITIONS) throw new Error("The template has too many compositions");
  let count = 0;
  const compositions = root.compositions.map((c) => {
    const elements = isObject(c) && Array.isArray(c.elements) ? c.elements : [];
    const kept = elements.filter((e): e is VizElement => isObject(e) && typeof e.objType === "string");
    count += kept.length;
    return kept;
  });
  if (count > MAX_ELEMENTS) throw new Error("The template has too many elements");
  if (!compositions.length) throw new Error("The template has no compositions");
  return { compositions };
}

const prop = (e: VizElement, key: string): Prop | undefined => (isObject(e[key]) ? (e[key] as Prop) : undefined);

const finite = (value: unknown): number | undefined => {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

export function num(e: VizElement, key: string, fallback = 0): number {
  return finite(prop(e, key)?.v) ?? fallback;
}

export function bool(e: VizElement, key: string, fallback = false): boolean {
  const v = finite(prop(e, key)?.v);
  return v === undefined ? fallback : v !== 0;
}

export function text(e: VizElement, key: string, fallback = ""): string {
  const v = prop(e, key)?.v;
  return typeof v === "string" ? v : fallback;
}

/** A space-separated vector ("0.500000 0.500000"). */
export function vector(e: VizElement, key: string, fallback: number[]): number[] {
  const v = prop(e, key)?.v;
  if (typeof v !== "string") return fallback;
  const parts = v.trim().split(/\s+/).map(Number);
  return parts.length >= fallback.length && parts.every(Number.isFinite) ? parts.slice(0, fallback.length) : fallback;
}

/** A packed ARGB integer as [r, g, b, a] in 0–1. */
export function argb(value: number): [number, number, number, number] {
  const c = value >>> 0;
  return [((c >>> 16) & 255) / 255, ((c >>> 8) & 255) / 255, (c & 255) / 255, ((c >>> 24) & 255) / 255];
}

/** An "crgba" or "crgb" colour as [r, g, b, a] in 0–1. */
export function color(e: VizElement, key: string, fallback: [number, number, number, number] = [1, 1, 1, 1]): [number, number, number, number] {
  const v = finite(prop(e, key)?.v);
  return v === undefined ? fallback : argb(v);
}

/** An HSL colour (all 0–1) as RGB. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s <= 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const u = t - Math.floor(t);
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

/** A "chsla4f" colour ("h s l a", all 0–1) as [r, g, b, a]. */
export function hsla(e: VizElement, key: string): [number, number, number, number] {
  const [h, s, l, a] = vector(e, key, [0, 0, 1, 1]).map((x) => Math.min(1, Math.max(0, x)));
  return [...hslToRgb(h, s, l), a];
}

/** A property's sub-property ("radius" of ShapePath), as an element to read with the accessors. */
export function child(e: VizElement, key: string): VizElement {
  return { objType: text(e, key), ...(prop(e, key) ?? {}) } as VizElement;
}

/**
 * What drives an animated property ("measureScale", "MeasureColorBlend"…): the
 * measure, and its A and B amounts as stored (templates go past the ranges their
 * types declare, which are the editor's slider ranges). Undefined when nothing
 * does ("Nothing").
 */
export interface Measure {
  what: string;
  a: number;
  b: number;
}

export function measure(e: VizElement, key: string): Measure | undefined {
  const p = prop(e, key);
  const what = isObject(p?.measureWhat) ? (p.measureWhat as Prop).v : undefined;
  if (typeof what !== "string" || what === "Nothing" || !p) return undefined;
  const amount = (k: string) => finite(isObject(p[k]) ? (p[k] as Prop).v : undefined) ?? 0;
  return { what, a: amount("A"), b: amount("B") };
}

/** An image source: an asset ("local:name"), a composition, one of Avee's built-in images, or nothing. */
export type ImageSource = { kind: "asset"; name: string } | { kind: "composition"; index: number } | { kind: "builtin"; name: string } | { kind: "none" };

export function imageSource(value: string): ImageSource {
  if (value.startsWith("local:")) return { kind: "asset", name: value.slice(6) };
  const comp = /^composition:(\d+)$/.exec(value);
  if (comp) return { kind: "composition", index: Number(comp[1]) };
  if (value.startsWith("internalres:")) return value === "internalres:transparent" ? { kind: "none" } : { kind: "builtin", name: value.slice(12) };
  return { kind: "none" };
}

/** The compositions an element draws or masks with (images, effect targets, blur sources, mask images). */
export function referencedCompositions(e: VizElement): number[] {
  const out: number[] = [];
  for (const key of ["customImage", "TargetImage", "targetImage", "MaskImage"]) {
    const source = imageSource(text(e, key));
    if (source.kind === "composition") out.push(source.index);
  }
  if (prop(e, "sourceCompositionIndex")) out.push(num(e, "sourceCompositionIndex", -1));
  return out.filter((i) => Number.isInteger(i) && i >= 0);
}

/** The template's file for an asset name, which may leave out the file's extension ("local:5511" for 5511.gif). */
export function assetFile(template: VizTemplate, name: string): { name: string; blob: Blob } | undefined {
  const exact = template.assets.get(name);
  if (exact) return { name, blob: exact };
  for (const [path, blob] of template.assets) if (path.replace(/\.[a-z0-9]+$/i, "") === name) return { name: path, blob };
  return undefined;
}

const stem = (name: string) => name.replace(/\.viz$/i, "").replace(/^.*[\\/]/, "") || "Avee Template";

function fromFiles(name: string, files: readonly { path: string; read: () => Promise<Blob> }[]) {
  const depth = (p: string) => p.split("/").length;
  const scene = files.filter((f) => f.path === SCENE || f.path.endsWith(`/${SCENE}`)).sort((a, b) => depth(a.path) - depth(b.path))[0];
  if (!scene) return undefined;
  const folder = scene.path.slice(0, scene.path.length - SCENE.length);
  return {
    name,
    scene,
    others: files.filter((f) => f !== scene && f.path.startsWith(folder)).map((f) => ({ ...f, path: f.path.slice(folder.length) })),
  };
}

async function template(found: NonNullable<ReturnType<typeof fromFiles>>): Promise<VizTemplate> {
  const scene = parseScene(await (await found.scene.read()).text());
  const assets = new Map<string, Blob>();
  for (const file of found.others) {
    try {
      assets.set(file.path, await file.read());
    } catch {
      // An unreadable image stays missing; the converter reports it.
    }
  }
  return { name: found.name, scene, assets };
}

/** The template in a .viz archive; undefined when the archive is not one (it holds an .aep, or no scene.json). */
export async function vizFromArchive(file: Blob, name: string, entries?: ZipEntry[]): Promise<VizTemplate | undefined> {
  const listed = entries ?? (await readZip(file));
  if (listed.some((e) => /\.aep$/i.test(e.path))) return undefined;
  const found = fromFiles(stem(name), listed);
  return found ? template(found) : undefined;
}

/** The template among picked or dropped files (an unpacked .viz folder); undefined without a scene.json. */
export async function vizFromFiles(files: readonly { path: string; blob: Blob }[]): Promise<VizTemplate | undefined> {
  const listed = files.map((f) => ({ path: f.path.replace(/\\/g, "/"), read: async () => f.blob }));
  const scene = listed.find((f) => f.path === SCENE || f.path.endsWith(`/${SCENE}`));
  if (!scene) return undefined;
  const folder = scene.path.split("/").slice(-2, -1)[0] ?? "";
  const found = fromFiles(stem(folder), listed);
  return found ? template(found) : undefined;
}
