// Sapphire S_Blur and S_Shake look-alikes, drawn when `RendererOptions.sapphireLookalikes` is set (the app
// sets it for its viewers and the Render Queue). Without it they are skipped, as After Effects skips them
// when the plugin is not installed, which is how the reference machine renders them. They follow the
// plugin's published parameter descriptions: there are no plugin renders to fit them to.
import type { CompItem, Layer, PropertyGroup } from "../../aep/model.ts";
import { effectNumber } from "../effectParams.ts";
import { acquireFloat, releaseFloat } from "../floatTargets.ts";
import type { Target } from "../gl.ts";
import { registerEffect, type LayerImage, type RenderContext } from "../registry.ts";
import { effectBounds } from "./boxBlur.ts";
import { shakeAt, ShakeStyle, type ShakeParams } from "./sapphireShake.ts";

type Rect = { origin: [number, number]; width: number; height: number };

// --- S_Blur -------------------------------------------------------------------------------------------
// A separable blur of premultiplied pixels whose cost does not grow with its width: wide blurs run on a
// copy halved (2x2 averages) until the kernel is a few pixels wide, then are scaled back up bilinearly.

const Filter = { BOX: 1, TRIANGLE: 2, GAUSS: 3 } as const;
/** Kernel sigma (pixels of the level it runs on) above which the image is halved first. */
const MAX_LEVEL_SIGMA = 4;
const MAX_TAPS = 64;

const LOAD_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_source;
uniform ivec2 u_offset;
uniform ivec2 u_size;
uniform ivec4 u_keep;
uniform int u_repeat;
uniform int u_pad;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (u_repeat == 1) p = clamp(p, u_keep.xy, u_keep.zw);
  ivec2 s = p + u_offset;
  outColor = (s.x < 0 || s.y < 0 || s.x >= u_size.x || s.y >= u_size.y) ? vec4(0.0) : texelFetch(u_source, s + u_pad, 0);
}`;

const HALVE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_source;
uniform ivec2 u_step;
uniform ivec2 u_inSize;
out vec4 outColor;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * u_step;
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 2; j++)
    for (int i = 0; i < 2; i++)
      if (i < u_step.x && j < u_step.y) sum += texelFetch(u_source, min(o + ivec2(i, j), u_inSize - 1), 0);
  outColor = sum / float(u_step.x * u_step.y);
}`;

const BLUR_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_source;
uniform ivec2 u_axis;
uniform int u_size;
uniform float u_radius;
uniform float u_sigma;
uniform int u_filter;
uniform int u_repeat;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int at = u_axis.x == 1 ? p.x : p.y;
  int reach = min(${MAX_TAPS}, int(ceil(u_radius)));
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -${MAX_TAPS}; i <= ${MAX_TAPS}; i++) {
    if (i < -reach || i > reach) continue;
    float d = abs(float(i));
    float w = u_filter == ${Filter.BOX} ? clamp(u_radius + 0.5 - d, 0.0, 1.0)
      : u_filter == ${Filter.TRIANGLE} ? max(0.0, 1.0 - d / (u_radius + 1.0))
      : exp(-0.5 * d * d / (u_sigma * u_sigma));
    int k = at + i;
    total += w;
    if (k < 0 || k >= u_size) {
      if (u_repeat == 0) continue;
      k = clamp(k, 0, u_size - 1);
    }
    sum += w * texelFetch(u_source, u_axis.x == 1 ? ivec2(k, p.y) : ivec2(p.x, k), 0);
  }
  outColor = sum / total;
}`;

const FINISH_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_blur;
uniform sampler2D u_source;
uniform vec2 u_blurSize;
uniform vec2 u_levelScale;
uniform ivec2 u_crop;
uniform ivec2 u_outSize;
uniform ivec2 u_srcOffset;
uniform ivec2 u_srcSize;
uniform int u_pad;
uniform float u_brightness;
uniform int u_scaleOpacity;
uniform float u_mix;
out vec4 outColor;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) - u_pad;
  if (o.x < 0 || o.y < 0 || o.x >= u_outSize.x || o.y >= u_outSize.y) { outColor = vec4(0.0); return; }
  vec4 c = texture(u_blur, (vec2(o + u_crop) + 0.5) * u_levelScale / u_blurSize);
  c.rgb *= u_brightness;
  if (u_scaleOpacity == 1) c.a *= u_brightness;
  c = clamp(c, 0.0, 1.0);
  c.rgb = min(c.rgb, vec3(c.a));
  if (u_mix > 0.0) {
    ivec2 s = o + u_srcOffset;
    vec4 src = (s.x < 0 || s.y < 0 || s.x >= u_srcSize.x || s.y >= u_srcSize.y) ? vec4(0.0) : texelFetch(u_source, s + u_pad, 0);
    c = mix(c, src, u_mix);
  }
  outColor = c;
}`;

