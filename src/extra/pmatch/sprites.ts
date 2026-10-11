// Sprite crops of detected particles. A GPU pass gathers crops of frame − background
// around chosen detections into an atlas (the only pixels read back); each crop is
// resampled so that the spread of its core maps to a fixed template spread, its halo
// around it. The world model's sprite codebook is learned from these
// (ml/pmatch/pmatch/sprites.py), and evaluation compares its templates with held-out crops.
import type { Gpu, Surface } from "./gpu.ts";
import { ReadbackQueue } from "./gpu.ts";

/** Crop side in frame pixels (odd: the detection is at the centre texel). */
export const CROP = 49;
/** Least detection peak worth a crop: dimmer particles' shapes drown in noise. */
export const CROP_PEAK = 30 / 255;
const HALF = (CROP - 1) / 2;
/** Crops per atlas row; an atlas holds BATCH × BATCH crops. */
const BATCH = 8;
export const CROPS_PER_PASS = BATCH * BATCH;

const CROP_FS = `#version 300 es
precision highp float;
uniform sampler2D u_frame;
uniform sampler2D u_back;
uniform vec2 u_centers[${CROPS_PER_PASS}];
uniform int u_count;
uniform ivec2 u_frameSize;
uniform ivec2 u_origin;
uniform ivec2 u_backSize;
out vec4 outColor;
vec3 residual(ivec2 p) {
  vec3 f = texelFetch(u_frame, clamp(p, ivec2(0), u_frameSize - 1), 0).rgb;
  vec3 b = texelFetch(u_back, clamp(p - u_origin, ivec2(0), u_backSize - 1), 0).rgb;
  return max(f - b, vec3(0.0));
}
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy);
  int index = (o.y / ${CROP}) * ${BATCH} + o.x / ${CROP};
  if (index >= u_count) {
    outColor = vec4(0.0);
    return;
  }
  ivec2 local = o - ivec2(o.x / ${CROP}, o.y / ${CROP}) * ${CROP};
  // Pixel centres are at +0.5: bilinear between the four around the sample point.
  vec2 p = u_centers[index] + vec2(local - ${HALF}) - 0.5;
  ivec2 b = ivec2(floor(p));
  vec2 t = p - vec2(b);
  vec3 v = mix(mix(residual(b), residual(b + ivec2(1, 0)), t.x), mix(residual(b + ivec2(0, 1)), residual(b + ivec2(1, 1)), t.x), t.y);
  outColor = vec4(v, 1.0);
}`;

export interface Crop {
  frame: number;
  /** Detection position (frame pixels, y down). */
  x: number;
  y: number;
  /** CROP × CROP × 3 residual light, rows top first. */
  rgb: Float32Array;
}

type CropCentre = { frame: number; x: number; y: number };

/**
 * Gathers crops of frame − background (`back` covers `origin`..+size of the frame), up to CROPS_PER_PASS centres
 * a pass, read back without waiting for the GPU: `gather` queues a pass and, like `collect`, hands back the
 * crops of the passes the GPU has finished, oldest first; `drain` hands back the rest.
 */
export class CropGatherer {
  private readonly gpu: Gpu;
  private readonly atlas: Surface;
  private readonly reads: ReadbackQueue<CropCentre[]>;

  constructor(gpu: Gpu) {
    this.gpu = gpu;
    this.atlas = gpu.surface(BATCH * CROP, BATCH * CROP, gpu.gl.RGBA32F);
    this.reads = new ReadbackQueue(gpu.gl, 4);
  }

  gather(frame: WebGLTexture, frameSize: [number, number], back: WebGLTexture, origin: [number, number], backSize: [number, number], centers: CropCentre[]): Crop[] {
    const { gpu } = this;
    const gl = gpu.gl;
    const list = centers.slice(0, CROPS_PER_PASS);
    if (!list.length) return this.collect();
    const flat = new Float32Array(CROPS_PER_PASS * 2);
    list.forEach((c, i) => flat.set([c.x, c.y], i * 2));
    gpu.pass(gpu.program(CROP_FS), this.atlas, [frame, back], (u) => {
      gl.uniform1i(u("u_frame"), 0);
      gl.uniform1i(u("u_back"), 1);
      gl.uniform2fv(u("u_centers[0]"), flat);
      gl.uniform1i(u("u_count"), list.length);
      gl.uniform2i(u("u_frameSize"), frameSize[0], frameSize[1]);
      gl.uniform2i(u("u_origin"), origin[0], origin[1]);
      gl.uniform2i(u("u_backSize"), backSize[0], backSize[1]);
    });
    // Crops fill the atlas from its bottom row (GL row 0) up: only their rows are read.
    const done = this.reads.read(list, this.atlas.framebuffer, [0], this.atlas.width, Math.ceil(list.length / BATCH) * CROP);
    return [...this.unpack(done), ...this.collect()];
  }

