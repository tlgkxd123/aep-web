// Finds particles in video frames on the GPU. Particles are additive white light,
// so they raise all three channels above the local background: the "white
// residual" is the smallest channel of frame − opening(frame), where the opening
// (a min filter, then a max filter, per channel) keeps everything wider than the
// particles. Coloured shapes (blue butterflies, pink flowers) raise one or two
// channels only and drop out. Peaks of the smoothed residual are found per 8 × 8
// tile and measured (centroid, light, spread) on the GPU; only one record per
// tile is read back. Tiles on or near bright background (a logo, an audio
// spectrum, flowers) are masked: particles there are unreliable to find, and the
// mask is reported so that renders compared against the video skip the same tiles.
import type { Gpu, Surface } from "./gpu.ts";
import { readFloats, ReadbackQueue } from "./gpu.ts";

const MORPH_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform ivec2 u_offset;
uniform ivec2 u_limit;
uniform ivec2 u_dir;
uniform int u_radius;
uniform int u_max;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) + u_offset;
  vec4 acc = texelFetch(u_src, clamp(p, ivec2(0), u_limit - 1), 0);
  for (int k = 1; k <= 48; k++) {
    if (k > u_radius) break;
    vec4 a = texelFetch(u_src, clamp(p + u_dir * k, ivec2(0), u_limit - 1), 0);
    vec4 b = texelFetch(u_src, clamp(p - u_dir * k, ivec2(0), u_limit - 1), 0);
    acc = u_max == 1 ? max(acc, max(a, b)) : min(acc, min(a, b));
  }
  outColor = acc;
}`;

/**
 * The background is the larger of the opening and, once there is a history, the median of the past frames:
 * static fine texture (petals, lettering) is in the median, moving particles are not.
 * r: white residual, g: largest channel residual, b: the opening's largest channel (bright structures
 * wider than particles; the median would add slow particles), a: 1.
 */
const RESIDUAL_FS = `#version 300 es
precision highp float;
uniform sampler2D u_frame;
uniform sampler2D u_open;
uniform sampler2D u_h[8];
uniform int u_history;
uniform ivec2 u_offset;
out vec4 outColor;
#define SORT(a, b) { vec3 lo = min(v[a], v[b]); v[b] = max(v[a], v[b]); v[a] = lo; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = p + u_offset;
  vec3 f = texelFetch(u_frame, q, 0).rgb;
  vec3 open = texelFetch(u_open, p, 0).rgb;
  vec3 background = open;
  if (u_history == 1) {
    vec3 v[8];
    v[0] = texelFetch(u_h[0], q, 0).rgb; v[1] = texelFetch(u_h[1], q, 0).rgb;
    v[2] = texelFetch(u_h[2], q, 0).rgb; v[3] = texelFetch(u_h[3], q, 0).rgb;
    v[4] = texelFetch(u_h[4], q, 0).rgb; v[5] = texelFetch(u_h[5], q, 0).rgb;
    v[6] = texelFetch(u_h[6], q, 0).rgb; v[7] = texelFetch(u_h[7], q, 0).rgb;
    // Batcher's odd-even merge sort of eight.
    SORT(0, 1) SORT(2, 3) SORT(4, 5) SORT(6, 7)
    SORT(0, 2) SORT(1, 3) SORT(4, 6) SORT(5, 7)
    SORT(1, 2) SORT(5, 6)
    SORT(0, 4) SORT(1, 5) SORT(2, 6) SORT(3, 7)
    SORT(2, 4) SORT(3, 5)
    SORT(1, 2) SORT(3, 4) SORT(5, 6)
    background = max(background, 0.5 * (v[3] + v[4]));
  }
  vec3 r = f - background;
  outColor = vec4(max(0.0, min(r.r, min(r.g, r.b))), max(0.0, max(r.r, max(r.g, r.b))), max(open.r, max(open.g, open.b)), 1.0);
}`;

/** Separable max of the residual's structure brightness (b) into r. */
const NEAR_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform ivec2 u_limit;
uniform ivec2 u_dir;
uniform int u_radius;
uniform int u_channel;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float acc = texelFetch(u_src, p, 0)[u_channel];
  for (int k = 1; k <= 32; k++) {
    if (k > u_radius) break;
    acc = max(acc, max(texelFetch(u_src, clamp(p + u_dir * k, ivec2(0), u_limit - 1), 0)[u_channel],
                       texelFetch(u_src, clamp(p - u_dir * k, ivec2(0), u_limit - 1), 0)[u_channel]));
  }
  outColor = vec4(acc, 0.0, 0.0, 1.0);
}`;

