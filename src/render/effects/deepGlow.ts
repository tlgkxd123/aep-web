// Deep Glow 2 (PEDG2, Plugin Everything): a black-box look-alike fitted to After
// Effects renders of the deepglow fixtures (scripts/dg-*.ts).
//
// The glow is a sum of Gaussian octaves of the source's linear light (gamma 2.2):
// sigma_k = Radius / 8.12 * 2^-k for as long as sigma_k stays above ~0.86 px (the
// last octave weighted by how far past it the count reaches), at most Glow
// Iterations of them, each widened by ~2.1 px in quadrature, each of weight ~1.13.
// It is screened over the source in gamma space. On transparent layers the result
// is the composite over black, with alpha the brightest of the source alpha and the
// output channels.
//
// Each octave is blurred on a 2x mip pyramid level where its sigma spans 3-6 texels
// (half float, separable, rotatable for Aspect Angle) and accumulated at full size.
import type { Layer, PropertyGroup } from "../../aep/model.ts";
import { effectNumber, effectVector } from "../effectParams.ts";
import { acquireFloat, releaseFloat } from "../floatTargets.ts";
import type { Target } from "../gl.ts";
import { registerEffect, type LayerImage, type RenderContext } from "../registry.ts";

/** Fitted kernel and transfer constants (see the header). */
export const DEEP_GLOW = {
  sigmaDivisor: 8.118,
  sigmaFloor: 2.147,
  minSigma: 0.858,
  octaveWeight: 1.132,
  gammaIn: 2.2,
  gammaOut: 2.2,
};

const P = {
  glowMode: 103,
  blendMode: 24,
  radius: 17,
  exposure: 18,
  thresholdMode: 95,
  threshold: 20,
  thresholdSmooth: 21,
  saturationBias: 96,
  aspectRatio: 31,
  enableAngle: 32,
  aspectAngle: 33,
  pixelAberration: 36,
  aberrationChannels: 37,
  pixelOffset: 38,
  glowAberration: 1036,
  multiplyRed: 97,
  multiplyGreen: 98,
  multiplyBlue: 99,
  tintMode: 43,
  tintBlend: 67,
  tintColor: 42,
  tintOuter: 66,
  tintStrength: 44,
  glowIterations: 51,
  view: 53,
} as const;

const Blend = { SCREEN: 1, ADD: 2 } as const;
const Tint = { OFF: 1, MONO: 3, DUO: 4 } as const;
const View = { FINAL: 1, GLOW_INPUT: 2 } as const;

interface Octave {
  /** Gaussian sigma along the glow's major (u) and minor (v) axes, in layer pixels. */
  su: number;
  sv: number;
  weight: number;
}

/** The glow's Gaussian octaves for a radius; `aspect` stretches u against v. */
export function glowOctaves(radius: number, iterations: number, aspect: number): Octave[] {
  const k = DEEP_GLOW;
  if (radius <= 0) return [];
  const count = Math.min(iterations, Math.log2(radius / k.sigmaDivisor / k.minSigma) + 1);
  const out: Octave[] = [];
  for (let i = 0; i < Math.ceil(count); i++) {
    const s = (radius * 2 ** -i) / k.sigmaDivisor;
    const weight = k.octaveWeight * Math.min(1, count - i);
    if (weight <= 0) continue;
    out.push({ su: Math.hypot(s * aspect, k.sigmaFloor), sv: Math.hypot(s, k.sigmaFloor), weight });
  }
  return out;
}

const HEADER = `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;
`;

/**
 * Source (padded RGBA8, premultiplied) into the glow input plane, in linear light. The threshold works on the
 * gamma-encoded values: a gate smoothstep(T - w, T + w, x) with w = min(Smooth, T), per channel
 * (Chrominance) or on the Rec. 709 luma (Luminance). In Chrominance mode Saturation Bias b mixes in the same
 * gate applied to the HSV saturation (b > 0) or to 1 - saturation (b < 0): (1 - |b|) gate + |b| saturationGate.
 */