  collect(): Crop[] {
    return this.unpack(this.reads.collect());
  }

  drain(): Crop[] {
    return this.unpack(this.reads.drain());
  }

  private unpack(reads: { tag: CropCentre[]; data: Float32Array[] }[]): Crop[] {
    const side = BATCH * CROP;
    return reads.flatMap(({ tag: list, data: [pixels] }) =>
      list.map((c, index) => {
        const rgb = new Float32Array(CROP * CROP * 3);
        const ox = (index % BATCH) * CROP;
        const oy = Math.floor(index / BATCH) * CROP;
        for (let y = 0; y < CROP; y++) {
          for (let x = 0; x < CROP; x++) {
            const at = ((oy + y) * side + ox + x) * 4;
            rgb.set(pixels.subarray(at, at + 3), (y * CROP + x) * 3);
          }
        }
        return { frame: c.frame, x: c.x, y: c.y, rgb };
      }),
    );
  }

  dispose(): void {
    this.reads.dispose();
    this.gpu.release(this.atlas);
  }
}

/** Template side in texels, and the spread (texels) a crop's spread is mapped to. */
export const TEMPLATE = 64;
export const TEMPLATE_SIGMA = 4;
/** Half the template's width in units of a particle's size (its spread): room for the halo. */
export const TEMPLATE_REACH = TEMPLATE / 2 / TEMPLATE_SIGMA;
/** Half-width (px) of the box a crop's spread is measured in, as the detector measures a particle's (detect.ts window). */
const SPREAD_WINDOW = 5;

interface Canonical {
  template: Float32Array;
  /** The crop's spread (px), measured as the detector measures a particle's size, and its colour (largest channel 1). */
  sigma: number;
  tint: [number, number, number];
}

/** A crop's luminance over the median of its border, and its peak near the centre. */
export function cropLight(crop: Crop): { lum: Float32Array; peak: number } {
  const lum = new Float32Array(CROP * CROP);
  for (let i = 0; i < lum.length; i++) lum[i] = (crop.rgb[i * 3] + crop.rgb[i * 3 + 1] + crop.rgb[i * 3 + 2]) / 3;
  const border: number[] = [];
  for (let k = 0; k < CROP; k++) border.push(lum[k], lum[(CROP - 1) * CROP + k], lum[k * CROP], lum[k * CROP + CROP - 1]);
  border.sort((a, b) => a - b);
  const floor = border[border.length >> 1];
  let peak = 0;
  for (let i = 0; i < lum.length; i++) lum[i] -= floor;
  for (let y = HALF - 2; y <= HALF + 2; y++) for (let x = HALF - 2; x <= HALF + 2; x++) peak = Math.max(peak, lum[y * CROP + x]);
  return { lum, peak };
}

/** Catmull-Rom weights of the four samples around fraction `t`, into `out` at `at`. */
function catmullRom(t: number, out: Float64Array, at: number): void {
  out[at] = ((-t + 2) * t - 1) * t * 0.5;
  out[at + 1] = ((3 * t - 5) * t * t + 2) * 0.5;
  out[at + 2] = ((-3 * t + 4) * t + 1) * t * 0.5;
  out[at + 3] = (t - 1) * t * t * 0.5;
}

/**
 * A crop resampled to a template of `size` texels on which its spread is `sigmaTexels` texels, so that a
 * sprite drawn at a particle's size looks like its crop; null when it holds no clear particle.
 */
