// The fractal noise Fractal Noise and Turbulent Displace draw: value noise on an integer lattice, filtered as
// Block, Linear, Soft Linear or Spline, blended between two evolution planes (stockMath.ts evolutionPlanes) and
// summed over Complexity octaves, each weighted by Sub Influence relative to the one before and drawn in the space
// of the one before through the sub transform (Sub Scaling, Sub Rotation, Sub Offset). The lattice hash is integer
// arithmetic, so every GPU draws the same values.
import type { Uniforms } from "./fxextraUtil.ts";
import { DEG, evolutionPlanes, type Affine } from "./stockMath.ts";

/** Fractal Noise's Noise Type popup. */
export const NoiseType = { BLOCK: 1, LINEAR: 2, SOFT_LINEAR: 3, SPLINE: 4 } as const;

/** How each octave's value v (0..1) is shaped before the sum: as it is, or folded about ½ (the turbulent types). */
export const FractalShape = { BASIC: 1, TURBULENT_SMOOTH: 2, TURBULENT_BASIC: 3, TURBULENT_SHARP: 4 } as const;

/** The most octaves a Complexity draws. */
export const MAX_OCTAVES = 20;

export interface FractalSettings {
  noiseType: number;
  shape: number;
  complexity: number;
  /** Each octave's weight relative to the one before. */
  persistence: number;
  /** Noise space of an octave to the next one's. */
  sub: Affine;
  /** Degrees. */
  evolution: number;
  cycle: boolean;
  revolutions: number;
  seed: number;
}

/** Layer pixels per noise cell at Scale 100 %. */
export const NOISE_CELL = 64;

/**
 * Image pixels to noise space: `offset` (layer pixels) at the origin, cells NOISE_CELL × the scale (fractions per
 * axis, applied before the rotation) wide, turned clockwise by `rotation` degrees, at image scale k.
 */
export function noiseSpace(offset: number[], scale: [number, number], rotation: number, k: number): Affine {
  const cos = Math.cos(rotation * DEG) / NOISE_CELL;
  const sin = Math.sin(rotation * DEG) / NOISE_CELL;
  const [sx, sy] = scale.map((v) => Math.max(1e-3, v));
  const [ox, oy] = [offset[0] / sx, offset[1] / sy];
  return [cos / (k * sx), -sin / (k * sx), sin / (k * sy), cos / (k * sy), -cos * ox - sin * oy, sin * ox - cos * oy];
}

/**
 * The sub transform: the next octave's noise space is this one's scaled by 100 / Sub Scaling (%), turned by Sub
 * Rotation (degrees, clockwise) and moved by `offset` (noise units).
 */
export function octaveTransform(subScaling: number, subRotation: number, offset: [number, number] = [0, 0]): Affine {
  const m = 100 / Math.min(1000, Math.max(10, subScaling));
  const a = -subRotation * DEG;
  return [m * Math.cos(a), m * Math.sin(a), -m * Math.sin(a), m * Math.cos(a), offset[0], offset[1]];
}

/**
 * GLSL: `float fractal(vec2 x, uint stream)`, the fractal noise (about 0..1) at noise-space point x (one lattice
 * cell per unit); streams are independent noises over the same settings.
 */
export const FRACTAL_GLSL = `
uniform int u_noiseType;
uniform int u_shape;
uniform float u_complexity;
uniform float u_persistence;
uniform mat3 u_sub;
uniform vec2 u_planes;
uniform float u_planeWeight;
uniform uint u_seed;
uvec3 pcg3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
float lattice(ivec2 c, uint plane) { return float(pcg3(uvec3(uvec2(c), plane)).x >> 8u) * (1.0 / 16777215.0); }
float catmullRom(float a, float b, float c, float d, float t) {
  return b + 0.5 * t * (c - a + t * (2.0 * a - 5.0 * b + 4.0 * c - d + t * (3.0 * (b - c) + d - a)));
}
float planeNoise(vec2 x, uint plane) {
  if (u_noiseType == ${NoiseType.BLOCK}) return lattice(ivec2(floor(x)), plane);
  vec2 f = x - 0.5;
  vec2 i = floor(f);
  vec2 t = f - i;
  ivec2 c = ivec2(i);
  if (u_noiseType == ${NoiseType.SPLINE}) {
    float r[4];
    for (int j = 0; j < 4; j++) {
      ivec2 row = c + ivec2(0, j - 1);
      r[j] = catmullRom(lattice(row + ivec2(-1, 0), plane), lattice(row, plane), lattice(row + ivec2(1, 0), plane), lattice(row + ivec2(2, 0), plane), t.x);
    }
    return catmullRom(r[0], r[1], r[2], r[3], t.y);
  }
  if (u_noiseType == ${NoiseType.SOFT_LINEAR}) t = t * t * (3.0 - 2.0 * t);
  return mix(mix(lattice(c, plane), lattice(c + ivec2(1, 0), plane), t.x), mix(lattice(c + ivec2(0, 1), plane), lattice(c + ivec2(1, 1), plane), t.x), t.y);
}
float evolving(vec2 x, uint salt) {
  float a = planeNoise(x, uint(int(u_planes.x)) * 747796405u + salt);
  float b = planeNoise(x, uint(int(u_planes.y)) * 747796405u + salt);
  return mix(a, b, u_planeWeight);
}
float shaped(float v) {
  if (u_shape == ${FractalShape.TURBULENT_SMOOTH}) { v = 2.0 * abs(v - 0.5); return v * v; }
  if (u_shape == ${FractalShape.TURBULENT_BASIC}) return 2.0 * abs(v - 0.5);
  if (u_shape == ${FractalShape.TURBULENT_SHARP}) return sqrt(2.0 * abs(v - 0.5));
  return v;
}
float fractal(vec2 x, uint stream) {
  float left = u_complexity;
  float amp = 1.0;
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < ${MAX_OCTAVES}; i++) {
    float w = amp * min(left, 1.0);
    uint salt = u_seed * 2654435761u ^ uint(i) * 2246822519u ^ stream * 3266489917u;
    sum += w * shaped(evolving(x, salt));
    wsum += w;
    if (left <= 1.0) break;
    left -= 1.0;
    amp *= u_persistence;
    x = (u_sub * vec3(x, 1.0)).xy;
  }
  return wsum > 0.0 ? sum / wsum : 0.5;
}
`;

/** Sets FRACTAL_GLSL's uniforms. */
export function setFractalUniforms(gl: WebGL2RenderingContext, u: Parameters<Uniforms>[0], s: FractalSettings): void {
  const { planes, weight } = evolutionPlanes(s.evolution, s.cycle, s.revolutions);
  const m = s.sub;
  gl.uniform1i(u("u_noiseType"), s.noiseType);
  gl.uniform1i(u("u_shape"), s.shape);
  gl.uniform1f(u("u_complexity"), Math.min(MAX_OCTAVES, Math.max(1, s.complexity)));
  gl.uniform1f(u("u_persistence"), Math.max(0, s.persistence));
  gl.uniformMatrix3fv(u("u_sub"), false, [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);
  gl.uniform2f(u("u_planes"), planes[0], planes[1]);
  gl.uniform1f(u("u_planeWeight"), weight);
  gl.uniform1ui(u("u_seed"), Math.round(s.seed) >>> 0);
}
