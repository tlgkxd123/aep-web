// Extension points of the compositor. Feature modules (text, footage, effects...)
// register themselves here from src/render/features.ts, so the renderer core does
// not need to know about each of them.
//
// Every image is a premultiplied RGBA8 target with a `pad`-pixel transparent
// border, rows in GL order (row 0 = bottom of the image).
import type { CompItem, Layer, Project, PropertyGroup } from "../aep/model.ts";
import type { GL, Target, TargetPool } from "./gl.ts";

/** Content of a layer in its own pixel space, with the transparent border. */
export interface LayerImage {
  target: Target;
  /** Content size without the border. */
  width: number;
  height: number;
  /** Layer-space position of the first content pixel (content may extend around the layer origin). */
  origin: [number, number];
  /**
   * Image pixels per layer pixel (1 when absent): at a reduced resolution, size and origin count image pixels,
   * and a layer pixel position p is at p * scale. Only effects registered `scalable` are handed such images.
   */
  scale?: number;
}

export interface RendererOptions {
  /**
   * Effects whose plugins are not installed are skipped, as After Effects does.
   * When set, unverified look-alikes drawn from their stored parameters are used instead.
   */
  approximateMissingPlugins: boolean;
  /** Sapphire effects (S_Blur, S_BlurDirectional, S_Shake, S_Glow, S_ZGlow, S_Flicker) are drawn with look-alikes instead of being skipped. */
  sapphireLookalikes: boolean;
}

export interface RenderContext {
  readonly gl: GL;
  readonly options: Readonly<RendererOptions>;
  readonly pool: TargetPool;
  /** Width of the transparent border around every image. */
  readonly pad: number;
  /**
   * The resolution the render wants layer content at (image pixels per layer pixel). A content provider may
   * return its image at it (with LayerImage.scale set) or at full resolution, which the renderer then reduces.
   */
  readonly scale: number;
  readonly project: Project;
  /** Records something skipped or approximated in this frame; shown in the UI. */
  warn(message: string): void;
  /**
   * Records that something this frame needs (decoded footage, audio) is still loading: the frame is drawn
   * without it and is incomplete, to be rendered again once it arrives.
   */
  loading(message: string): void;
  /** Uploads straight-alpha pixels (canvas, bitmap, video frame...; top row first) into a new padded image. */
  upload(source: TexImageSource, width: number, height: number, origin?: [number, number]): LayerImage;
  /** Renders a composition at its own time, one nesting level deeper. Returns a comp-sized padded target. */
  renderComp(comp: CompItem, time: number): Target;
  /**
   * Another layer's image in its own layer space (for layer parameters such as
   * Set Matte or Displacement Map): its source only, or after its masks and
   * effects. Null when it draws nothing or would reference itself. Caller releases.
   */
  layerImage(layer: Layer, time: number, withMasksAndEffects: boolean): LayerImage | null;
  /** Compiles (once, cached) a fragment shader for `pass`; it receives `v_uv` over the full target. */
  program(fragmentSource: string): WebGLProgram;
  /** Draws `program` over all of `out`, with `inputs` bound to texture units 0..n-1. */
  pass(program: WebGLProgram, out: Target, inputs: Target[], setUniforms?: (uniform: (name: string) => WebGLUniformLocation | null) => void): void;
}

/**
 * Produces the image of a layer's source. Return `undefined` when the layer is
 * not handled by this provider, `null` when it is but draws nothing.
 */
export type ContentProvider = (layer: Layer, time: number, ctx: RenderContext) => LayerImage | null | undefined;

/**
 * Applies one effect instance (`effect` is the effect's property group in the
 * layer's "ADBE Effect Parade") to the layer image, after masks and before the
 * layer transform. Must return a new image (and may release `input`).
 */
export type EffectRenderer = (input: LayerImage, effect: PropertyGroup, layer: Layer, time: number, ctx: RenderContext) => LayerImage;

export interface EffectOptions {
  /**
   * The effect's output depends only on its input image, its own parameter values and the layer: not on the time
   * itself, audio, footage, other layers or state kept between frames. Layers whose effects all are can be
   * reused from one frame to the next while those values stay the same (see layerKeys.ts).
   */
  cacheable?: boolean;
  /**
   * The effect renders images at a reduced resolution (LayerImage.scale): it multiplies what its parameters say in
   * layer pixels (positions, radii, widths) by the scale, as After Effects effects follow the downsample factor.
   * Layers with an effect that does not render at full resolution and are resampled when placed.
   */
  scalable?: boolean;
}

const providers: ContentProvider[] = [];
const effects = new Map<string, EffectRenderer>();
const cacheableEffects = new Set<string>();
const scalableEffects = new Set<string>();
const prefixEffects: [string, EffectRenderer, EffectOptions][] = [];

export function registerContentProvider(provider: ContentProvider): void {
  providers.push(provider);
}

export function contentProviders(): readonly ContentProvider[] {
  return providers;
}

export function registerEffect(matchName: string, renderer: EffectRenderer, options: EffectOptions = {}): void {
  effects.set(matchName, renderer);
  for (const [set, on] of [
    [cacheableEffects, options.cacheable],
    [scalableEffects, options.scalable],
  ] as const) {
    if (on) set.add(matchName);
    else set.delete(matchName);
  }
}

/** Whether a layer using the effect may be reused between frames (EffectOptions.cacheable); false for effects with no renderer. */
export function effectIsCacheable(matchName: string): boolean {
  if (effects.has(matchName)) return cacheableEffects.has(matchName);
  return !!prefixEffects.find(([prefix]) => matchName.startsWith(prefix))?.[2].cacheable;
}

/** Whether the effect renders at a reduced resolution (EffectOptions.scalable); true for effects with no renderer, which draw nothing. */
export function effectIsScalable(matchName: string): boolean {
  if (effects.has(matchName)) return scalableEffects.has(matchName);
  const prefixed = prefixEffects.find(([prefix]) => matchName.startsWith(prefix));
  return prefixed ? !!prefixed[2].scalable : true;
}

/** Registers a renderer for every effect whose match name starts with `prefix`. */
export function registerEffectPrefix(prefix: string, renderer: EffectRenderer, options: EffectOptions = {}): void {
  prefixEffects.push([prefix, renderer, options]);
}

export function effectRenderer(matchName: string): EffectRenderer | undefined {
  return effects.get(matchName) ?? prefixEffects.find(([prefix]) => matchName.startsWith(prefix))?.[1];
}

/** Match names with a renderer of their own (not those covered by a prefix). */
export function registeredEffects(): string[] {
  return [...effects.keys()];
}