export function canonical(crop: Crop, size = TEMPLATE, sigmaTexels = TEMPLATE_SIGMA): Canonical | null {
  const { lum, peak } = cropLight(crop);
  if (!(peak > 1e-3)) return null;
  for (let i = 0; i < lum.length; i++) lum[i] = Math.max(0, lum[i] / peak);
  // The core's centre: the light above half the peak around the brightest pixel near the middle. The
  // templates are means of crops, so this is what lines their cores up.
  let top = HALF * CROP + HALF;
  for (let y = HALF - 2; y <= HALF + 2; y++) for (let x = HALF - 2; x <= HALF + 2; x++) if (lum[y * CROP + x] > lum[top]) top = y * CROP + x;
  let core = 0, cx = 0, cy = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const w = Math.max(0, lum[top + dy * CROP + dx] - 0.5);
      core += w;
      cx += w * ((top % CROP) + dx - HALF);
      cy += w * (Math.floor(top / CROP) + dy - HALF);
    }
  }
  const mx = core > 0 ? cx / core : 0;
  const my = core > 0 ? cy / core : 0;
  let s = 0, sxx = 0, syy = 0;
  const tint = [0, 0, 0];
  for (let dy = -SPREAD_WINDOW; dy <= SPREAD_WINDOW; dy++) {
    for (let dx = -SPREAD_WINDOW; dx <= SPREAD_WINDOW; dx++) {
      const at = ((HALF + dy) * CROP + HALF + dx) * 3;
      // White light, as the detector weighs it.
      const w = Math.max(0, Math.min(crop.rgb[at], crop.rgb[at + 1], crop.rgb[at + 2]));
      s += w;
      sxx += w * (dx - mx) ** 2;
      syy += w * (dy - my) ** 2;
      for (let c = 0; c < 3; c++) tint[c] += w * crop.rgb[at + c];
    }
  }
  if (!(s > 0)) return null;
  const sigma = Math.max(0.6, Math.min(6, Math.sqrt(Math.max(0, (0.5 * (sxx + syy)) / s))));
  const template = new Float32Array(size * size);
  // Catmull-Rom (unlike bilinear interpolation it does not soften the particle's core), separably: the
  // texel grid is axis-aligned with the crop's, so each row is resampled once, then the columns.
  const k = sigma / sigmaTexels;
  const x0 = new Int32Array(size);
  const y0 = new Int32Array(size);
  const wx = new Float64Array(size * 4);
  const wy = new Float64Array(size * 4);
  for (let u = 0; u < size; u++) {
    const x = HALF + mx + (u + 0.5 - size / 2) * k;
    const y = HALF + my + (u + 0.5 - size / 2) * k;
    x0[u] = Math.floor(x);
    y0[u] = Math.floor(y);
    catmullRom(x - x0[u], wx, u * 4);
    catmullRom(y - y0[u], wy, u * 4);
  }
  const rows = new Float64Array(CROP * size);
  for (let py = 0; py < CROP; py++) {
    for (let u = 0; u < size; u++) {
      let v = 0;
      for (let i = 0; i < 4; i++) {
        const px = x0[u] - 1 + i;
        if (px >= 0 && px < CROP) v += lum[py * CROP + px] * wx[u * 4 + i];
      }
      rows[py * size + u] = v;
    }
  }
  for (let v = 0; v < size; v++) {
    for (let u = 0; u < size; u++) {
      let value = 0;
      for (let j = 0; j < 4; j++) {
        const py = y0[v] - 1 + j;
        if (py >= 0 && py < CROP) value += rows[py * size + u] * wy[v * 4 + j];
      }
      template[v * size + u] = Math.max(0, value);
    }
  }
  const brightest = Math.max(tint[0], tint[1], tint[2]);
  return { template, sigma, tint: brightest > 0 ? [tint[0] / brightest, tint[1] / brightest, tint[2] / brightest] : [1, 1, 1] };
}

/** Pearson correlation of two templates. */
export function correlation(a: Float32Array, b: Float32Array): number {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= a.length;
  mb /= b.length;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < a.length; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

/** The mean canonical template of a set of crops (for comparing two videos' sprites). */
export function meanTemplate(crops: Crop[], size = TEMPLATE, sigmaTexels = TEMPLATE_SIGMA): Float32Array {
  const out = new Float32Array(size * size);
  let n = 0;
  for (const crop of crops) {
    const c = canonical(crop, size, sigmaTexels);
    if (!c) continue;
    for (let i = 0; i < out.length; i++) out[i] += c.template[i];
    n++;
  }
  if (n) for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}