const INPUT_FS = `${HEADER}
uniform sampler2D u_source;
uniform ivec2 u_offset;
uniform ivec2 u_size;
uniform int u_pad;
uniform float u_gamma;
uniform int u_thresholdMode;
uniform float u_threshold;
uniform float u_smooth;
uniform float u_satBias;

float gate(float x) {
  float w = min(u_smooth, u_threshold);
  return w > 0.0 ? smoothstep(u_threshold - w, u_threshold + w, x) : step(u_threshold, x);
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy) + u_offset;
  vec4 s = any(lessThan(c, ivec2(0))) || any(greaterThanEqual(c, u_size)) ? vec4(0.0) : texelFetch(u_source, c + u_pad, 0);
  vec3 v = s.rgb;
  if (u_threshold > 0.0) {
    vec3 g = u_thresholdMode == 2 ? vec3(gate(dot(v, vec3(0.2126, 0.7152, 0.0722)))) : vec3(gate(v.r), gate(v.g), gate(v.b));
    float hi = max(v.r, max(v.g, v.b));
    float sat = hi > 0.0 ? (hi - min(v.r, min(v.g, v.b))) / hi : 0.0;
    float b = u_thresholdMode == 2 ? 0.0 : abs(u_satBias);
    float satGate = gate(u_satBias >= 0.0 ? sat : 1.0 - sat);
    v *= (1.0 - b) * g + b * satGate;
  }
  outColor = vec4(pow(v, vec3(u_gamma)), 1.0);
}`;

/** 2x box reduction (transparent outside). */
const DOWN_FS = `${HEADER}
uniform sampler2D u_src;
uniform ivec2 u_srcSize;
vec4 at(ivec2 p) { return any(greaterThanEqual(p, u_srcSize)) ? vec4(0.0) : texelFetch(u_src, p, 0); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  outColor = 0.25 * (at(p) + at(p + ivec2(1, 0)) + at(p + ivec2(0, 1)) + at(p + ivec2(1, 1)));
}`;

/** One separable Gaussian pass along u_dir (texels per step), linearly sampled, normalized over its taps. */
const BLUR_FS = `${HEADER}
uniform sampler2D u_src;
uniform vec2 u_size;
uniform vec2 u_dir;
uniform float u_sigma;
uniform int u_reach;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -u_reach; i <= u_reach; i++) {
    float w = exp(-0.5 * float(i * i) / (u_sigma * u_sigma));
    vec2 q = p + u_dir * float(i);
    vec4 v = any(lessThan(q, vec2(0.0))) || any(greaterThan(q, u_size)) ? vec4(0.0) : texture(u_src, q / u_size);
    sum += w * v;
    total += w;
  }
  outColor = sum / total;
}`;

/**
 * Adds a weighted blurred level (bilinearly upsampled from its pyramid scale) to the accumulator, each channel
 * read at its own offset (Pixel Aberration, in full-size texels).
 */
const ACCUMULATE_FS = `${HEADER}
uniform sampler2D u_acc;
uniform sampler2D u_level;
uniform vec2 u_levelSize;
uniform float u_scale;
uniform float u_weight;
uniform int u_first;
uniform vec2 u_shiftR;
uniform vec2 u_shiftG;
uniform vec2 u_shiftB;
vec4 at(vec2 p) { return texture(u_level, p / u_scale / u_levelSize); }
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 acc = u_first == 1 ? vec4(0.0) : texelFetch(u_acc, ivec2(p), 0);
  outColor = acc + u_weight * vec4(at(p + u_shiftR).r, at(p + u_shiftG).g, at(p + u_shiftB).b, 0.0);
}`;

/**
 * The glow over the source: Screen or Add in gamma space (channel c of the glow from u_glow[c], whose radii
 * differ under Glow Aberration); alpha is the brightest of the source alpha and the colour channels.
 */