interface Plane {
  target: Target;
  width: number;
  height: number;
}

/** Kernel along one axis: its sigma (full-resolution pixels) and the reach of the filter with that sigma. */
function kernel(width: number, filter: number): { sigma: number; reach: number } {
  // The filters share a variance, so switching filter changes the falloff and not the size.
  const sigma = Math.max(0, width) / 2;
  const reach = filter === Filter.BOX ? Math.sqrt(3) * sigma : filter === Filter.TRIANGLE ? Math.sqrt(6) * sigma : 3 * sigma;
  return { sigma, reach };
}

/** How many times an axis is halved before blurring: until the kernel is at most MAX_LEVEL_SIGMA wide. */
function halvings(sigma: number, size: number): number {
  let k = 0;
  while (sigma / 2 ** k > MAX_LEVEL_SIGMA && size / 2 ** (k + 1) >= 2) k++;
  return k;
}

function blurAxis(ctx: RenderContext, x: Plane, horizontal: boolean, sigmaFull: number, k: number, filter: number, repeat: boolean): Plane {
  // Halving and the bilinear scale back up widen the kernel by about 4^k / 4 in variance; the blur makes up the rest.
  const scale = 2 ** k;
  const sigma = Math.sqrt(Math.max(0.01, (sigmaFull / scale) ** 2 - (k ? 0.25 : 0)));
  const radius = filter === Filter.BOX ? Math.sqrt(3) * sigma : filter === Filter.TRIANGLE ? Math.sqrt(6) * sigma : 3 * sigma;
  const out = acquireFloat(ctx, x.width, x.height, true);
  ctx.pass(ctx.program(BLUR_FS), out, [x.target], (u) => {
    ctx.gl.uniform1i(u("u_source"), 0);
    ctx.gl.uniform2i(u("u_axis"), horizontal ? 1 : 0, horizontal ? 0 : 1);
    ctx.gl.uniform1i(u("u_size"), horizontal ? x.width : x.height);
    ctx.gl.uniform1f(u("u_radius"), radius);
    ctx.gl.uniform1f(u("u_sigma"), Math.max(sigma, 1e-3));
    ctx.gl.uniform1i(u("u_filter"), filter);
    ctx.gl.uniform1i(u("u_repeat"), repeat ? 1 : 0);
  });
  releaseFloat(ctx, x.target);
  return { target: out, width: x.width, height: x.height };
}

export interface SapphireBlurOptions {
  widthX: number;
  widthY: number;
  filter: number;
  /** Beyond `bounds` the edge pixels repeat and the result is cropped to them; otherwise it is transparent there. */
  repeatEdges: boolean;
  bounds?: Rect;
  brightness: number;
  scaleOpacity: boolean;
  mixWithSource: number;
}

