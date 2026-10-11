// WebGL2 compositor for After Effects compositions.
//
// Every image lives in a premultiplied RGBA8 target with a 1px transparent
// border, so bilinear sampling gives transformed layers antialiased edges.
// Target memory follows GL convention (row 0 = bottom of the image).
import { currentValue, layerTimeAt, setExpressionScope } from "../aep/evaluate.ts";
import type { CompItem, Layer, Project, Property, PropertyGroup, PropertyNode } from "../aep/model.ts";
import { cameraAt, localTransform, Mat4, worldMatrix, type Camera } from "../aep/transform.ts";
import { footageStore } from "../media/store.ts";
import { ImageCache, LayerCache, valuesKey } from "./contentCache.ts";
import "./features.ts";
import { trimFloat } from "./floatTargets.ts";
import { sourcePixelAspect } from "./footage.ts";
import { bindTarget, compile, filterRedundantState, finishGpu, TargetPool, unitQuad, type GL, type Target } from "./gl.ts";
import { LayerKeys } from "./layerKeys.ts";
import { MaskRenderer } from "./masks.ts";
import { contentProviders, effectIsScalable, effectRenderer, type LayerImage, type RenderContext, type RendererOptions } from "./registry.ts";
import { rasterizeShapeLayer } from "./shapes.ts";
import { COMPOSITE_FS, FILL_FS, FULLSCREEN_VS, LAYER_FS, LAYER_VS, MASK_FS, MatteMode, REDUCE_FS } from "./shaders.ts";

const PAD = 1;
const NO_MATTE = 5012;
const MATTE_MODES: Record<number, number> = {
  5013: MatteMode.ALPHA,
  5014: MatteMode.ALPHA_INVERTED,
  5015: MatteMode.LUMA,
  5016: MatteMode.LUMA_INVERTED,
};
const MAX_DEPTH = 16;
/** Render target memory pooled between frames at most (8-bit and float). */
const POOL_BYTES = 1024 * 1024 * 1024;
const FLOAT_POOL_BYTES = 1024 * 1024 * 1024;
/** Layer images (and adjustment layers' coverage) kept for reuse in later frames, at most. */
const LAYER_CACHE_BYTES = 320 * 1024 * 1024;
const COVERAGE_CACHE_BYTES = 64 * 1024 * 1024;

/** A layer image kept between frames, with what rendering it warned about. */
interface CachedImage {
  image: LayerImage;
  warnings: string[];
}

export interface RenderOptions {
  /**
   * Resolution of the result relative to the comp (1/2 for Half...). Nested comps, layer content, masks and
   * effects render at it too, as After Effects does at a reduced resolution; a layer with an effect that cannot
   * (one not registered `scalable`) renders at full resolution and is resampled when placed.
   */
  scale?: number;
}

/** Pixels of a comp dimension rendered at `scale` (1/3 of 1920 is 640, not 641). */
export function scaledSize(size: number, scale: number): number {
  return scale === 1 ? size : Math.max(1, Math.ceil(size * scale - 1e-6));
}

interface Programs {
  layer: WebGLProgram;
  mask: WebGLProgram;
  fill: WebGLProgram;
  composite: WebGLProgram;
  reduce: WebGLProgram;
}

function findProperty(nodes: PropertyNode[], path: string[]): Property | undefined {
  let level = nodes;
  for (let i = 0; i < path.length; i++) {
    const node = level.find((n) => n.matchName === path[i]);
    if (!node) return undefined;
    if (i === path.length - 1) return node.kind === "property" ? node : undefined;
    if (node.kind !== "group") return undefined;
    level = node.children;
  }
  return undefined;
}

export class Renderer {
  readonly gl: GL;
  readonly options: RendererOptions;
  private readonly quad: WebGLVertexArrayObject;
  private readonly programs: Programs;
  private readonly pool: TargetPool;
  private readonly masks: MaskRenderer;
  private readonly uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private project!: Project;
  private warnings = new Set<string>();
  private complete = true;
  private readonly passPrograms = new Map<string, WebGLProgram>();
  /** When set, each render stage's exclusive time (GPU work included, see finishGpu) accumulates here by name. */
  profile: Map<string, { ms: number; count: number }> | null = null;
  private readonly profileStack: number[] = [];
  private readonly layersInProgress = new Set<Layer>();
  private readonly shapeCache: LayerCache<LayerImage | null>;
  private keys: LayerKeys;
  private readonly images: ImageCache<CachedImage>;
  private readonly coverages: ImageCache<CachedImage>;
  /** Reuses layer images whose key (layerKeys.ts) is unchanged since an earlier frame; off only to compare against. */
  reuseLayers = true;
  /** Layer images reused and rendered under a key, for profiling. */
  readonly reuseStats = { hits: 0, misses: 0 };
  /** Layers and comps that render at a reduced resolution (layerScales, compScales). */
  private scalable = new WeakMap<object, boolean>();
  /** Per comp, what its layers drew the last time it rendered and how many bottom ones the kept composite holds. */
  private readonly prefixes = new Map<CompItem, { parts: (string | null)[]; held: number }>();
  private cachedProject?: Project;