const COMPOSITE_FS = `${HEADER}
uniform sampler2D u_source;
uniform sampler2D u_glowR;
uniform sampler2D u_glowG;
uniform sampler2D u_glowB;
uniform ivec2 u_offset;
uniform ivec2 u_size;
uniform ivec2 u_outSize;
uniform int u_pad;
uniform vec3 u_gain;
uniform float u_gamma;
uniform int u_blend;
uniform int u_view;

float glowAt(sampler2D glow, ivec2 c, int channel) {
  return pow(clamp(texelFetch(glow, c, 0)[channel] * u_gain[channel], 0.0, 1.0), 1.0 / u_gamma);
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy) - u_pad;
  if (any(lessThan(c, ivec2(0))) || any(greaterThanEqual(c, u_outSize))) {
    outColor = vec4(0.0);
    return;
  }
  ivec2 sc = c + u_offset;
  vec4 s = any(lessThan(sc, ivec2(0))) || any(greaterThanEqual(sc, u_size)) ? vec4(0.0) : texelFetch(u_source, sc + u_pad, 0);
  vec3 g = vec3(glowAt(u_glowR, c, 0), glowAt(u_glowG, c, 1), glowAt(u_glowB, c, 2));
  vec3 rgb;
  if (u_view == 2) rgb = g;
  else if (u_blend == 2) rgb = min(s.rgb + g, 1.0);
  else rgb = 1.0 - (1.0 - s.rgb) * (1.0 - g);
  float a = max(rgb.r, max(rgb.g, rgb.b));
  if (u_view != 2) a = max(a, s.a);
  outColor = vec4(min(rgb, a), a);
}`;

interface Plane {
  target: Target;
  width: number;
  height: number;
}

function fullPass(ctx: RenderContext, fragment: string, out: Target, inputs: Target[], set: (u: (name: string) => WebGLUniformLocation | null) => void) {
  ctx.pass(ctx.program(fragment), out, inputs, set);
}

/** The pyramid level whose texel spacing keeps the octave's smaller sigma at 3 texels or more. */
function levelFor(octave: Octave): number {
  return Math.max(0, Math.floor(Math.log2(Math.min(octave.su, octave.sv) / 3)));
}

/** Blur of pyramid level `plane` (scale 2^level) by an octave rotated by `angle` (radians, layer space). */
function blurOctave(ctx: RenderContext, plane: Plane, level: number, octave: Octave, angle: number): Plane {
  const gl = ctx.gl;
  const scale = 2 ** level;
  // The box reduction and bilinear upsampling already spread a level by about half a texel.
  const sigma = (s: number) => Math.sqrt(Math.max(0.01, (s / scale) ** 2 - 0.25));
  // Layer space has y down, the planes have GL rows (y up).
  const u: [number, number] = [Math.cos(angle), -Math.sin(angle)];
  const v: [number, number] = [Math.sin(angle), Math.cos(angle)];
  let current = plane.target;
  for (const [dir, s] of [
    [u, sigma(octave.su)],
    [v, sigma(octave.sv)],
  ] as const) {
    const out = acquireFloat(ctx, plane.width, plane.height, true);
    fullPass(ctx, BLUR_FS, out, [current], (un) => {
      gl.uniform1i(un("u_src"), 0);
      gl.uniform2f(un("u_size"), plane.width, plane.height);
      gl.uniform2f(un("u_dir"), dir[0], dir[1]);
      gl.uniform1f(un("u_sigma"), s);
      gl.uniform1i(un("u_reach"), Math.min(96, Math.ceil(3 * s)));
    });
    if (current !== plane.target) releaseFloat(ctx, current);
    current = out;
  }
  return { target: current, width: plane.width, height: plane.height };
}

/** Pixel Aberration: each channel's glow offset, the same for every octave (texels, GL rows). */
type Shifts = [[number, number], [number, number], [number, number]];

