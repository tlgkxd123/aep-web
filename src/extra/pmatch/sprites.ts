// Sprite templates learned from detected particles. A GPU pass gathers crops of
// frame − background around chosen detections into an atlas (the only pixels read
// back); each crop is resampled so that its own spread maps to a fixed template
// spread, and k-means groups the templates into a few classes (soft dots, stars,
// rings...). A class's template is its members' mean, its tint their mean colour.
import type { Gpu, Surface } from "./gpu.ts";
import { readFloats } from "./gpu.ts";
import type { SpriteBank } from "./model.ts";
import { random } from "./sample.ts";

/** Crop side in frame pixels (odd: the detection is at the centre texel). */
export const CROP = 25;
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

/** Gathers crops of frame − background (`back` covers `origin`..+size of the frame) at up to CROPS_PER_PASS centres. */
export class CropGatherer {
  private readonly gpu: Gpu;
  private readonly atlas: Surface;
  private readonly pixels = new Float32Array(BATCH * CROP * BATCH * CROP * 4);

  constructor(gpu: Gpu) {
    this.gpu = gpu;
    this.atlas = gpu.surface(BATCH * CROP, BATCH * CROP, gpu.gl.RGBA32F);
  }

  gather(frame: WebGLTexture, frameSize: [number, number], back: WebGLTexture, origin: [number, number], backSize: [number, number], centers: { frame: number; x: number; y: number }[]): Crop[] {
    const { gpu } = this;
    const gl = gpu.gl;
    const list = centers.slice(0, CROPS_PER_PASS);
    if (!list.length) return [];
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
    readFloats(gl, this.atlas.framebuffer, 0, this.atlas.width, this.atlas.height, this.pixels);
    const side = BATCH * CROP;
    return list.map((c, index) => {
      const rgb = new Float32Array(CROP * CROP * 3);
      const ox = (index % BATCH) * CROP;
      const oy = Math.floor(index / BATCH) * CROP;
      for (let y = 0; y < CROP; y++) {
        for (let x = 0; x < CROP; x++) {
          const at = ((oy + y) * side + ox + x) * 4;
          rgb.set(this.pixels.subarray(at, at + 3), (y * CROP + x) * 3);
        }
      }
      return { frame: c.frame, x: c.x, y: c.y, rgb };
    });
  }

  dispose(): void {
    this.gpu.release(this.atlas);
  }
}

/** Template side in texels, and the spread (texels) a crop's own spread is mapped to. */
export const TEMPLATE = 32;
const TEMPLATE_SIGMA = 3.2;
/** Half the template's width in units of a particle's size (its spread). */
export const TEMPLATE_REACH = TEMPLATE / 2 / TEMPLATE_SIGMA;

interface Canonical {
  template: Float32Array;
  /** The crop's spread (px) and colour (largest channel 1). */
  sigma: number;
  tint: [number, number, number];
}

/** A crop resampled to the template spread; null when it holds no clear particle. */
export function canonical(crop: Crop): Canonical | null {
  const lum = new Float32Array(CROP * CROP);
  for (let i = 0; i < lum.length; i++) lum[i] = (crop.rgb[i * 3] + crop.rgb[i * 3 + 1] + crop.rgb[i * 3 + 2]) / 3;
  // Background left in the crop: the median of its border.
  const border: number[] = [];
  for (let k = 0; k < CROP; k++) border.push(lum[k], lum[(CROP - 1) * CROP + k], lum[k * CROP], lum[k * CROP + CROP - 1]);
  border.sort((a, b) => a - b);
  const floor = border[border.length >> 1];
  let peak = 0;
  for (let y = HALF - 2; y <= HALF + 2; y++) for (let x = HALF - 2; x <= HALF + 2; x++) peak = Math.max(peak, lum[y * CROP + x] - floor);
  if (!(peak > 1e-3)) return null;
  for (let i = 0; i < lum.length; i++) lum[i] = Math.max(0, (lum[i] - floor) / peak);
  let s = 0, sx = 0, sy = 0, sxx = 0, syy = 0;
  const tint = [0, 0, 0];
  for (let y = 0; y < CROP; y++) {
    for (let x = 0; x < CROP; x++) {
      const dx = x - HALF;
      const dy = y - HALF;
      if (dx * dx + dy * dy > 100) continue;
      const w = lum[y * CROP + x] > 0.05 ? lum[y * CROP + x] : 0;
      s += w;
      sx += w * dx;
      sy += w * dy;
      sxx += w * dx * dx;
      syy += w * dy * dy;
      for (let c = 0; c < 3; c++) tint[c] += w * crop.rgb[(y * CROP + x) * 3 + c];
    }
  }
  if (!(s > 0)) return null;
  const mx = sx / s;
  const my = sy / s;
  const sigma = Math.max(0.6, Math.min(6, Math.sqrt(Math.max(0, 0.5 * (sxx / s - mx * mx + syy / s - my * my)))));
  const template = new Float32Array(TEMPLATE * TEMPLATE);
  const sample = (x: number, y: number) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const at = (px: number, py: number) => (px < 0 || py < 0 || px >= CROP || py >= CROP ? 0 : lum[py * CROP + px]);
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
  };
  const k = sigma / TEMPLATE_SIGMA;
  for (let v = 0; v < TEMPLATE; v++) {
    for (let u = 0; u < TEMPLATE; u++) {
      template[v * TEMPLATE + u] = sample(HALF + mx + (u + 0.5 - TEMPLATE / 2) * k, HALF + my + (v + 0.5 - TEMPLATE / 2) * k);
    }
  }
  const top = Math.max(tint[0], tint[1], tint[2]);
  return { template, sigma, tint: top > 0 ? [tint[0] / top, tint[1] / top, tint[2] / top] : [1, 1, 1] };
}