  /** `options` may be shared with other renderers and changed between renders. */
  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, options: RendererOptions = { approximateMissingPlugins: false, sapphireLookalikes: false }) {
    this.options = options;
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl as GL;
    filterRedundantState(this.gl);
    this.quad = unitQuad(this.gl);
    this.pool = new TargetPool(this.gl);
    this.programs = {
      layer: compile(this.gl, LAYER_VS, LAYER_FS),
      mask: compile(this.gl, FULLSCREEN_VS, MASK_FS),
      fill: compile(this.gl, FULLSCREEN_VS, FILL_FS),
      composite: compile(this.gl, FULLSCREEN_VS, COMPOSITE_FS),
      reduce: compile(this.gl, FULLSCREEN_VS, REDUCE_FS),
    };
    this.masks = new MaskRenderer(this.gl, () => this.draw());
    this.shapeCache = new LayerCache((image) => image && this.pool.release(image.target));
    this.keys = this.newKeys();
    const dispose = (cached: CachedImage) => this.pool.release(cached.image.target);
    this.images = new ImageCache(LAYER_CACHE_BYTES, dispose);
    this.coverages = new ImageCache(COVERAGE_CACHE_BYTES, dispose);
  }

  private newKeys(): LayerKeys {
    const project = () => this.project;
    return new LayerKeys({
      get project() {
        return project();
      },
      drawOrder: (comp, time) => {
        if (comp.layers.some((l) => l.threeDLayer)) return null;
        return this.drawOrder(comp, time, undefined, comp.layers.some((l) => l.solo && this.isRenderable(l)));
      },
      matteLayerOf: (layer, comp) => this.matteLayerOf(layer, comp),
      isActive: (layer, time) => this.isActive(layer, time),
    });
  }

  /** Drops cached layer content; needed only when the project changes in ways its values do not show. */
  clearCaches(): void {
    this.shapeCache.clear();
    this.images.clear();
    this.coverages.clear();
    this.keys = this.newKeys();
    this.scalable = new WeakMap();
    this.prefixes.clear();
  }

  /** Things the renderer skipped or approximated in the last frame (unsupported layer kinds, missing footage...). */
  get lastWarnings(): string[] {
    return [...this.warnings];
  }

  /** False when the last frame was drawn while footage or audio it needs was still loading. */
  get lastComplete(): boolean {
    return this.complete;
  }

  /** Renders `comp` at composition time `time`; the returned target is owned by the caller (see `release`). */
  render(project: Project, comp: CompItem, time: number, options: RenderOptions = {}): Target {
    if (project !== this.cachedProject) {
      this.clearCaches();
      this.cachedProject = project;
    }
    this.project = project;
    const warnings = (this.warnings = new Set());
    this.complete = true;
    setExpressionScope({ project, warn: (message) => warnings.add(message) });
    this.keys.newFrame();
    const result = this.renderComp(comp, time, 0, options.scale ?? 1);
    this.pool.trim(Math.max(POOL_BYTES, 8 * result.width * result.height * 4));
    trimFloat(this.gl, FLOAT_POOL_BYTES);
    return result;
  }

  release(target: Target): void {
    this.pool.release(target);
  }

  /**
   * Asks the footage store for every movie frame `comp` shows at `time`, nested comps included, so they decode
   * before the frame renders; renders nothing. True when they have all decoded (or cannot be).
   */
  requestFootage(project: Project, comp: CompItem, time: number): boolean {
    if (project !== this.cachedProject) {
      this.clearCaches();
      this.cachedProject = project;
    }
    this.project = project;
    setExpressionScope({ project, warn: () => {} });
    let ready = true;
    this.keys.footage(comp, time, (item, frame) => {
      if (footageStore.frame(item, frame).status === "pending") ready = false;
    });
    return ready;
  }

  /** Straight-alpha RGBA pixels of a rendered comp, rows top to bottom, without the border. */
  readPixels(target: Target, width: number, height: number): Uint8Array {
    const gl = this.gl;
    bindTarget(gl, target);
    const raw = new Uint8Array(width * height * 4);
    gl.readPixels(PAD, PAD, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const out = new Uint8Array(raw.length);
    for (let y = 0; y < height; y++) {
      const src = (height - 1 - y) * width * 4;
      const dst = y * width * 4;
      for (let x = 0; x < width * 4; x += 4) {
        const a = raw[src + x + 3];
        for (let c = 0; c < 3; c++) out[dst + x + c] = a ? Math.min(255, Math.round((raw[src + x + c] * 255) / a)) : 0;
        out[dst + x + 3] = a;
      }
    }
    return out;
  }

  /** Straight-alpha RGBA of one comp pixel of a rendered comp. */
  readPixel(target: Target, x: number, y: number): [number, number, number, number] {
    const gl = this.gl;
    bindTarget(gl, target);
    const px = new Uint8Array(4);
    gl.readPixels(Math.floor(x) + PAD, target.height - 1 - (Math.floor(y) + PAD), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const a = px[3];
    const straight = (c: number) => (a ? Math.min(255, Math.round((c * 255) / a)) : 0);
    return [straight(px[0]), straight(px[1]), straight(px[2]), a];
  }

  /** Draws a rendered comp onto the canvas, scaled to fit, over the given background. */
  /**
   * Draws a rendered comp 1:1 into the canvas, resized to `width` x `height` (the
   * top-left of the image; extra rows and columns are cropped), over an opaque
   * background: the frame an encoder can take straight from the GPU.
   */
  presentFrame(target: Target, width: number, height: number, background: readonly number[]): void {
    const gl = this.gl;
    const canvas = gl.canvas;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    bindTarget(gl, null, width, height);
    gl.clearColor(background[0] ?? 0, background[1] ?? 0, background[2] ?? 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.drawLayerQuad(target, target.width, target.height, [0, 0], Mat4.translation(-PAD, -PAD, 0), null, width, height);
    gl.disable(gl.BLEND);
  }

  present(target: Target, comp: CompItem, background: [number, number, number, number] = [0, 0, 0, 0]): void {
    const gl = this.gl;
    const canvas = gl.canvas;
    bindTarget(gl, null, canvas.width, canvas.height);
    gl.clearColor(...background);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const scale = Math.min(canvas.width / comp.width, canvas.height / comp.height);
    const toView = Mat4.translation((canvas.width - comp.width * scale) / 2, (canvas.height - comp.height * scale) / 2, 0)
      .mul(Mat4.scale(scale, scale, 1))
      .mul(Mat4.translation(-PAD, -PAD, 0));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.drawLayerQuad(target, target.width, target.height, [0, 0], toView, null, canvas.width, canvas.height);
    gl.disable(gl.BLEND);
  }

  private uniform(program: WebGLProgram, name: string): WebGLUniformLocation | null {
    let map = this.uniforms.get(program);
    if (!map) this.uniforms.set(program, (map = new Map()));
    if (!map.has(name)) map.set(name, this.gl.getUniformLocation(program, name));
    return map.get(name)!;
  }

  private draw(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private bindTexture(unit: number, texture: WebGLTexture | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
  }

  private timed<T>(key: string, run: () => T): T {
    const profile = this.profile;
    if (!profile) return run();
    finishGpu(this.gl);
    const started = performance.now();
    this.profileStack.push(0);
    try {
      return run();
    } finally {
      finishGpu(this.gl);
      const elapsed = performance.now() - started;
      const children = this.profileStack.pop()!;
      if (this.profileStack.length) this.profileStack[this.profileStack.length - 1] += elapsed;
      const entry = profile.get(key) ?? { ms: 0, count: 0 };
      entry.ms += elapsed - children;
      entry.count++;
      profile.set(key, entry);
    }
  }

  private contentKind(layer: Layer): string {
    if (layer.layerType !== "AVLayer") return layer.layerType;
    const source = this.project.items.get(layer.sourceId);
    if (source?.kind === "comp") return "precomp";
    if (source?.kind === "footage") return source.mainSource.sourceType === "SolidSource" ? "solid" : "footage";
    return "other";
  }

  /**
   * The comp at `time` in a target of its size times `requested` (plus the border). A comp whose adjustment layers
   * run an effect that cannot render at a reduced resolution renders at full resolution and is then reduced.
   */
  private renderComp(comp: CompItem, time: number, depth: number, requested: number): Target {
    const scale = requested < 1 && !this.compScales(comp) ? 1 : requested;
    const width = scaledSize(comp.width, scale) + 2 * PAD;
    const height = scaledSize(comp.height, scale) + 2 * PAD;
    let accumulated = this.pool.acquire(width, height);
    if (depth > MAX_DEPTH) {
      this.warnings.add(`compositions nested deeper than ${MAX_DEPTH} levels were not rendered`);
      return accumulated;
    }
    const anySolo = comp.layers.some((l) => l.solo && this.isRenderable(l));
    const camera = comp.layers.some((l) => l.threeDLayer) ? cameraAt(comp, time) : undefined;
    const drawOrder = this.drawOrder(comp, time, camera, anySolo);

    // The bottom layers draw what they drew last frame: the composite of them is kept and drawn on from.
    const parts = this.reuseLayers && !camera ? this.keys.parts(comp, time) : null;
    const last = this.prefixes.get(comp);
    const prefixKey = (n: number) => `${depth}#${scale}#${parts!.slice(0, n).join(";")}`;
    let first = 0;
    let held = 0;
    const outerWarnings = new Set(this.warnings);
    const outerComplete = this.complete;
    this.complete = true;
    let heldWarnings: string[] = [];
    if (parts && last && last.held > 0 && last.held <= parts.length) {
      const hit = this.images.get(comp, prefixKey(last.held));
      if (hit) {
        this.reuseStats.hits++;
        this.blit(hit.image.target, accumulated);
        for (const warning of hit.warnings) this.warnings.add(warning);
        heldWarnings = hit.warnings;
        first = held = last.held;
      }
    }
    let stable = 0;
    if (parts && last) while (stable < parts.length && parts[stable] !== null && parts[stable] === last.parts[stable]) stable++;

    for (let i = first; i < drawOrder.length; i++) {
      const layer = drawOrder[i];
      if (i > first && i === stable && this.holdPrefix(comp, prefixKey(stable), accumulated, heldWarnings, outerWarnings)) held = stable;
      let coverage: Target | null = null;
      let placed: Target | null;
      if (layer.adjustmentLayer) {
        const adjusted = this.placeAdjustment(layer, comp, time, camera, depth, scale, accumulated);
        placed = adjusted?.image ?? null;
        coverage = adjusted?.coverage ?? null;
      } else placed = this.placeLayer(layer, comp, time, camera, depth, scale);
      if (!placed) continue;
      let matte: Target | null = null;
      let matteMode: number = MatteMode.NONE;
      let matteOpacity = 1;
      if (layer.trackMatteType !== NO_MATTE) {
        const matteLayer = this.matteLayerOf(layer, comp);
        matteMode = MATTE_MODES[layer.trackMatteType] ?? MatteMode.NONE;
        matte = matteLayer ? this.placeLayer(matteLayer, comp, time, camera, depth, scale, true) : null;
        if (matteLayer && matte) matteOpacity = localTransform(matteLayer, time).opacity / 100;
        if (!matte) matte = this.pool.acquire(width, height);
      }
      const opacity = localTransform(layer, time).opacity / 100;
      const next = this.pool.acquire(width, height, false);
      this.timed("composite", () =>
        this.composite(accumulated, placed, { target: matte, mode: matteMode, opacity: matteOpacity }, layer.blendingMode, opacity, next, coverage),
      );
      if (placed !== accumulated) this.pool.release(placed);
      this.pool.release(accumulated);
      if (matte) this.pool.release(matte);
      if (coverage) this.pool.release(coverage);
      accumulated = next;
    }
    // Every layer draws as it did last frame: the whole composite is kept.
    if (drawOrder.length > first && stable === drawOrder.length && this.holdPrefix(comp, prefixKey(stable), accumulated, heldWarnings, outerWarnings)) {
      held = stable;
    }
    if (parts) this.prefixes.set(comp, { parts, held });
    this.complete = outerComplete && this.complete;
    if (scale === requested) return accumulated;
    const reduced = this.reduce({ target: accumulated, width: comp.width, height: comp.height, origin: [0, 0] }, requested);
    this.pool.release(accumulated);
    return reduced.target;
  }

  /** Copies all of `source` into `out`, a target of the same size. */
  private blit(source: Target, out: Target): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, out.framebuffer);
    gl.blitFramebuffer(0, 0, source.width, source.height, 0, 0, out.width, out.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
  }

  /**
   * Keeps a copy of a comp's composite of its bottom layers under `key`, with what they warned about (`earlier`, from
   * a kept composite drawn on, and what was added to the frame's warnings since `before`); not when footage they
   * need was still loading. True when kept.
   */
  private holdPrefix(comp: CompItem, key: string, accumulated: Target, earlier: string[], before: Set<string>): boolean {
    if (!this.complete) return false;
    const copy = this.pool.acquire(accumulated.width, accumulated.height, false);
    this.blit(accumulated, copy);
    const warnings = [...new Set([...earlier, ...[...this.warnings].filter((w) => !before.has(w))])];
    const image = { target: copy, width: accumulated.width - 2 * PAD, height: accumulated.height - 2 * PAD, origin: [0, 0] as [number, number] };
    if (this.images.set(comp, key, { image, warnings }, copy.width * copy.height * 4)) return true;
    this.pool.release(copy);
    return false;
  }

  /** Whether a layer's effects all render at a reduced resolution (see EffectOptions.scalable). */
  private layerScales(layer: Layer): boolean {
    let scales = this.scalable.get(layer);
    if (scales === undefined) {
      const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
      scales = !layer.effectsActive || !parade || parade.children.every((e) => e.kind !== "group" || !e.enabled || effectIsScalable(e.matchName));
      this.scalable.set(layer, scales);
    }
    return scales;
  }

  /** Whether a comp renders at a reduced resolution: its adjustment layers' effects (run on what is below them) all can. */
  private compScales(comp: CompItem): boolean {
    let scales = this.scalable.get(comp);
    if (scales === undefined) {
      scales = comp.layers.every((l) => !l.adjustmentLayer || this.layerScales(l));
      this.scalable.set(comp, scales);
    }
    return scales;
  }

  /**
   * A full-resolution image reduced to `scale`: each new pixel the average over its footprint, on a grid aligned to
   * the layer origin (so origins stay whole image pixels). Releases nothing.
   */
  private reduce(image: LayerImage, scale: number): LayerImage {
    const x0 = Math.floor(image.origin[0] * scale + 1e-6);
    const y0 = Math.floor(image.origin[1] * scale + 1e-6);
    const width = Math.max(1, Math.ceil((image.origin[0] + image.width) * scale - 1e-6) - x0);
    const height = Math.max(1, Math.ceil((image.origin[1] + image.height) * scale - 1e-6) - y0);
    const out = this.pool.acquire(width + 2 * PAD, height + 2 * PAD, false);
    const gl = this.gl;
    gl.disable(gl.BLEND);
    const p = this.programs.reduce;
    gl.useProgram(p);
    gl.uniform1i(this.uniform(p, "u_source"), 0);
    gl.uniform2f(this.uniform(p, "u_sourceSize"), image.target.width, image.target.height);
    gl.uniform2f(this.uniform(p, "u_sourceOrigin"), image.origin[0], image.origin[1]);
    gl.uniform2f(this.uniform(p, "u_origin"), x0, y0);
    gl.uniform2f(this.uniform(p, "u_size"), width, height);
    gl.uniform1f(this.uniform(p, "u_pad"), PAD);
    gl.uniform1f(this.uniform(p, "u_scale"), scale);
    gl.uniform1i(this.uniform(p, "u_taps"), Math.min(8, Math.ceil(1 / scale - 1e-6)));
    this.bindTexture(0, image.target.texture);
    this.draw();
    return { target: out, width, height, origin: [x0, y0], scale };
  }

  private isRenderable(layer: Layer): boolean {
    return layer.layerType === "AVLayer" || layer.layerType === "ShapeLayer" || layer.layerType === "TextLayer";
  }

  private isActive(layer: Layer, time: number): boolean {
    // A time-reversed layer (negative stretch) has its in point after its out point.
    return time >= Math.min(layer.inPoint, layer.outPoint) && time < Math.max(layer.inPoint, layer.outPoint);
  }

  private matteLayerOf(layer: Layer, comp: CompItem): Layer | undefined {
    if (layer.trackMatteLayerId) return comp.layers.find((l) => l.id === layer.trackMatteLayerId);
    return comp.layers[layer.index - 2];
  }

  /** Layers to composite, bottom first; runs of adjacent 3D layers are sorted back to front. */
  private drawOrder(comp: CompItem, time: number, camera: Camera | undefined, anySolo: boolean): Layer[] {
    const candidates = [...comp.layers]
      .reverse()
      .filter(
        (l) =>
          this.isRenderable(l) &&
          l.enabled &&
          (!anySolo || l.solo) &&
          !l.nullLayer &&
          !l.guideLayer &&
          this.isActive(l, time),
      );
    if (!camera) return candidates;
    const viewInverse = camera.rotation.inverse();
    const depthOf = (layer: Layer) => {
      const t = localTransform(layer, time);
      const world = worldMatrix(layer, comp, time).transformPoint(t.anchor);
      return viewInverse.transformVector([world[0] - camera.position[0], world[1] - camera.position[1], world[2] - camera.position[2]])[2];
    };
    const result: Layer[] = [];
    let run: { layer: Layer; depth: number }[] = [];
    const flush = () => {
      // Back to front; ties keep stack order (lower layers first).
      run.sort((a, b) => b.depth - a.depth);
      result.push(...run.map((r) => r.layer));
      run = [];
    };
    for (const layer of candidates) {
      if (layer.threeDLayer) run.push({ layer, depth: depthOf(layer) });
      else {
        flush();
        result.push(layer);
      }
    }
    flush();
    return result;
  }

  /** The layer's image transformed into comp space (comp-sized target), or null if it draws nothing. */
  private placeLayer(layer: Layer, comp: CompItem, time: number, camera: Camera | undefined, depth: number, scale: number, asMatte = false): Target | null {
    // A matte is used even when its own video is switched off, but only while it is in its time span.
    if (asMatte && !this.isActive(layer, time)) return null;
    const image = this.layerImage(layer, time, depth, true, this.layerScales(layer) ? scale : 1);
    return image && this.placeImage(layer, comp, time, camera, scale, image.image, image.owned);
  }

  /**
   * The layer's image in its own space at `scale`: its content after its masks and, with `effects`, its effects.
   * Reused from an earlier frame while its key (layerKeys.ts) stays the same; `owned` is false for an image the
   * cache keeps, which the caller must not release.
   */
  private layerImage(layer: Layer, time: number, depth: number, effects: boolean, scale: number): { image: LayerImage; owned: boolean } | null {
    const cache = effects ? this.images : this.coverages;
    const imageKey = this.reuseLayers ? this.keys.image(layer, time, effects) : null;
    // Comps nested deeper than MAX_DEPTH render empty, so the same layer differs by how deep it is drawn.
    const key = imageKey === null ? null : `${depth}#${scale}#${imageKey}`;
    if (key !== null) {
      const cached = cache.get(layer, key);
      if (cached) {
        this.reuseStats.hits++;
        for (const warning of cached.warnings) this.warnings.add(warning);
        return { image: cached.image, owned: false };
      }
      this.reuseStats.misses++;
    }
    // What this layer warns about and whether its footage is all there, apart from the rest of the frame.
    const outerWarnings = this.warnings;
    const outerComplete = this.complete;
    const warnings = (this.warnings = new Set<string>());
    this.complete = true;
    let image: LayerImage | null;
    let complete: boolean;
    try {
      const content = this.timed(`content: ${this.contentKind(layer)}`, () => this.layerContent(layer, time, depth, scale));
      image = content && this.timed("masks", () => this.applyMasks(layer, time, content));
      if (image && effects) image = this.applyEffects(layer, time, image, depth);
    } finally {
      complete = this.complete;
      for (const warning of warnings) outerWarnings.add(warning);
      this.warnings = outerWarnings;
      this.complete = outerComplete && complete;
    }
    if (!image) return null;
    if (key !== null && complete && cache.set(layer, key, { image, warnings: [...warnings] }, image.target.width * image.target.height * 4)) {
      return { image, owned: false };
    }
    return { image, owned: true };
  }

  /** The layer's matrix from its own pixels to the comp target's (2D layers, comp at `scale`), with the source's pixel aspect. */
  private layerToTarget(layer: Layer, comp: CompItem, time: number, scale: number): Mat4 {
    let world = worldMatrix(layer, comp, time);
    const aspect = sourcePixelAspect(layer, comp, this.project);
    if (aspect !== 1) {
      // Non-square source pixels stretch the layer horizontally about its anchor point.
      const [ax, ay] = localTransform(layer, time).anchor;
      world = world.mul(Mat4.translation(ax, ay, 0).mul(Mat4.scale(aspect, 1, 1)).mul(Mat4.translation(-ax, -ay, 0)));
    }
    const toTarget = scale === 1 ? Mat4.translation(PAD, PAD, 0) : Mat4.translation(PAD, PAD, 0).mul(Mat4.scale(scale, scale, 1));
    return toTarget.mul(world);
  }

  /**
   * Draws a layer-space image through the layer's transform into a new comp-sized target (comp at `scale`);
   * releases an `owned` image.
   */
  private placeImage(layer: Layer, comp: CompItem, time: number, camera: Camera | undefined, scale: number, image: LayerImage, owned = true): Target {
    const width = scaledSize(comp.width, scale) + 2 * PAD;
    const height = scaledSize(comp.height, scale) + 2 * PAD;
    const out = this.pool.acquire(width, height);
    let toView: Mat4;
    let perspective: { zoom: number } | null = null;
    if (layer.threeDLayer && camera) {
      // World -> camera space: R^T (p - eye).
      const view = camera.rotation.inverse().mul(Mat4.translation(-camera.position[0], -camera.position[1], -camera.position[2]));
      toView = view.mul(worldMatrix(layer, comp, time));
      perspective = { zoom: camera.zoom * scale };
    } else {
      toView = this.layerToTarget(layer, comp, time, scale);
    }
    this.gl.disable(this.gl.BLEND);
    // The image's pixels in layer pixels (a reduced image covers 1/scale layer pixels per pixel).
    const k = image.scale ?? 1;
    const origin: [number, number] = [(image.origin[0] - PAD) / k, (image.origin[1] - PAD) / k];
    this.timed("place", () =>
      this.drawLayerQuad(image.target, (image.width + 2 * PAD) / k, (image.height + 2 * PAD) / k, origin, toView, perspective, width, height),
    );
    if (owned) this.pool.release(image.target);
    return out;
  }

  /**
   * An adjustment layer: its effects run on the composite below, in comp pixels (at the comp's `scale`); its
   * transform, source alpha and masks only say where the result shows (`coverage`). Without effects `image` is
   * `below` itself.
   */
  private placeAdjustment(
    layer: Layer,
    comp: CompItem,
    time: number,
    camera: Camera | undefined,
    depth: number,
    scale: number,
    below: Target,
  ): { image: Target; coverage: Target } | null {
    const masked = this.layerImage(layer, time, depth, false, scale);
    if (!masked) return null;
    const coverage = this.placeImage(layer, comp, time, camera, scale, masked.image, masked.owned);
    const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
    if (!layer.effectsActive || !parade?.children.some((e) => e.kind === "group" && e.enabled)) return { image: below, coverage };
    const local = this.copyImage({ target: below, width: below.width - 2 * PAD, height: below.height - 2 * PAD, origin: [0, 0], scale });
    const effected = this.applyEffects(layer, time, local, depth);
    const out = this.pool.acquire(below.width, below.height);
    this.gl.disable(this.gl.BLEND);
    const origin: [number, number] = [effected.origin[0] - PAD, effected.origin[1] - PAD];
    this.timed("place", () =>
      this.drawLayerQuad(effected.target, effected.width + 2 * PAD, effected.height + 2 * PAD, origin, Mat4.translation(PAD, PAD, 0), null, below.width, below.height),
    );
    this.pool.release(effected.target);
    return { image: out, coverage };
  }

  private drawLayerQuad(
    source: Target,
    quadWidth: number,
    quadHeight: number,
    origin: [number, number],
    toView: Mat4,
    perspective: { zoom: number } | null,
    viewWidth: number,
    viewHeight: number,
  ): void {
    const gl = this.gl;
    const p = this.programs.layer;
    gl.useProgram(p);
    gl.uniform2f(this.uniform(p, "u_layerSize"), quadWidth, quadHeight);
    gl.uniform2f(this.uniform(p, "u_origin"), origin[0], origin[1]);
    // Uniform matrices are column-major; ours are row-major.
    const m = toView.m;
    gl.uniformMatrix4fv(this.uniform(p, "u_toView"), false, [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]]);
    gl.uniform1i(this.uniform(p, "u_perspective"), perspective ? 1 : 0);
    gl.uniform1f(this.uniform(p, "u_zoom"), perspective?.zoom ?? 1);
    gl.uniform2f(this.uniform(p, "u_compSize"), viewWidth, viewHeight);
    gl.uniform1i(this.uniform(p, "u_source"), 0);
    this.bindTexture(0, source.texture);
    this.draw();
  }

  private context(depth: number, scale = 1): RenderContext {
    const gl = this.gl;
    return {
      gl,
      options: this.options,
      pool: this.pool,
      pad: PAD,
      scale,
      project: this.project,
      warn: (message) => this.warnings.add(message),
      loading: (message) => {
        this.warnings.add(message);
        this.complete = false;
      },
      upload: (source, width, height, origin = [0, 0]) => this.upload(source, width, height, origin),
      renderComp: (comp, time) => this.renderComp(comp, time, depth + 1, 1),
      layerImage: (layer, time, withMasksAndEffects) => {
        if (this.layersInProgress.has(layer)) return null;
        this.layersInProgress.add(layer);
        try {
          const content = this.layerContent(layer, time, depth, 1);
          if (!content || !withMasksAndEffects) return content;
          return this.applyEffects(layer, time, this.applyMasks(layer, time, content), depth);
        } finally {
          this.layersInProgress.delete(layer);
        }
      },
      program: (fragment) => {
        let program = this.passPrograms.get(fragment);
        if (!program) this.passPrograms.set(fragment, (program = compile(gl, FULLSCREEN_VS, fragment)));
        return program;
      },
      pass: (program, out, inputs, setUniforms) => {
        bindTarget(gl, out);
        gl.disable(gl.BLEND);
        gl.useProgram(program);
        inputs.forEach((input, unit) => this.bindTexture(unit, input.texture));
        setUniforms?.((name) => this.uniform(program, name));
        this.draw();
      },
    };
  }

  /**
   * The layer's source at `scale` (see LayerImage.scale): solids, nested comps and providers that can drawn at it,
   * the rest reduced to it.
   */
  private layerContent(layer: Layer, time: number, depth: number, scale: number): LayerImage | null {
    const reduced = (image: LayerImage | null) => {
      if (!image || (image.scale ?? 1) === scale) return image;
      const out = this.reduce(image, scale);
      this.pool.release(image.target);
      return out;
    };
    const source = layer.sourceId ? this.project.items.get(layer.sourceId) : undefined;
    const providers = contentProviders();
    if (providers.length) {
      const ctx = this.context(depth, scale);
      for (const provider of providers) {
        const image = provider(layer, time, ctx);
        if (image !== undefined) return reduced(image);
      }
    }
    if (layer.layerType === "ShapeLayer") return reduced(this.shapeContent(layer, time));
    if (layer.layerType !== "AVLayer") {
      this.warnings.add(`text layers are not rendered yet ("${layer.name}")`);
      return null;
    }
    if (source?.kind === "footage" && source.mainSource.sourceType === "SolidSource") {
      const width = scaledSize(source.width, scale);
      const height = scaledSize(source.height, scale);
      const target = this.pool.acquire(width + 2 * PAD, height + 2 * PAD);
      const [r, g, b] = source.mainSource.color;
      const gl = this.gl;
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(PAD, PAD, width, height);
      gl.clearColor(r, g, b, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.SCISSOR_TEST);
      return scale === 1 ? { target, width, height, origin: [0, 0] } : { target, width, height, origin: [0, 0], scale };
    }
    if (source?.kind === "comp") {
      let sourceTime = layerTimeAt(layer, time);
      if (layer.timeRemapEnabled) {
        const remap = findProperty(layer.properties, ["ADBE Time Remapping"]);
        const value = remap ? currentValue(remap, time, layer) : null;
        if (typeof value === "number") sourceTime = value;
      }
      const target = this.renderComp(source, sourceTime, depth + 1, scale);
      const [width, height] = [scaledSize(source.width, scale), scaledSize(source.height, scale)];
      return scale === 1 ? { target, width, height, origin: [0, 0] } : { target, width, height, origin: [0, 0], scale };
    }
    if (source?.kind === "footage") {
      this.warnings.add(`footage is not loaded yet ("${source.name}")`);
      return null;
    }
    return null;
  }

  /** A copy of `image` in a pooled target the caller may release. */
  private copyImage(image: LayerImage): LayerImage {
    const gl = this.gl;
    const { width, height } = image.target;
    const out = this.pool.acquire(width, height, false);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, image.target.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, out.framebuffer);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.framebuffer);
    return { ...image, target: out };
  }

  private shapeContent(layer: Layer, time: number): LayerImage | null {
    const key = valuesKey(
      layer.properties.filter((n) => n.matchName === "ADBE Root Vectors Group"),
      time,
      layer,
    );
    if (key !== null) {
      const cached = this.shapeCache.get(layer, key);
      if (cached !== undefined) return cached && this.copyImage(cached);
    }
    const image = this.rasterizeShapes(layer, time);
    if (key !== null) this.shapeCache.offer(layer, key, () => image && this.copyImage(image));
    return image;
  }

  private rasterizeShapes(layer: Layer, time: number): LayerImage | null {
    const raster = rasterizeShapeLayer(layer, time, PAD);
    if (!raster) return null;
    const gl = this.gl;
    const target = this.pool.acquire(raster.width + 2 * PAD, raster.height + 2 * PAD);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, raster.canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    return { target, width: raster.width, height: raster.height, origin: raster.origin };
  }

  /** Straight-alpha pixels (top row first) into a padded premultiplied image. */
  private upload(source: TexImageSource, width: number, height: number, origin: [number, number]): LayerImage {
    const gl = this.gl;
    const target = this.pool.acquire(width + 2 * PAD, height + 2 * PAD);
    gl.bindTexture(gl.TEXTURE_2D, target.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, PAD, PAD, width, height, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    return { target, width, height, origin };
  }

  /** Runs the layer's enabled effects in stack order (after masks, before the transform). */
  private applyEffects(layer: Layer, time: number, image: LayerImage, depth: number): LayerImage {
    if (!layer.effectsActive) return image;
    const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
    if (!parade) return image;
    let ctx: RenderContext | undefined;
    this.layersInProgress.add(layer);
    try {
      for (const effect of parade.children) {
        if (effect.kind !== "group" || !effect.enabled) continue;
        const render = effectRenderer(effect.matchName);
        if (!render) {
          this.warnings.add(`effect "${effect.effectName ?? effect.name}" (${effect.matchName}) is not rendered yet`);
          continue;
        }
        const input = image;
        image = this.timed(`effect: ${effect.effectName ?? effect.matchName}`, () => render(input, effect, layer, time, (ctx ??= this.context(depth))));
        // Effects keep the resolution they are handed.
        if (input.scale !== undefined && input.scale !== 1) image = { ...image, scale: input.scale };
      }
    } finally {
      this.layersInProgress.delete(layer);
    }
    return image;
  }

  private applyMasks(layer: Layer, time: number, content: LayerImage): LayerImage {
    const coverage = this.masks.coverage(layer, time, content.width, content.height, PAD, content.origin, content.scale ?? 1);
    if (!coverage) return content;
    const gl = this.gl;
    const w = content.width + 2 * PAD;
    const h = content.height + 2 * PAD;
    const out = this.pool.acquire(w, h, false);
    gl.disable(gl.BLEND);
    const p = this.programs.mask;
    gl.useProgram(p);
    gl.uniform1i(this.uniform(p, "u_source"), 0);
    gl.uniform1i(this.uniform(p, "u_mask"), 1);
    this.bindTexture(0, content.target.texture);
    this.bindTexture(1, coverage);
    this.draw();
    this.pool.release(content.target);
    return { ...content, target: out };
  }

  private composite(
    backdrop: Target,
    source: Target,
    matte: { target: Target | null; mode: number; opacity: number },
    mode: number,
    opacity: number,
    out: Target,
    coverage: Target | null = null,
  ): void {
    const gl = this.gl;
    bindTarget(gl, out);
    gl.disable(gl.BLEND);
    const p = this.programs.composite;
    gl.useProgram(p);
    gl.uniform1i(this.uniform(p, "u_backdrop"), 0);
    gl.uniform1i(this.uniform(p, "u_source"), 1);
    gl.uniform1i(this.uniform(p, "u_matte"), 2);
    gl.uniform1i(this.uniform(p, "u_matteMode"), matte.target ? matte.mode : MatteMode.NONE);
    gl.uniform1f(this.uniform(p, "u_matteOpacity"), matte.opacity);
    gl.uniform1i(this.uniform(p, "u_mode"), mode);
    gl.uniform1f(this.uniform(p, "u_opacity"), opacity);
    gl.uniform1i(this.uniform(p, "u_adjust"), coverage ? 1 : 0);
    gl.uniform1i(this.uniform(p, "u_coverage"), 3);
    this.bindTexture(0, backdrop.texture);
    this.bindTexture(1, source.texture);
    this.bindTexture(2, matte.target ? matte.target.texture : source.texture);
    this.bindTexture(3, (coverage ?? source).texture);
    this.draw();
  }
}