/** Accumulated linear glow over `input` (a glow-input plane), per octave list; releases nothing. */
function glowPlane(ctx: RenderContext, input: Plane, octaves: Octave[], angle: number, shifts: Shifts): Target {
  const gl = ctx.gl;
  const pyramid: Plane[] = [input];
  const need = Math.max(0, ...octaves.map(levelFor));
  for (let l = 1; l <= need; l++) {
    const prev = pyramid[l - 1];
    const width = Math.ceil(prev.width / 2);
    const height = Math.ceil(prev.height / 2);
    const target = acquireFloat(ctx, width, height, true);
    fullPass(ctx, DOWN_FS, target, [prev.target], (u) => {
      gl.uniform1i(u("u_src"), 0);
      gl.uniform2i(u("u_srcSize"), prev.width, prev.height);
    });
    pyramid.push({ target, width, height });
  }
  let acc = acquireFloat(ctx, input.width, input.height);
  let first = true;
  for (const octave of octaves) {
    const level = levelFor(octave);
    const blurred = blurOctave(ctx, pyramid[level], level, octave, angle);
    const next = acquireFloat(ctx, input.width, input.height);
    fullPass(ctx, ACCUMULATE_FS, next, [acc, blurred.target], (u) => {
      gl.uniform1i(u("u_acc"), 0);
      gl.uniform1i(u("u_level"), 1);
      gl.uniform2f(u("u_levelSize"), blurred.width, blurred.height);
      gl.uniform1f(u("u_scale"), 2 ** level);
      gl.uniform1f(u("u_weight"), octave.weight);
      gl.uniform1i(u("u_first"), first ? 1 : 0);
      gl.uniform2f(u("u_shiftR"), ...shifts[0]);
      gl.uniform2f(u("u_shiftG"), ...shifts[1]);
      gl.uniform2f(u("u_shiftB"), ...shifts[2]);
    });
    releaseFloat(ctx, acc, blurred.target);
    acc = next;
    first = false;
  }
  for (const level of pyramid.slice(1)) releaseFloat(ctx, level.target);
  return acc;
}

/** Pixel Aberration's channel pairs: which channel moves by +offset and which by -offset (diagonally). */
const ABERRATION_PAIRS: Record<number, [number, number]> = { 1: [0, 1], 2: [0, 2], 3: [1, 2] };