/** S_Blur's blur of a layer image; releases `input`. */
export function sapphireBlur(ctx: RenderContext, input: LayerImage, o: SapphireBlurOptions): LayerImage {
  const gl = ctx.gl;
  const kx = kernel(o.widthX, o.filter);
  const ky = kernel(o.widthY, o.filter);
  if (kx.sigma < 0.05 && ky.sigma < 0.05 && o.brightness === 1 && !o.mixWithSource) return input;
  const base = o.bounds ?? input;
  const mx = Math.ceil(kx.reach) + 1;
  const my = Math.ceil(ky.reach) + 1;
  const width = base.width + 2 * mx;
  const height = base.height + 2 * my;
  let plane: Plane = { target: acquireFloat(ctx, width, height, true), width, height };
  ctx.pass(ctx.program(LOAD_FS), plane.target, [input.target], (u) => {
    gl.uniform1i(u("u_source"), 0);
    gl.uniform2i(u("u_offset"), base.origin[0] - mx - input.origin[0], input.height + input.origin[1] - base.origin[1] + my - height);
    gl.uniform2i(u("u_size"), input.width, input.height);
    gl.uniform4i(u("u_keep"), mx, my, mx + base.width - 1, my + base.height - 1);
    gl.uniform1i(u("u_repeat"), o.repeatEdges ? 1 : 0);
    gl.uniform1i(u("u_pad"), ctx.pad);
  });
  const levelsX = halvings(kx.sigma, width);
  const levelsY = halvings(ky.sigma, height);
  for (let level = 0; level < Math.max(levelsX, levelsY); level++) {
    const sx = level < levelsX ? 2 : 1;
    const sy = level < levelsY ? 2 : 1;
    const next: Plane = { target: acquireFloat(ctx, Math.ceil(plane.width / sx), Math.ceil(plane.height / sy), true), width: Math.ceil(plane.width / sx), height: Math.ceil(plane.height / sy) };
    ctx.pass(ctx.program(HALVE_FS), next.target, [plane.target], (u) => {
      gl.uniform1i(u("u_source"), 0);
      gl.uniform2i(u("u_step"), sx, sy);
      gl.uniform2i(u("u_inSize"), plane.width, plane.height);
    });
    releaseFloat(ctx, plane.target);
    plane = next;
  }
  if (kx.sigma >= 0.05) plane = blurAxis(ctx, plane, true, kx.sigma, levelsX, o.filter, o.repeatEdges);
  if (ky.sigma >= 0.05) plane = blurAxis(ctx, plane, false, ky.sigma, levelsY, o.filter, o.repeatEdges);
  const [cx, cy] = o.repeatEdges ? [mx, my] : [0, 0];
  const outWidth = width - 2 * cx;
  const outHeight = height - 2 * cy;
  const origin: [number, number] = [base.origin[0] - mx + cx, base.origin[1] - my + cy];
  const out = ctx.pool.acquire(outWidth + 2 * ctx.pad, outHeight + 2 * ctx.pad);
  ctx.pass(ctx.program(FINISH_FS), out, [plane.target, input.target], (u) => {
    gl.uniform1i(u("u_blur"), 0);
    gl.uniform1i(u("u_source"), 1);
    gl.uniform2f(u("u_blurSize"), plane.width, plane.height);
    gl.uniform2f(u("u_levelScale"), 1 / 2 ** levelsX, 1 / 2 ** levelsY);
    gl.uniform2i(u("u_crop"), cx, cy);
    gl.uniform2i(u("u_outSize"), outWidth, outHeight);
    gl.uniform2i(u("u_srcOffset"), origin[0] - input.origin[0], input.height + input.origin[1] - origin[1] - outHeight);
    gl.uniform2i(u("u_srcSize"), input.width, input.height);
    gl.uniform1i(u("u_pad"), ctx.pad);
    gl.uniform1f(u("u_brightness"), o.brightness);
    gl.uniform1i(u("u_scaleOpacity"), o.scaleOpacity ? 1 : 0);
    gl.uniform1f(u("u_mix"), Math.min(1, Math.max(0, o.mixWithSource)));
  });
  releaseFloat(ctx, plane.target);
  ctx.pool.release(input.target);
  return { target: out, width: outWidth, height: outHeight, origin };
}

function sBlur(input: LayerImage, effect: PropertyGroup, layer: Layer, time: number, ctx: RenderContext): LayerImage {
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  const amount = Math.max(0, num(50, 0));
  const bounds = num(59, 0) ? undefined : effectBounds(layer, input);
  return sapphireBlur(ctx, input, {
    widthX: amount * Math.max(0, num(51, 1)),
    widthY: amount * Math.max(0, num(52, 1)),
    filter: Math.round(num(55, Filter.GAUSS)),
    // Soft Borders off keeps the frame's edges solid instead of fading them into transparency.
    repeatEdges: !!bounds,
    bounds,
    brightness: num(53, 1),
    scaleOpacity: num(100, 1) !== 0,
    mixWithSource: num(101, 0),
  });
}

