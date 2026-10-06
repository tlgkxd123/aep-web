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
}

export interface RenderContext {
  readonly gl: GL;
  readonly pool: TargetPool;
  /** Width of the transparent border around every image. */
  readonly pad: number;
  readonly project: Project;
  /** Records something skipped or approximated in this frame; shown in the UI. */
  warn(message: string): void;
  /** Uploads straight-alpha pixels (canvas, bitmap, video frame...; top row first) into a new padded image. */
  upload(source: TexImageSource, width: number, height: number, origin?: [number, number]): LayerImage;
  /** Renders a composition at its own time, one nesting level deeper. Returns a comp-sized padded target. */
  renderComp(comp: CompItem, time: number): Target;
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

const providers: ContentProvider[] = [];
const effects = new Map<string, EffectRenderer>();

export function registerContentProvider(provider: ContentProvider): void {
  providers.push(provider);
}

export function contentProviders(): readonly ContentProvider[] {
  return providers;
}

export function registerEffect(matchName: string, renderer: EffectRenderer): void {
  effects.set(matchName, renderer);
}

export function effectRenderer(matchName: string): EffectRenderer | undefined {
  return effects.get(matchName);
}