const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
out vec4 outColor;
void main() { outColor = texelFetch(u_src, ivec2(gl_FragCoord.xy), 0); }`;

/** Past frames in the median background, and frames between them. */
export const HISTORY = 8;

const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform ivec2 u_limit;
uniform ivec2 u_dir;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  // Gaussian, sigma 1 px.
  float w[4] = float[4](0.39894, 0.24197, 0.05399, 0.00443);
  float acc = texelFetch(u_src, p, 0).r * w[0];
  for (int k = 1; k < 4; k++) {
    acc += texelFetch(u_src, clamp(p + u_dir * k, ivec2(0), u_limit - 1), 0).r * w[k];
    acc += texelFetch(u_src, clamp(p - u_dir * k, ivec2(0), u_limit - 1), 0).r * w[k];
  }
  outColor = vec4(acc, 0.0, 0.0, 1.0);
}`;

/**
 * One record per tile. A detection has light in out0.z; a tile without one has out0 = 0 and the
 * brightest nearby background in out1.w, so masked tiles (out1.w > u_backMax) can be told apart.
 */
const TILE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_res;
uniform sampler2D u_smooth;
uniform sampler2D u_near;
uniform ivec2 u_size;
uniform vec2 u_origin;
uniform int u_tile;
uniform float u_threshold;
uniform float u_backMax;
uniform int u_window;
layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;
float S(ivec2 p) { return texelFetch(u_smooth, clamp(p, ivec2(0), u_size - 1), 0).r; }
float W(ivec2 p) {
  if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, u_size))) return 0.0;
  return texelFetch(u_res, p, 0).r;
}
float N(ivec2 p) { return texelFetch(u_near, clamp(p, ivec2(0), u_size - 1), 0).r; }
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * u_tile;
  float near = max(max(N(base), N(base + ivec2(u_tile - 1, 0))), max(N(base + ivec2(0, u_tile - 1)), N(base + ivec2(u_tile - 1))));
  if (near > u_backMax) {
    out0 = vec4(0.0);
    out1 = vec4(0.0, 0.0, 0.0, near);
    return;
  }
  float best = u_threshold;
  ivec2 bp = ivec2(-1);
  for (int j = 0; j < 16; j++) {
    if (j >= u_tile) break;
    for (int i = 0; i < 16; i++) {
      if (i >= u_tile) break;
      ivec2 p = base + ivec2(i, j);
      if (p.x >= u_size.x || p.y >= u_size.y) continue;
      float v = S(p);
      if (v <= best) continue;
      bool peak = true;
      for (int dy = -2; dy <= 2; dy++) {
        for (int dx = -2; dx <= 2; dx++) {
          if (dx == 0 && dy == 0) continue;
          float n = S(p + ivec2(dx, dy));
          // Equal neighbours: the first in scan order wins.
          if (n > v || (n == v && (dy < 0 || (dy == 0 && dx < 0)))) peak = false;
        }
      }
      if (peak) {
        best = v;
        bp = p;
      }
    }
  }
  if (bp.x < 0) {
    out0 = vec4(0.0);
    out1 = vec4(0.0, 0.0, 0.0, near);
    return;
  }
  float s = 0.0, sx = 0.0, sy = 0.0, sxx = 0.0, syy = 0.0;
  for (int dy = -12; dy <= 12; dy++) {
    if (abs(dy) > u_window) continue;
    for (int dx = -12; dx <= 12; dx++) {
      if (abs(dx) > u_window) continue;
      float w = W(bp + ivec2(dx, dy));
      s += w;
      sx += w * float(dx);
      sy += w * float(dy);
      sxx += w * float(dx * dx);
      syy += w * float(dy * dy);
    }
  }
  vec2 c = s > 0.0 ? vec2(sx, sy) / s : vec2(0.0);
  float spread = s > 0.0 ? sqrt(max(0.0, 0.5 * (sxx / s - c.x * c.x + syy / s - c.y * c.y))) : 0.0;
  vec4 r = texelFetch(u_res, bp, 0);
  out0 = vec4(vec2(bp) + c + 0.5 + u_origin, s, r.r);
  out1 = vec4(spread, best, r.g, near);
}`;

/** Floats per detection. */
export const DETECTION_FLOATS = 8;
/**
 * Offsets in a detection: position (frame pixels, y down), light (sum of the white residual), peak,
 * spread (px), smoothed peak, largest channel residual, brightest background near the tile.
 */
export const D_X = 0;
export const D_Y = 1;
export const D_FLUX = 2;
export const D_PEAK = 3;
export const D_SPREAD = 4;
export const D_SMOOTH = 5;
export const D_MAXRES = 6;
export const D_BACK = 7;

export interface DetectorOptions {
  /** Analysed part of the frame: x, y, width, height in frame pixels. */
  region: [number, number, number, number];
  /** Opening radius: structures wider than 2 r + 1 px are background. */
  radius: number;
  /** Smallest smoothed white residual a peak needs (0..1). */
  threshold: number;
  /** Tile side in px: at most one particle per tile. */
  tile: number;
  /** Half-width of the measuring window in px. */
  window: number;
  /** Frames between the past frames of the median background; 0 leaves the median out. */
  historyStride: number;
  /** Tiles within `nearRadius` px of background brighter than this (largest channel, 0..1) are masked. */
  backMax: number;
  nearRadius: number;
  /**
   * Edges of the region (left, top, right, bottom) that open sky reaches the analysed part from. Dark
   * tiles enclosed by masked ones (a logo's inside) and not connected to these edges are masked too.
   * An edge on a mirror axis cuts through the logo and is left out.
   */
  openEdges: [boolean, boolean, boolean, boolean];
}

export const DEFAULT_DETECTOR: Omit<DetectorOptions, "region"> = {
  radius: 8,
  threshold: 12 / 255,
  tile: 8,
  window: 5,
  historyStride: 4,
  backMax: 0.45,
  nearRadius: 12,
  openEdges: [true, true, true, true],
};

/** Clears the tiles of `mask` (1 analysed, 0 masked) that no open edge reaches through analysed tiles. */
export function maskEnclosed(mask: Uint8Array, columns: number, rows: number, edges: readonly boolean[]): void {
  const reached = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let head = 0;
  let tail = 0;
  const seed = (i: number) => {
    if (mask[i] && !reached[i]) {
      reached[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let y = 0; y < rows; y++) {
    if (edges[0]) seed(y * columns);
    if (edges[2]) seed(y * columns + columns - 1);
  }
  for (let x = 0; x < columns; x++) {
    if (edges[1]) seed(x);
    if (edges[3]) seed((rows - 1) * columns + x);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % columns;
    if (x > 0) seed(i - 1);
    if (x < columns - 1) seed(i + 1);
    if (i >= columns) seed(i - columns);
    if (i < (rows - 1) * columns) seed(i + columns);
  }
  for (let i = 0; i < mask.length; i++) mask[i] &= reached[i];
}

/** One frame's detections and the tiles that were analysed (1) or masked (0), row-major, rows top first. */
export interface DetectorOutput {
  detections: Float32Array;
  mask: Uint8Array;
}

export class Detector {
  readonly options: DetectorOptions;
  private readonly gpu: Gpu;
  private readonly a: Surface;
  private readonly b: Surface;
  private readonly residual: Surface;
  private readonly blurX: Surface;
  private readonly smooth: Surface;
  private readonly nearX: Surface;
  private readonly near: Surface;
  private readonly tiles: { framebuffer: WebGLFramebuffer; textures: WebGLTexture[]; width: number; height: number };
  private readonly read0: Float32Array;
  private readonly read1: Float32Array;
  private readonly later: ReadbackQueue<number>;
  private history: Surface[] = [];
  private frames = 0;

  constructor(gpu: Gpu, options: DetectorOptions) {
    this.gpu = gpu;
    this.options = options;
    const gl = gpu.gl;
    const [, , w, h] = options.region;
    this.a = gpu.surface(w, h, gl.RGBA8);
    this.b = gpu.surface(w, h, gl.RGBA8);
    this.residual = gpu.surface(w, h, gl.RGBA16F);
    this.blurX = gpu.surface(w, h, gl.R16F);
    this.smooth = gpu.surface(w, h, gl.R16F);
    this.nearX = gpu.surface(w, h, gl.R16F);
    this.near = gpu.surface(w, h, gl.R16F);
    this.tiles = gpu.multi(Math.ceil(w / options.tile), Math.ceil(h / options.tile), gl.RGBA32F, 2);
    this.read0 = new Float32Array(this.tiles.width * this.tiles.height * 4);
    this.read1 = new Float32Array(this.tiles.width * this.tiles.height * 4);
    this.later = new ReadbackQueue<number>(gl);
  }

  /** Tile grid columns and rows (the mask's layout). */
  get grid(): [number, number] {
    return [this.tiles.width, this.tiles.height];
  }

  /** The white residual of the last frame (r), for diagnostics. */
  get residualTexture(): WebGLTexture {
    return this.residual.texture;
  }

  /** The last frame's opening (its background without particles), covering the region. */
  get openingTexture(): WebGLTexture {
    return this.b.texture;
  }

  /** The past frames of the median background (HISTORY of them once warm), whole frames. */
  get historyTextures(): WebGLTexture[] {
    return this.history.map((s) => s.texture);
  }

  /** Whether the median background has all its past frames (detections before then are unreliable). */
  get warm(): boolean {
    return !this.options.historyStride || this.history.length === HISTORY;
  }

  /** Frames to run before the first reliable detection. */
  get warmup(): number {
    return this.options.historyStride * HISTORY;
  }

  /** Forgets the past frames (after a jump in the video). */
  reset(): void {
    for (const s of this.history) this.gpu.release(s);
    this.history = [];
    this.frames = 0;
  }

  /** Runs the GPU passes on a frame texture (rows top first) without reading anything back. */
  process(frame: WebGLTexture, frameWidth: number, frameHeight: number): void {
    const { gpu } = this;
    const gl = gpu.gl;
    const [x0, y0, w, h] = this.options.region;
    const stride = this.options.historyStride;
    const morph = gpu.program(MORPH_FS);
    const step = (src: WebGLTexture, out: Surface, offset: [number, number], limit: [number, number], dir: [number, number], max: boolean) =>
      gpu.pass(morph, out, [src], (u) => {
        gl.uniform1i(u("u_src"), 0);
        gl.uniform2i(u("u_offset"), offset[0], offset[1]);
        gl.uniform2i(u("u_limit"), limit[0], limit[1]);
        gl.uniform2i(u("u_dir"), dir[0], dir[1]);
        gl.uniform1i(u("u_radius"), this.options.radius);
        gl.uniform1i(u("u_max"), max ? 1 : 0);
      });
    step(frame, this.a, [x0, y0], [frameWidth, frameHeight], [1, 0], false);
    step(this.a.texture, this.b, [0, 0], [w, h], [0, 1], false);
    step(this.b.texture, this.a, [0, 0], [w, h], [1, 0], true);
    step(this.a.texture, this.b, [0, 0], [w, h], [0, 1], true);
    const full = stride > 0 && this.history.length === HISTORY;
    const past = full ? this.history.map((s) => s.texture) : Array.from({ length: HISTORY }, () => this.b.texture);
    gpu.pass(gpu.program(RESIDUAL_FS), this.residual, [frame, this.b.texture, ...past], (u) => {
      gl.uniform1i(u("u_frame"), 0);
      gl.uniform1i(u("u_open"), 1);
      gl.uniform1iv(u("u_h[0]"), Array.from({ length: HISTORY }, (_, i) => 2 + i));
      gl.uniform1i(u("u_history"), full ? 1 : 0);
      gl.uniform2i(u("u_offset"), x0, y0);
    });
    if (stride > 0 && this.frames++ % stride === 0) {
      // The oldest past frame's surface is reused for the newest.
      const slot = this.history.length === HISTORY ? this.history.shift()! : gpu.surface(frameWidth, frameHeight, gl.RGBA8);
      gpu.pass(gpu.program(COPY_FS), slot, [frame], (u) => gl.uniform1i(u("u_src"), 0));
      this.history.push(slot);
    }
    const blur = gpu.program(BLUR_FS);
    for (const [src, out, dir] of [
      [this.residual.texture, this.blurX, [1, 0]],
      [this.blurX.texture, this.smooth, [0, 1]],
    ] as const) {
      gpu.pass(blur, out, [src], (u) => {
        gl.uniform1i(u("u_src"), 0);
        gl.uniform2i(u("u_limit"), w, h);
        gl.uniform2i(u("u_dir"), dir[0], dir[1]);
      });
    }
    const near = gpu.program(NEAR_FS);
    for (const [src, out, dir, channel] of [
      [this.residual.texture, this.nearX, [1, 0], 2],
      [this.nearX.texture, this.near, [0, 1], 0],
    ] as const) {
      gpu.pass(near, out, [src], (u) => {
        gl.uniform1i(u("u_src"), 0);
        gl.uniform2i(u("u_limit"), w, h);
        gl.uniform2i(u("u_dir"), dir[0], dir[1]);
        gl.uniform1i(u("u_radius"), this.options.nearRadius);
        gl.uniform1i(u("u_channel"), channel);
      });
    }
    gpu.pass(gpu.program(TILE_FS), this.tiles, [this.residual.texture, this.smooth.texture, this.near.texture], (u) => {
      gl.uniform1i(u("u_res"), 0);
      gl.uniform1i(u("u_smooth"), 1);
      gl.uniform1i(u("u_near"), 2);
      gl.uniform2i(u("u_size"), w, h);
      gl.uniform2f(u("u_origin"), x0, y0);
      gl.uniform1i(u("u_tile"), this.options.tile);
      gl.uniform1f(u("u_threshold"), this.options.threshold);
      gl.uniform1f(u("u_backMax"), this.options.backMax);
      gl.uniform1i(u("u_window"), this.options.window);
    });
  }

  /** Reads back the last frame's detections (DETECTION_FLOATS each) and tile mask. */
  read(): DetectorOutput {
    const gl = this.gpu.gl;
    const { framebuffer, width, height } = this.tiles;
    readFloats(gl, framebuffer, 0, width, height, this.read0);
    readFloats(gl, framebuffer, 1, width, height, this.read1);
    return this.decode(this.read0, this.read1);
  }

  /**
   * Queues the read of the last frame's detections without waiting for the GPU, tagged `tag`. Returns the
   * queued reads it had to finish to make room, oldest first; `collect` and `drain` return the others.
   */
  readLater(tag: number): { tag: number; output: DetectorOutput }[] {
    const { framebuffer, width, height } = this.tiles;
    return this.decoded(this.later.read(tag, framebuffer, [0, 1], width, height));
  }

  /** The queued reads the GPU has finished, oldest first. */
  collect(): { tag: number; output: DetectorOutput }[] {
    return this.decoded(this.later.collect());
  }

  /** Every queued read, oldest first. */
  drain(): { tag: number; output: DetectorOutput }[] {
    return this.decoded(this.later.drain());
  }

  private decoded(reads: { tag: number; data: Float32Array[] }[]): { tag: number; output: DetectorOutput }[] {
    return reads.map(({ tag, data }) => ({ tag, output: this.decode(data[0], data[1]) }));
  }

  private decode(read0: Float32Array, read1: Float32Array): DetectorOutput {
    const { width, height } = this.tiles;
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) mask[i] = read1[i * 4 + 3] > this.options.backMax ? 0 : 1;
    maskEnclosed(mask, width, height, this.options.openEdges);
    let count = 0;
    for (let i = 0; i < width * height; i++) if (mask[i] && read0[i * 4 + 2] > 0) count++;
    const detections = new Float32Array(count * DETECTION_FLOATS);
    let k = 0;
    for (let i = 0; i < width * height; i++) {
      if (!mask[i] || !(read0[i * 4 + 2] > 0)) continue;
      detections.set(read0.subarray(i * 4, i * 4 + 4), k);
      detections.set(read1.subarray(i * 4, i * 4 + 4), k + 4);
      k += DETECTION_FLOATS;
    }
    return { detections, mask };
  }

  detect(frame: WebGLTexture, frameWidth: number, frameHeight: number): DetectorOutput {
    this.process(frame, frameWidth, frameHeight);
    return this.read();
  }

  dispose(): void {
    for (const s of [this.a, this.b, this.residual, this.blurX, this.smooth, this.nearX, this.near, ...this.history]) this.gpu.release(s);
    this.history = [];
    this.later.dispose();
  }
}