// --- S_Shake ------------------------------------------------------------------------------------------
// Moves, zooms and tilts the layer's image about its centre by smooth seeded noise plus regular waves
// (sapphireShake.ts), filling uncovered areas by the Wrap modes; optionally per colour channel and with
// motion blur.

const Wrap = { NONE: 1, TILE: 2, REFLECT: 3 } as const;
const MAX_BLUR_SAMPLES = 16;

const SHAKE_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_source;
uniform vec2 u_texSize;
uniform vec2 u_inOrigin;
uniform vec2 u_inSize;
uniform float u_pad;
uniform vec4 u_bounds;
uniform ivec2 u_wrap;
uniform int u_samples;
uniform int u_channels;
// Per sample and channel (sample * 3 + channel): shift x, shift y, scale, angle (radians).
uniform vec4 u_motion[${3 * MAX_BLUR_SAMPLES}];
out vec4 outColor;

float wrapped(float x, float lo, float size, int mode) {
  float t = x - lo;
  if (mode == ${Wrap.TILE}) t = mod(t, size);
  else if (mode == ${Wrap.REFLECT}) {
    float m = mod(t, 2.0 * size);
    t = m < size ? m : 2.0 * size - m;
  }
  return lo + t;
}

vec4 fetch(vec2 q) {
  q.x = wrapped(q.x, u_bounds.x, u_bounds.z, u_wrap.x);
  q.y = wrapped(q.y, u_bounds.y, u_bounds.w, u_wrap.y);
  if (q.x < u_bounds.x || q.y < u_bounds.y || q.x > u_bounds.x + u_bounds.z || q.y > u_bounds.y + u_bounds.w) return vec4(0.0);
  vec2 local = q - u_inOrigin;
  return texture(u_source, vec2(local.x + u_pad, u_inSize.y - local.y + u_pad) / u_texSize);
}

vec4 sampleAt(vec2 pos, vec4 m) {
  vec2 center = u_bounds.xy + 0.5 * u_bounds.zw;
  vec2 d = (pos - center - m.xy) / m.z;
  float c = cos(m.w);
  float s = sin(m.w);
  return fetch(center + vec2(c * d.x + s * d.y, -s * d.x + c * d.y));
}

