// WebGL2 compositor for After Effects compositions.
//
// Every image lives in a premultiplied RGBA8 target with a 1px transparent
// border, so bilinear sampling gives transformed layers antialiased edges.
// Target memory follows GL convention (row 0 = bottom of the image).
import { currentValue, layerTimeAt, setExpressionScope } from "../aep/evaluate.ts";
import type { CompItem, Layer, Project, Property, PropertyGroup, PropertyNode } from "../aep/model.ts";
import { cameraAt, localTransform, Mat4, worldMatrix, type Camera } from "../aep/transform.ts";
import { LayerCache, valuesKey } from "./contentCache.ts";
import "./features.ts";
import { sourcePixelAspect } from "./footage.ts";
import { bindTarget, compile, TargetPool, unitQuad, type GL, type Target } from "./gl.ts";
import { MaskRenderer } from "./masks.ts";
import { contentProviders, effectRenderer, type LayerImage, type RenderContext, type RendererOptions } from "./registry.ts";
import { rasterizeShapeLayer } from "./shapes.ts";
import { COMPOSITE_FS, FILL_FS, FULLSCREEN_VS, LAYER_FS, LAYER_VS, MASK_FS, MatteMode } from "./shaders.ts";

const PAD = 1;
const NO_MATTE = 5012;
const MATTE_MODES: Record<number, number> = {
  5013: MatteMode.ALPHA,
  5014: MatteMode.ALPHA_INVERTED,
  5015: MatteMode.LUMA,
  5016: MatteMode.LUMA_INVERTED,
};
const MAX_DEPTH = 16;
const POOL_BYTES = 256 * 1024 * 1024;