function distance(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i] - b[i]) ** 2;
  return d;
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
export function meanTemplate(crops: Crop[]): Float32Array {
  const out = new Float32Array(TEMPLATE * TEMPLATE);
  let n = 0;
  for (const crop of crops) {
    const c = canonical(crop);
    if (!c) continue;
    for (let i = 0; i < out.length; i++) out[i] += c.template[i];
    n++;
  }
  if (n) for (let i = 0; i < out.length; i++) out[i] /= n;
  return out;
}

export interface LearnedSprites {
  bank: SpriteBank;
  /** Class of each crop (−1 for crops without a clear particle). */
  labels: Int32Array;
}

/** k-means over the crops' canonical templates; one soft dot when there are no usable crops. */
export function learnSprites(crops: Crop[], seed = 3): LearnedSprites {
  const items = crops.map(canonical);
  const usable = items.map((c, i) => [c, i] as const).filter((x): x is readonly [Canonical, number] => x[0] !== null);
  const labels = new Int32Array(crops.length).fill(-1);
  const n = usable.length;
  const k = n < 60 ? 1 : n < 200 ? 2 : n < 600 ? 3 : 4;
  if (!n) {
    const data = new Float32Array(TEMPLATE * TEMPLATE);
    for (let v = 0; v < TEMPLATE; v++) {
      for (let u = 0; u < TEMPLATE; u++) {
        const dx = (u + 0.5 - TEMPLATE / 2) / TEMPLATE_SIGMA;
        const dy = (v + 0.5 - TEMPLATE / 2) / TEMPLATE_SIGMA;
        data[v * TEMPLATE + u] = Math.exp(-0.5 * (dx * dx + dy * dy));
      }
    }
    return { bank: { size: TEMPLATE, reach: TEMPLATE_REACH, count: 1, data, tint: Float32Array.of(1, 1, 1) }, labels };
  }
  const rand = random(seed);
  // k-means++ seeding.
  const centres: Float32Array[] = [Float32Array.from(usable[Math.floor(rand() * n)][0].template)];
  while (centres.length < k) {
    const d = usable.map(([c]) => Math.min(...centres.map((m) => distance(c.template, m))));
    const total = d.reduce((s, v) => s + v, 0);
    let r = rand() * total;
    let pick = 0;
    while (pick < n - 1 && (r -= d[pick]) > 0) pick++;
    centres.push(Float32Array.from(usable[pick][0].template));
  }
  const assign = new Int32Array(n);
  for (let iteration = 0; iteration < 25; iteration++) {
    let changed = false;
    usable.forEach(([c], i) => {
      let best = 0;
      let bestD = Infinity;
      centres.forEach((m, j) => {
        const d = distance(c.template, m);
        if (d < bestD) {
          bestD = d;
          best = j;
        }
      });
      if (assign[i] !== best || iteration === 0) changed = true;
      assign[i] = best;
    });
    for (let j = 0; j < k; j++) {
      const sum = new Float32Array(TEMPLATE * TEMPLATE);
      let count = 0;
      usable.forEach(([c], i) => {
        if (assign[i] !== j) return;
        for (let t = 0; t < sum.length; t++) sum[t] += c.template[t];
        count++;
      });
      if (count) centres[j] = sum.map((v) => v / count);
    }
    if (!changed) break;
  }
  // Classes by size, largest first; empty ones dropped.
  const sizes = centres.map((_, j) => assign.reduce((s, a) => s + (a === j ? 1 : 0), 0));
  const order = centres.map((_, j) => j).filter((j) => sizes[j] > 0).sort((a, b) => sizes[b] - sizes[a]);
  const data = new Float32Array(order.length * TEMPLATE * TEMPLATE);
  const tint = new Float32Array(order.length * 3);
  order.forEach((j, slot) => {
    const centre = centres[j];
    const top = Math.max(1e-6, ...centre);
    data.set(centre.map((v) => Math.max(0, v / top)), slot * TEMPLATE * TEMPLATE);
    const colour = [0, 0, 0];
    usable.forEach(([c], i) => {
      if (assign[i] !== j) return;
      for (let ch = 0; ch < 3; ch++) colour[ch] += c.tint[ch];
    });
    const peak = Math.max(1e-6, ...colour);
    tint.set(colour.map((v) => v / peak), slot * 3);
  });
  const slotOf = new Map(order.map((j, slot) => [j, slot]));
  usable.forEach(([, index], i) => (labels[index] = slotOf.get(assign[i]) ?? 0));
  return { bank: { size: TEMPLATE, reach: TEMPLATE_REACH, count: order.length, data, tint }, labels };
}