function deepGlow(input: LayerImage, effect: PropertyGroup, layer: Layer, time: number, ctx: RenderContext): LayerImage {
  const gl = ctx.gl;
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  if (num(P.glowMode, 1) !== 1) ctx.warn(`Deep Glow 2 "Lens Iris" mode is drawn as Exponential`);
  const radius = Math.max(0, num(P.radius, 150));
  const exposure = Math.max(0, num(P.exposure, 1));
  const aspect = Math.max(0.01, num(P.aspectRatio, 1));
  const angle = num(P.enableAngle, 0) ? (num(P.aspectAngle, 0) * Math.PI) / 180 : 0;
  const iterations = Math.round(num(P.glowIterations, 8)) || 8;
  const view = num(P.view, View.FINAL);
  const glowView = view === View.GLOW_INPUT;
  // Glow Aberration scales the radius per channel. At a reduced resolution the octaves keep their count and weights
  // (the glow its brightness) and only their widths shrink.
  const k = input.scale ?? 1;
  const multipliers = num(P.glowAberration, 0) ? [P.multiplyRed, P.multiplyGreen, P.multiplyBlue].map((p) => Math.max(0, num(p, 100)) / 100) : [1, 1, 1];
  const octavesPerChannel = multipliers.map((m) => glowOctaves(radius * m, iterations, aspect).map((o) => (k === 1 ? o : { ...o, su: o.su * k, sv: o.sv * k })));
  const reach = glowView ? 0 : Math.ceil(3 * Math.max(0, ...octavesPerChannel.flat().map((o) => Math.max(o.su, o.sv)))) + 1;

  const shifts: Shifts = [
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  if (num(P.pixelAberration, 0) && !glowView) {
    const offset = num(P.pixelOffset, 0) * k;
    const [plus, minus] = ABERRATION_PAIRS[num(P.aberrationChannels, 2)] ?? ABERRATION_PAIRS[2];
    // Texels in GL rows: a positive offset moves the first channel's glow up-left on screen.
    shifts[plus] = [offset, -offset];
    shifts[minus] = [-offset, offset];
  }
  const grow = reach + Math.ceil(Math.max(...shifts.flat().map(Math.abs)));
  const width = input.width + 2 * grow;
  const height = input.height + 2 * grow;

  const glowInput: Plane = { target: acquireFloat(ctx, width, height, true), width, height };
  fullPass(ctx, INPUT_FS, glowInput.target, [input.target], (u) => {
    gl.uniform1i(u("u_source"), 0);
    gl.uniform2i(u("u_offset"), -grow, -grow);
    gl.uniform2i(u("u_size"), input.width, input.height);
    gl.uniform1i(u("u_pad"), ctx.pad);
    gl.uniform1f(u("u_gamma"), DEEP_GLOW.gammaIn);
    gl.uniform1i(u("u_thresholdMode"), num(P.thresholdMode, 1));
    gl.uniform1f(u("u_threshold"), Math.max(0, num(P.threshold, 0)) / 100);
    gl.uniform1f(u("u_smooth"), Math.max(0, num(P.thresholdSmooth, 0)) / 100);
    gl.uniform1f(u("u_satBias"), num(P.saturationBias, 0) / 100);
  });

  const glows: Target[] = [];
  const glowFor = (channel: number): Target => {
    if (glowView) return glowInput.target;
    const same = multipliers.findIndex((m, i) => i < channel && m === multipliers[channel]);
    if (same >= 0) return glows[same];
    return glowPlane(ctx, glowInput, octavesPerChannel[channel], angle, shifts);
  };
  for (let c = 0; c < 3; c++) glows.push(glowFor(c));
  const gain: [number, number, number] = glowView ? [1, 1, 1] : [exposure, exposure, exposure];
  const tintMode = num(P.tintMode, Tint.OFF);
  if (!glowView && tintMode !== Tint.OFF) {
    // Monocolor Multiply measured on deepglow_tint_mono: the linear glow times the tint colour, per channel.
    const color = effectVector(effect, P.tintColor, layer, time, [1, 1, 1, 1]);
    const strength = Math.max(0, num(P.tintStrength, 100)) / 100;
    for (let c = 0; c < 3; c++) gain[c] *= 1 - strength + strength * (color[c] ?? 1);
    if (tintMode === Tint.DUO) ctx.warn(`Deep Glow 2 Duocolor tint is drawn with the inner colour only`);
    if (num(P.tintBlend, 1) !== 1) ctx.warn(`Deep Glow 2 tint blend modes other than Multiply are drawn as Multiply`);
  }
  const out = ctx.pool.acquire(width + 2 * ctx.pad, height + 2 * ctx.pad);
  fullPass(ctx, COMPOSITE_FS, out, [input.target, ...glows], (u) => {
    gl.uniform1i(u("u_source"), 0);
    gl.uniform1i(u("u_glowR"), 1);
    gl.uniform1i(u("u_glowG"), 2);
    gl.uniform1i(u("u_glowB"), 3);
    gl.uniform2i(u("u_offset"), -grow, -grow);
    gl.uniform2i(u("u_size"), input.width, input.height);
    gl.uniform2i(u("u_outSize"), width, height);
    gl.uniform1i(u("u_pad"), ctx.pad);
    gl.uniform3f(u("u_gain"), ...gain);
    gl.uniform1f(u("u_gamma"), DEEP_GLOW.gammaOut);
    gl.uniform1i(u("u_blend"), num(P.blendMode, Blend.SCREEN));
    gl.uniform1i(u("u_view"), view);
  });
  for (const g of new Set(glows)) if (g !== glowInput.target) releaseFloat(ctx, g);
  releaseFloat(ctx, glowInput.target);
  ctx.pool.release(input.target);
  return { target: out, width, height, origin: [input.origin[0] - grow, input.origin[1] - grow] };
}

registerEffect("PEDG2", deepGlow, { cacheable: true, scalable: true });