export interface RenderOptions {
  /**
   * Resolution of the result relative to the comp (1/2 for Half...). Only the
   * top-level comp is scaled: layer content, nested comps and effects still
   * render at full resolution and are resampled when placed.
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
  readonly options: RendererOptions = { approximateMissingPlugins: false };
  private readonly quad: WebGLVertexArrayObject;
  private readonly programs: Programs;
  private readonly pool: TargetPool;
  private readonly masks: MaskRenderer;
  private readonly uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private project!: Project;
  private warnings = new Set<string>();
  private readonly passPrograms = new Map<string, WebGLProgram>();
  /** When set, each render stage's exclusive time (GPU work included, via gl.finish) accumulates here by name. */
  profile: Map<string, { ms: number; count: number }> | null = null;
  private readonly profileStack: number[] = [];
  private readonly layersInProgress = new Set<Layer>();
  private scale = 1;
  private readonly shapeCache: LayerCache<LayerImage | null>;
  private cachedProject?: Project;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl as GL;
    this.quad = unitQuad(this.gl);
    this.pool = new TargetPool(this.gl);
    this.programs = {
      layer: compile(this.gl, LAYER_VS, LAYER_FS),
      mask: compile(this.gl, FULLSCREEN_VS, MASK_FS),
      fill: compile(this.gl, FULLSCREEN_VS, FILL_FS),
      composite: compile(this.gl, FULLSCREEN_VS, COMPOSITE_FS),
    };
    this.masks = new MaskRenderer(this.gl, () => this.draw());
    this.shapeCache = new LayerCache((image) => image && this.pool.release(image.target));
  }

  /** Drops cached layer content; needed only when the project changes in ways its values do not show. */
  clearCaches(): void {
    this.shapeCache.clear();
  }

  /** Things the renderer skipped or approximated in the last frame (unsupported layer kinds, missing footage...). */
  get lastWarnings(): string[] {
    return [...this.warnings];
  }

  /** Renders `comp` at composition time `time`; the returned target is owned by the caller (see `release`). */
  render(project: Project, comp: CompItem, time: number, options: RenderOptions = {}): Target {
    if (project !== this.cachedProject) {
      this.clearCaches();
      this.cachedProject = project;
    }
    this.project = project;
    const warnings = (this.warnings = new Set());
    setExpressionScope({ project, warn: (message) => warnings.add(message) });
    this.scale = options.scale ?? 1;
    const result = this.renderComp(comp, time, 0);
    this.pool.trim(Math.max(POOL_BYTES, 8 * result.width * result.height * 4));
    return result;
  }

  release(target: Target): void {
    this.pool.release(target);
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
    this.gl.finish();
    const started = performance.now();
    this.profileStack.push(0);
    try {
      return run();
    } finally {
      this.gl.finish();
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

  private renderComp(comp: CompItem, time: number, depth: number): Target {
    const scale = depth === 0 ? this.scale : 1;
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

    for (const layer of drawOrder) {
      const placed = this.placeLayer(layer, comp, time, camera, depth);
      if (!placed) continue;
      let matte: Target | null = null;
      let matteMode: number = MatteMode.NONE;
      let matteOpacity = 1;
      if (layer.trackMatteType !== NO_MATTE) {
        const matteLayer = this.matteLayerOf(layer, comp);
        matteMode = MATTE_MODES[layer.trackMatteType] ?? MatteMode.NONE;
        matte = matteLayer ? this.placeLayer(matteLayer, comp, time, camera, depth, true) : null;
        if (matteLayer && matte) matteOpacity = localTransform(matteLayer, time).opacity / 100;
        if (!matte) matte = this.pool.acquire(width, height);
      }
      const opacity = localTransform(layer, time).opacity / 100;
      const next = this.pool.acquire(width, height);
      this.timed("composite", () =>
        this.composite(accumulated, placed, { target: matte, mode: matteMode, opacity: matteOpacity }, layer.blendingMode, opacity, next),
      );
      this.pool.release(accumulated);
      this.pool.release(placed);
      if (matte) this.pool.release(matte);
      accumulated = next;
    }
    return accumulated;
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
          !l.adjustmentLayer &&
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
  private placeLayer(layer: Layer, comp: CompItem, time: number, camera: Camera | undefined, depth: number, asMatte = false): Target | null {
    // A matte is used even when its own video is switched off, but only while it is in its time span.
    if (asMatte && !this.isActive(layer, time)) return null;
    const content = this.timed(`content: ${this.contentKind(layer)}`, () => this.layerContent(layer, time, depth));
    if (!content) return null;
    const masked = this.applyEffects(layer, time, this.timed("masks", () => this.applyMasks(layer, time, content)), depth);
    const scale = depth === 0 ? this.scale : 1;
    const width = scaledSize(comp.width, scale) + 2 * PAD;
    const height = scaledSize(comp.height, scale) + 2 * PAD;
    const out = this.pool.acquire(width, height);
    let world = worldMatrix(layer, comp, time);
    const aspect = sourcePixelAspect(layer, comp, this.project);
    if (aspect !== 1) {
      // Non-square source pixels stretch the layer horizontally about its anchor point.
      const [ax, ay] = localTransform(layer, time).anchor;
      world = world.mul(Mat4.translation(ax, ay, 0).mul(Mat4.scale(aspect, 1, 1)).mul(Mat4.translation(-ax, -ay, 0)));
    }
    const toTarget = scale === 1 ? Mat4.translation(PAD, PAD, 0) : Mat4.translation(PAD, PAD, 0).mul(Mat4.scale(scale, scale, 1));
    let toView: Mat4;
    let perspective: { zoom: number } | null = null;
    if (layer.threeDLayer && camera) {
      // World -> camera space: R^T (p - eye).
      const view = camera.rotation.inverse().mul(Mat4.translation(-camera.position[0], -camera.position[1], -camera.position[2]));
      toView = view.mul(world);
      perspective = { zoom: camera.zoom * scale };
    } else {
      toView = toTarget.mul(world);
    }
    this.gl.disable(this.gl.BLEND);
    const origin: [number, number] = [masked.origin[0] - PAD, masked.origin[1] - PAD];
    this.timed("place", () => this.drawLayerQuad(masked.target, masked.width + 2 * PAD, masked.height + 2 * PAD, origin, toView, perspective, width, height));
    this.pool.release(masked.target);
    return out;
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

  private context(depth: number): RenderContext {
    const gl = this.gl;
    return {
      gl,
      options: this.options,
      pool: this.pool,
      pad: PAD,
      project: this.project,
      warn: (message) => this.warnings.add(message),
      upload: (source, width, height, origin = [0, 0]) => this.upload(source, width, height, origin),
      renderComp: (comp, time) => this.renderComp(comp, time, depth + 1),
      layerImage: (layer, time, withMasksAndEffects) => {
        if (this.layersInProgress.has(layer)) return null;
        this.layersInProgress.add(layer);
        try {
          const content = this.layerContent(layer, time, depth);
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

  private layerContent(layer: Layer, time: number, depth: number): LayerImage | null {
    const source = layer.sourceId ? this.project.items.get(layer.sourceId) : undefined;
    const providers = contentProviders();
    if (providers.length) {
      const ctx = this.context(depth);
      for (const provider of providers) {
        const image = provider(layer, time, ctx);
        if (image !== undefined) return image;
      }
    }
    if (layer.layerType === "ShapeLayer") return this.shapeContent(layer, time);
    if (layer.layerType !== "AVLayer") {
      this.warnings.add(`text layers are not rendered yet ("${layer.name}")`);
      return null;
    }
    if (source?.kind === "footage" && source.mainSource.sourceType === "SolidSource") {
      const target = this.pool.acquire(source.width + 2 * PAD, source.height + 2 * PAD);
      const [r, g, b] = source.mainSource.color;
      const gl = this.gl;
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(PAD, PAD, source.width, source.height);
      gl.clearColor(r, g, b, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.SCISSOR_TEST);
      return { target, width: source.width, height: source.height, origin: [0, 0] };
    }
    if (source?.kind === "comp") {
      let sourceTime = layerTimeAt(layer, time);
      if (layer.timeRemapEnabled) {
        const remap = findProperty(layer.properties, ["ADBE Time Remapping"]);
        const value = remap ? currentValue(remap, time, layer) : null;
        if (typeof value === "number") sourceTime = value;
      }
      return { target: this.renderComp(source, sourceTime, depth + 1), width: source.width, height: source.height, origin: [0, 0] };
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
    const out = this.pool.acquire(width, height);
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
      }
    } finally {
      this.layersInProgress.delete(layer);
    }
    return image;
  }

  private applyMasks(layer: Layer, time: number, content: LayerImage): LayerImage {
    const coverage = this.masks.coverage(layer, time, content.width, content.height, PAD, content.origin);
    if (!coverage) return content;
    const gl = this.gl;
    const w = content.width + 2 * PAD;
    const h = content.height + 2 * PAD;
    const out = this.pool.acquire(w, h);
    const p = this.programs.mask;
    gl.useProgram(p);
    gl.uniform1i(this.uniform(p, "u_source"), 0);
    gl.uniform1i(this.uniform(p, "u_mask"), 1);
    this.bindTexture(0, content.target.texture);
    this.bindTexture(1, coverage);
    this.draw();
    this.pool.release(content.target);
    return { target: out, width: content.width, height: content.height, origin: content.origin };
  }

  private composite(
    backdrop: Target,
    source: Target,
    matte: { target: Target | null; mode: number; opacity: number },
    mode: number,
    opacity: number,
    out: Target,
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
    this.bindTexture(0, backdrop.texture);
    this.bindTexture(1, source.texture);
    this.bindTexture(2, matte.target ? matte.target.texture : source.texture);
    this.draw();
  }
}