void main() {
  vec2 frag = gl_FragCoord.xy - u_pad;
  if (frag.x < 0.0 || frag.y < 0.0 || frag.x > u_bounds.z || frag.y > u_bounds.w) { outColor = vec4(0.0); return; }
  vec2 pos = vec2(u_bounds.x + frag.x, u_bounds.y + u_bounds.w - frag.y);
  vec4 sum = vec4(0.0);
  for (int i = 0; i < ${MAX_BLUR_SAMPLES}; i++) {
    if (i >= u_samples) break;
    if (u_channels == 1) sum += sampleAt(pos, u_motion[i * 3]);
    else {
      vec4 r = sampleAt(pos, u_motion[i * 3]);
      vec4 g = sampleAt(pos, u_motion[i * 3 + 1]);
      vec4 b = sampleAt(pos, u_motion[i * 3 + 2]);
      sum += vec4(r.r, g.g, b.b, max(r.a, max(g.a, b.a)));
    }
  }
  outColor = sum / float(u_samples);
}`;

const compOf = new WeakMap<Layer, CompItem | null>();

/** The comp a layer belongs to, for its frame duration. */
function containingComp(ctx: RenderContext, layer: Layer): CompItem | null {
  let comp = compOf.get(layer);
  if (comp === undefined) {
    comp = null;
    for (const item of ctx.project.items.values()) if (item.kind === "comp" && item.layers.includes(layer)) comp = item;
    compOf.set(layer, comp);
  }
  return comp;
}

function sShake(input: LayerImage, effect: PropertyGroup, layer: Layer, time: number, ctx: RenderContext): LayerImage {
  const num = (index: number, fallback: number) => effectNumber(effect, index, layer, time, fallback);
  const axis = (first: number): [number, number, number, number, number] => [num(first, 0), num(first + 1, 1), num(first + 2, 0), num(first + 3, 0.5), num(first + 4, 0)];
  const p: ShakeParams = {
    style: Math.round(num(1, ShakeStyle.NORMAL)),
    amplitude: num(50, 1),
    frequency: num(51, 8),
    phase: num(52, 0),
    stillness: num(110, 0.7),
    twitchFrequency: num(111, 2),
    drift: num(113, 0.3),
    centerBias: num(114, 0),
    zDist: Math.max(0.001, num(53, 1)),
    seed: num(56, 0),
    axes: [axis(59), axis(64), axis(69), axis(74)],
    rgbRandomness: num(106, 0),
    rgbFrequency: num(107, 2),
  };
  const amplitudes = [num(100, 1), num(101, 1), num(102, 1)];
  const phases = [num(103, 0), num(104, 0), num(105, 0)];
  const split = p.rgbRandomness !== 0 || amplitudes.some((a) => a !== amplitudes[0]) || phases.some((ph) => ph !== phases[0]);
  const fps = containingComp(ctx, layer)?.frameRate || 30;
  const samples = num(54, 0) ? MAX_BLUR_SAMPLES : 1;
  const span = samples > 1 ? num(55, 1) / fps : 0;
  const motion = new Float32Array(4 * 3 * MAX_BLUR_SAMPLES);
  let still = true;
  for (let s = 0; s < samples; s++) {
    const t = time + (samples > 1 ? (s / (samples - 1) - 0.5) * span : 0);
    for (let c = 0; c < 3; c++) {
      const m = shakeAt(p, t, split ? { amplitude: amplitudes[c], phase: phases[c], stream: 101 + 13 * c } : { amplitude: amplitudes[0], phase: phases[0], stream: 0 });
      motion.set(m, 4 * (3 * s + c));
      still &&= !m[0] && !m[1] && m[2] === 1 && !m[3];
    }
  }
  if (still) return input;
  const bounds: Rect = effectBounds(layer, input) ?? input;
  const out = ctx.pool.acquire(bounds.width + 2 * ctx.pad, bounds.height + 2 * ctx.pad);
  ctx.pass(ctx.program(SHAKE_FS), out, [input.target], (u) => {
    const gl = ctx.gl;
    gl.uniform1i(u("u_source"), 0);
    gl.uniform2f(u("u_texSize"), input.target.width, input.target.height);
    gl.uniform2f(u("u_inOrigin"), input.origin[0], input.origin[1]);
    gl.uniform2f(u("u_inSize"), input.width, input.height);
    gl.uniform1f(u("u_pad"), ctx.pad);
    gl.uniform4f(u("u_bounds"), bounds.origin[0], bounds.origin[1], bounds.width, bounds.height);
    gl.uniform2i(u("u_wrap"), Math.round(num(57, Wrap.REFLECT)), Math.round(num(58, Wrap.REFLECT)));
    gl.uniform1i(u("u_samples"), samples);
    gl.uniform1i(u("u_channels"), split ? 3 : 1);
    gl.uniform4fv(u("u_motion"), motion);
  });
  ctx.pool.release(input.target);
  return { target: out, width: bounds.width, height: bounds.height, origin: [bounds.origin[0], bounds.origin[1]] };
}

const EFFECTS: [string, string, typeof sBlur][] = [
  ["S_Blur", "Sapphire S_Blur", sBlur],
  ["S_Shake", "Sapphire S_Shake", sShake],
];

for (const [matchName, name, render] of EFFECTS) {
  registerEffect(matchName, (input, effect, layer, time, ctx) => {
    if (!ctx.options.sapphireLookalikes) {
      ctx.warn(`${name} plugin is not installed; After Effects skips it`);
      return input;
    }
    ctx.warn(`${name} plugin is not installed; drawn with a look-alike`);
    return render(input, effect, layer, time, ctx);
  });
}
