// Stock Channel and Utility effects: Set Channels, Channel Combiner, Arithmetic, Compound Arithmetic, Blend,
// Calculations, Solid Composite, CC Composite, Grow Bounds, Cineon Converter, CC Overbrights, HDR Compander and
// HDR Highlight Compression, measured against After Effects renders of the channel fixtures. The layer
// parameters read another layer's source (the layer's own input when none is chosen), centred on the layer or
// stretched over its box; effects that read another layer are drawn every frame.
import type { Layer } from "../../aep/model.ts";
import { acquireFloat, releaseFloat } from "../floatTargets.ts";
import type { Target } from "../gl.ts";
import type { LayerImage, RenderContext } from "../registry.ts";
import { BlendMode } from "../shaders.ts";
import { grown, mapPass, PASS_HEADER, type Uniforms } from "./fxextraUtil.ts";
import { COLOR_LIB, compOf, imageRect, layerPass, layerRect, registerStock } from "./stockUtil.ts";

const LIVE = { cacheable: false, scalable: true };

/** Another layer of the comp chosen by a layer parameter (its index), never the layer itself. */
function chosenLayer(ctx: RenderContext, layer: Layer, index: number): Layer | undefined {
  const i = Math.round(index);
  return i > 0 ? compOf(ctx, layer)?.layers.find((l) => l.index === i && l !== layer) : undefined;
}

interface Second {
  image: LayerImage;
  /** Second image's layer point = scale * layer point + offset, per axis. */
  scale: [number, number];
  offset: [number, number];
  owned: boolean;
  /** Pixel centres a stretched layer's reads stay within (x0, y0, x1, y1): its edges extend instead of fading out. */
  clampTo?: [number, number, number, number];
}

interface Placement {
  /** Where the second layer goes when it is not stretched over the layer's box. */
  unstretched?: "center" | "topLeft";
  /** Whether a stretched second layer's edges extend (else they fade into transparency like bilinear reads). */
  clampEdges?: boolean;
}

/**
 * The image a layer parameter names: the other layer's source stretched over the layer's box, or else centred on it
 * or at its top left; the effect's own input when none is chosen. Null when the other layer draws nothing.
 */
function secondImage(ctx: RenderContext, layer: Layer, input: LayerImage, index: number, stretch: boolean, time: number, { unstretched = "center", clampEdges = false }: Placement = {}): Second | null {
  const other = chosenLayer(ctx, layer, index);
  if (!other) return { image: input, scale: [1, 1], offset: [0, 0], owned: false };
  const image = ctx.layerImage(other, time, false);
  if (!image) return null;
  const k = input.scale ?? 1;
  const mk = image.scale ?? 1;
  const rect = layerRect(layer, input);
  const mrect = layerRect(other, image);
  const scale: [number, number] = stretch ? [mrect.width / rect.width, mrect.height / rect.height] : [mk / k, mk / k];
  const offset: [number, number] =
    !stretch && unstretched === "topLeft"
      ? [mrect.x - rect.x * scale[0], mrect.y - rect.y * scale[1]]
      : [mrect.x + mrect.width / 2 - (rect.x + rect.width / 2) * scale[0], mrect.y + mrect.height / 2 - (rect.y + rect.height / 2) * scale[1]];
  const clampTo: Second["clampTo"] = stretch && clampEdges ? [mrect.x + 0.5, mrect.y + 0.5, mrect.x + mrect.width - 0.5, mrect.y + mrect.height - 0.5] : undefined;
  return { image, scale, offset, owned: true, clampTo };
}

function release(ctx: RenderContext, ...seconds: (Second | null)[]): void {
  const done = new Set<LayerImage>();
  for (const s of seconds) {
    if (!s?.owned || done.has(s.image)) continue;
    done.add(s.image);
    ctx.pool.release(s.image.target);
  }
}

const SECOND_UNIFORMS = (n: number) => `uniform vec2 u_scale${n};\nuniform vec2 u_offset${n};\nuniform vec4 u_clamp${n};\n`;

/** GLSL for second layer n's image point under layer point p. */
const secondPoint = (n: number) => `clamp(p * u_scale${n} + u_offset${n}, u_clamp${n}.xy, u_clamp${n}.zw)`;

function bindSecond(gl: WebGL2RenderingContext, u: (name: string) => WebGLUniformLocation | null, n: number, s: Second): void {
  gl.uniform2f(u(`u_scale${n}`), s.scale[0], s.scale[1]);
  gl.uniform2f(u(`u_offset${n}`), s.offset[0], s.offset[1]);
  const [x0, y0, x1, y1] = s.clampTo ?? [-1e9, -1e9, 1e9, 1e9];
  gl.uniform4f(u(`u_clamp${n}`), x0, y0, x1, y1);
}

/** A pass over the input's pixels reading the input (source 0) and `seconds` (sources 1..), each at its own placement. */
function withSeconds(ctx: RenderContext, input: LayerImage, seconds: Second[], decls: string, body: string, setUniforms?: Uniforms): LayerImage {
  const images = [input];
  const slots: number[] = [];
  for (const s of seconds) {
    let i = images.indexOf(s.image);
    if (i < 0) i = images.push(s.image) - 1;
    slots.push(i);
  }
  const reads = seconds
    .map((_, n) => `vec4 second${n}(vec2 p) { return at(${slots[n]}, ${secondPoint(n)}); }`)
    .join("\n");
  const out = layerPass(
    ctx,
    imageRect(input),
    images,
    `${seconds.map((_, n) => SECOND_UNIFORMS(n)).join("")}${CHANNEL_LIB}${decls}\nvec4 at(int i, vec2 q);\n${reads}`,
    body,
    (u) => {
      seconds.forEach((s, n) => bindSecond(ctx.gl, u, n, s));
      setUniforms?.(u);
    },
    input.scale,
  );
  return out;
}

/**
 * GLSL: `straight8(c)`, the 8-bit straight colour After Effects' integer operations read from a premultiplied pixel:
 * the quotient rounded up (premultiplied 88 at alpha 128 reads 176).
 */
const STRAIGHT8 = `
ivec3 straight8(vec4 c) {
  if (c.a <= 0.0) return ivec3(0);
  vec3 p = floor(c.rgb * 255.0 + 0.5);
  float a = floor(c.a * 255.0 + 0.5);
  return ivec3(min(vec3(255.0), ceil(p * 255.0 / a - 1e-3)));
}`;

const CHANNEL_LIB = STRAIGHT8;

// --- Set Channels -----------------------------------------------------------------------------------------------

/** Set Channels' and Set Matte's channel popup. */
const Channel = { RED: 1, GREEN: 2, BLUE: 3, ALPHA: 4, LUMINANCE: 5, HUE: 6, LIGHTNESS: 7, SATURATION: 8, FULL: 9, OFF: 10 } as const;

const CHANNEL_VALUE = `
float channelValue(int channel, vec4 c) {
  vec3 s = straight(c);
  if (channel == ${Channel.RED}) return s.r;
  if (channel == ${Channel.GREEN}) return s.g;
  if (channel == ${Channel.BLUE}) return s.b;
  if (channel == ${Channel.ALPHA}) return c.a;
  if (channel == ${Channel.LUMINANCE}) return luma(s);
  vec3 hsl = rgb2hsl(s);
  if (channel == ${Channel.HUE}) return hsl.x;
  if (channel == ${Channel.LIGHTNESS}) return hsl.z;
  // Saturation here is HSL's times (1 - |2L - 1|)^2: the chroma times 1 - |2L - 1|.
  float mx = max(s.r, max(s.g, s.b));
  float mn = min(s.r, min(s.g, s.b));
  if (channel == ${Channel.SATURATION}) return (mx - mn) * (1.0 - abs(mx + mn - 1.0));
  if (channel == ${Channel.FULL}) return 1.0;
  return 0.0;
}`;

// Set Channels: each of the layer's channels from a channel of a source layer (the layer itself when none is chosen).
registerStock(
  "ADBE Set Channels",
  (input, p, ctx, layer, time) => {
    const stretch = p.bool(9, true);
    const seconds: Second[] = [];
    for (let c = 0; c < 4; c++) {
      const s = secondImage(ctx, layer, input, p.num(1 + 2 * c, 0), stretch, time);
      seconds.push(s ?? { image: input, scale: [1, 1], offset: [0, 0], owned: false });
    }
    const channels = [0, 1, 2, 3].map((c) => Math.round(p.num(2 + 2 * c, c + 1)));
    const empty = seconds.map((s, c) => (s.image === input && chosenLayer(ctx, layer, p.num(1 + 2 * c, 0)) ? 1 : 0));
    const out = withSeconds(
      ctx,
      input,
      seconds,
      `${CHANNEL_VALUE}
uniform ivec4 u_channels;
uniform ivec4 u_empty;`,
      `  vec4 v = vec4(
    u_empty.x == 1 ? 0.0 : channelValue(u_channels.x, second0(p)),
    u_empty.y == 1 ? 0.0 : channelValue(u_channels.y, second1(p)),
    u_empty.z == 1 ? 0.0 : channelValue(u_channels.z, second2(p)),
    u_empty.w == 1 ? 0.0 : channelValue(u_channels.w, second3(p)));
  outColor = vec4(v.rgb * v.a, v.a);`,
      (u) => {
        ctx.gl.uniform4i(u("u_channels"), channels[0], channels[1], channels[2], channels[3]);
        ctx.gl.uniform4i(u("u_empty"), empty[0], empty[1], empty[2], empty[3]);
      },
    );
    release(ctx, ...seconds);
    ctx.pool.release(input.target);
    return out;
  },
  LIVE,
);

// --- Channel Combiner -------------------------------------------------------------------------------------------

/** Channel Combiner's From popup (stored values, separators counted). */
const From = {
  RGB_TO_HLS: 1, HLS_TO_RGB: 2, RGB_TO_YUV: 3, YUV_TO_RGB: 4, STRAIGHT_TO_PREMUL: 5,
  RED: 7, GREEN: 8, BLUE: 9, ALPHA: 10, HUE: 12, LIGHTNESS: 13, LUMINANCE: 14, SATURATION: 15, SATURATION_MULTIPLIED: 16, MIN: 18, MAX: 19,
} as const;

/** Channel Combiner's To popup (stored values, separators counted). */
const To = { RED: 1, GREEN: 2, BLUE: 3, ALPHA: 4, HUE: 6, LIGHTNESS: 7, SATURATION: 8, RED_ONLY: 10, GREEN_ONLY: 11, BLUE_ONLY: 12, ALPHA_ONLY: 13, HUE_ONLY: 15, LIGHTNESS_ONLY: 16, SATURATION_ONLY: 17 } as const;

registerStock(
  "ADBE Channel Combiner",
  (input, p, ctx, layer, time) => {
    const second = p.bool(2, false) ? secondImage(ctx, layer, input, p.num(3, 0), true, time) : null;
    const source = second ?? { image: input, scale: [1, 1] as [number, number], offset: [0, 0] as [number, number], owned: false };
    const out = withSeconds(
      ctx,
      input,
      [source],
      `uniform int u_from;
uniform int u_to;
uniform int u_invert;
uniform int u_solid;
// BT.601 at studio range: Y over 16..235, U and V about 128.
const mat3 TO_YUV = mat3(0.25679, -0.14822, 0.43922, 0.50413, -0.29099, -0.36779, 0.09791, 0.43922, -0.07143);
const vec3 YUV_OFFSET = vec3(16.0, 127.5, 127.5) / 255.0;
const mat3 FROM_YUV = mat3(1.16438, 1.16438, 1.16438, 0.0, -0.39176, 2.01723, 1.59603, -0.81297, 0.0);`,
      `  vec4 c = at(0, p);
  vec4 m = second0(p);
  vec3 s = straight(c);
  vec3 ms = straight(m);
  vec3 rgb = s;
  float a = u_solid == 1 ? 1.0 : c.a;
  if (u_from <= ${From.STRAIGHT_TO_PREMUL}) {
    // Invert inverts the result of the conversions to HLS and YUV, and the input of those back to RGB.
    bool toRgb = u_from == ${From.HLS_TO_RGB} || u_from == ${From.YUV_TO_RGB};
    vec3 x = u_invert == 1 && toRgb ? 1.0 - ms : ms;
    if (u_from == ${From.RGB_TO_HLS}) { vec3 hsl = rgb2hsl(x); rgb = vec3(hsl.x, hsl.z, hsl.y); }
    else if (u_from == ${From.HLS_TO_RGB}) rgb = hsl2rgb(vec3(x.r, x.b, x.g));
    else if (u_from == ${From.RGB_TO_YUV}) rgb = TO_YUV * x + YUV_OFFSET;
    else if (u_from == ${From.YUV_TO_RGB}) rgb = FROM_YUV * (x - vec3(16.0, 128.0, 128.0) / 255.0);
    // Inverted, Straight to Premultiplied divides by the alpha instead (white where there is none).
    else if (u_invert == 1) rgb = m.a > 0.0 ? ms / m.a : vec3(1.0);
    else rgb = ms * m.a;
    if (u_invert == 1 && !toRgb && u_from != ${From.STRAIGHT_TO_PREMUL}) rgb = 1.0 - rgb;
  } else {
    vec3 hsl = rgb2hsl(ms);
    float v;
    if (u_from == ${From.RED}) v = ms.r;
    else if (u_from == ${From.GREEN}) v = ms.g;
    else if (u_from == ${From.BLUE}) v = ms.b;
    else if (u_from == ${From.ALPHA}) v = m.a;
    else if (u_from == ${From.HUE}) v = hsl.x;
    else if (u_from == ${From.LIGHTNESS}) v = hsl.z;
    else if (u_from == ${From.LUMINANCE}) v = luma(ms);
    else if (u_from == ${From.SATURATION}) v = hsl.y;
    else if (u_from == ${From.SATURATION_MULTIPLIED}) v = max(ms.r, max(ms.g, ms.b)) - min(ms.r, min(ms.g, ms.b));
    else if (u_from == ${From.MIN}) v = min(ms.r, min(ms.g, ms.b));
    else v = max(ms.r, max(ms.g, ms.b));
    v = floor(clamp(v, 0.0, 1.0) * 255.0 + 0.5) / 255.0;
    if (u_invert == 1) v = 1.0 - v;
    vec3 own = rgb2hsl(s);
    if (u_to == ${To.RED}) rgb.r = v;
    else if (u_to == ${To.GREEN}) rgb.g = v;
    else if (u_to == ${To.BLUE}) rgb.b = v;
    else if (u_to == ${To.ALPHA}) a = v;
    else if (u_to == ${To.HUE}) rgb = hsl2rgb(vec3(v, own.y, own.z));
    else if (u_to == ${To.LIGHTNESS}) rgb = hsl2rgb(vec3(own.x, own.y, v));
    else if (u_to == ${To.SATURATION}) rgb = hsl2rgb(vec3(own.x, v, own.z));
    else if (u_to == ${To.RED_ONLY}) rgb = vec3(v, 0.0, 0.0);
    else if (u_to == ${To.GREEN_ONLY}) rgb = vec3(0.0, v, 0.0);
    else if (u_to == ${To.BLUE_ONLY}) rgb = vec3(0.0, 0.0, v);
    else if (u_to == ${To.ALPHA_ONLY}) { rgb = vec3(1.0); a = v; }
    else if (u_to == ${To.HUE_ONLY}) rgb = hsl2rgb(vec3(v, 1.0, 0.5));
    else if (u_to == ${To.LIGHTNESS_ONLY}) rgb = vec3(v);
    else rgb = hsl2rgb(vec3(0.0, v, 0.5));
  }
  rgb = clamp(rgb, 0.0, 1.0);
  outColor = vec4(rgb * a, a);`,
      (u) => {
        const gl = ctx.gl;
        gl.uniform1i(u("u_from"), Math.round(p.num(5, From.RGB_TO_HLS)));
        gl.uniform1i(u("u_to"), Math.round(p.num(6, To.LIGHTNESS)));
        gl.uniform1i(u("u_invert"), p.bool(7, false) ? 1 : 0);
        gl.uniform1i(u("u_solid"), p.bool(8, false) ? 1 : 0);
      },
    );
    release(ctx, second);
    ctx.pool.release(input.target);
    return out;
  },
  LIVE,
);

// --- Arithmetic -------------------------------------------------------------------------------------------------

const Arith = { AND: 1, OR: 2, XOR: 3, ADD: 4, SUBTRACT: 5, DIFFERENCE: 6, MIN: 7, MAX: 8, BLOCK_ABOVE: 9, BLOCK_BELOW: 10, SLICE: 11, MULTIPLY: 12, SCREEN: 13 } as const;

const ARITHMETIC_FS = `${PASS_HEADER}${COLOR_LIB}${STRAIGHT8}
uniform int u_op;
uniform ivec3 u_value;
uniform int u_clip;
int arith(int c, int v) {
  if (u_op == ${Arith.AND}) return c & v;
  if (u_op == ${Arith.OR}) return c | v;
  if (u_op == ${Arith.XOR}) return c ^ v;
  if (u_op == ${Arith.ADD}) return c + v;
  if (u_op == ${Arith.SUBTRACT}) return c - v;
  if (u_op == ${Arith.DIFFERENCE}) return abs(c - v);
  // After Effects' Min keeps the larger of channel and value, its Max the smaller.
  if (u_op == ${Arith.MIN}) return max(c, v);
  if (u_op == ${Arith.MAX}) return min(c, v);
  if (u_op == ${Arith.BLOCK_ABOVE}) return c > v ? 0 : c;
  // Block Below blocks the value itself too, Block Above does not.
  if (u_op == ${Arith.BLOCK_BELOW}) return c <= v ? 0 : c;
  if (u_op == ${Arith.SLICE}) return c > v ? 255 : 0;
  if (u_op == ${Arith.MULTIPLY}) return (c * v + 127) / 255;
  return 255 - ((255 - c) * (255 - v) + 127) / 255;
}
int wrap(int v) { return u_clip == 1 ? clamp(v, 0, 255) : ((v % 256) + 256) % 256; }
void main() {
  vec4 c = texture(u_source, v_uv);
  if (c.a <= 0.0) { outColor = vec4(0.0); return; }
  ivec3 s = straight8(c);
  vec3 r = vec3(wrap(arith(s.r, u_value.r)), wrap(arith(s.g, u_value.g)), wrap(arith(s.b, u_value.b))) / 255.0;
  outColor = vec4(r * c.a, c.a);
}`;

registerStock("ADBE Arithmetic", (input, p, ctx) =>
  mapPass(ctx, input, ARITHMETIC_FS, (u) => {
    const gl = ctx.gl;
    gl.uniform1i(u("u_op"), Math.round(p.num(1, Arith.XOR)));
    gl.uniform3i(u("u_value"), Math.round(p.num(2, 0)), Math.round(p.num(3, 0)), Math.round(p.num(4, 0)));
    gl.uniform1i(u("u_clip"), p.bool(5, true) ? 1 : 0);
  }),
);

// --- Compound Arithmetic ------------------------------------------------------------------------------------------

const Compound = { COPY: 1, ADD: 2, SUBTRACT: 3, MULTIPLY: 4, DIFFERENCE: 5, AND: 6, OR: 7, XOR: 8, LIGHTER: 9, DARKER: 10, MIN: 11, MAX: 12, SCREEN: 13, OVERLAY: 14, HARD_LIGHT: 15 } as const;

const Overflow = { CLIP: 1, WRAP: 2, SCALE: 3 } as const;

/**
 * GLSL: Compound Arithmetic's operator on the layer's pixel c (premultiplied) and the second layer's m (straight, its
 * alpha times fade), before overflow: `vec4 compound(vec4 c, vec4 m, float fade)` (the colour channels
 * unpremultiplied, alpha last).
 */
const COMPOUND_OP = `${COLOR_LIB}${STRAIGHT8}
uniform int u_op;
uniform int u_fades;
// On 8-bit values: the keying value k below 128 multiplies as 2k, from 128 screens as 2k - 256.
float hardLight(int k, int o) {
  if (k < 128) return float(2 * k * o) / 65025.0;
  int x = 2 * k - 256;
  return (float(x + o) - float(x * o) / 255.0) / 255.0;
}
float op(float a, float b, int ia, int ib) {
  if (u_op == ${Compound.COPY}) return b;
  if (u_op == ${Compound.ADD}) return a + b;
  if (u_op == ${Compound.SUBTRACT}) return a - b;
  if (u_op == ${Compound.MULTIPLY}) return a * b;
  if (u_op == ${Compound.DIFFERENCE}) return abs(a - b);
  if (u_op == ${Compound.AND}) return float(ia & ib) / 255.0;
  if (u_op == ${Compound.OR}) return float(ia | ib) / 255.0;
  if (u_op == ${Compound.XOR}) return float(ia ^ ib) / 255.0;
  if (u_op == ${Compound.MAX}) return max(a, b);
  if (u_op == ${Compound.MIN}) return min(a, b);
  if (u_op == ${Compound.SCREEN}) return a + b - a * b;
  // Overlay keys on the second layer's value, Hard Light on the layer's own.
  if (u_op == ${Compound.OVERLAY}) return hardLight(ib, ia);
  return hardLight(ia, ib);
}
vec4 compound(vec4 c, vec4 m, float fade) {
  vec3 s = straight(c);
  vec3 t = m.rgb;
  // The stored alpha where nothing fades: a computed k / 255 can miss it by a rounding error that Wrap turns into 255.
  float ma = u_fades == 0 || fade >= 1.0 ? m.a : floor(m.a * fade * 255.0 + 0.5) / 255.0;
  ivec3 is = straight8(c);
  ivec3 it = ivec3(floor(m.rgb * 255.0 + 0.5));
  // Lighter and Darker keep the whole pixel of the lighter or darker of the two (Lighter the second layer's on a tie).
  float lt = luma(vec3(it));
  float ls = luma(vec3(is));
  if (u_op == ${Compound.LIGHTER}) return lt >= ls ? vec4(t, ma) : vec4(s, c.a);
  if (u_op == ${Compound.DARKER}) return lt < ls ? vec4(t, ma) : vec4(s, c.a);
  int ia = int(floor(c.a * 255.0 + 0.5));
  int ib = int(floor(ma * 255.0 + 0.5));
  return vec4(op(s.r, t.r, is.r, it.r), op(s.g, t.g, is.g, it.g), op(s.b, t.b, is.b, it.b), op(c.a, ma, ia, ib));
}`;

/**
 * The operator's results before overflow, unclamped, in a float image the input's size (u_extra0: the second layer,
 * aligned; u_extra1: its edge fade).
 */
const COMPOUND_RAW_FS = `${PASS_HEADER}${COMPOUND_OP}
uniform sampler2D u_extra0;
uniform sampler2D u_extra1;
void main() { outColor = compound(texture(u_source, v_uv), texture(u_extra0, v_uv), texture(u_extra1, v_uv).r); }`;

/** Each channel's minimum (u_max 0) or maximum over 8 x 8 blocks of a float image of u_from pixels. */
const MINMAX_FS = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform ivec2 u_from;
uniform int u_max;
out vec4 outColor;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * 8;
  vec4 r = texelFetch(u_source, min(o, u_from - 1), 0);
  for (int j = 0; j < 8; j++)
    for (int i = 0; i < 8; i++) {
      ivec2 q = o + ivec2(i, j);
      if (q.x >= u_from.x || q.y >= u_from.y) continue;
      vec4 v = texelFetch(u_source, q, 0);
      r = u_max == 1 ? max(r, v) : min(r, v);
    }
  outColor = r;
}`;

/** The per-channel minimum (or maximum) of a float image, as a 1 x 1 float target; releases nothing. */
function reduceMinMax(ctx: RenderContext, image: Target, max: boolean): Target {
  let from = image;
  while (from.width > 1 || from.height > 1) {
    const to = acquireFloat(ctx, Math.ceil(from.width / 8), Math.ceil(from.height / 8));
    const source = from;
    ctx.pass(ctx.program(MINMAX_FS), to, [source], (u) => {
      ctx.gl.uniform1i(u("u_source"), 0);
      ctx.gl.uniform2i(u("u_from"), source.width, source.height);
      ctx.gl.uniform1i(u("u_max"), max ? 1 : 0);
    });
    if (from !== image) releaseFloat(ctx, from);
    from = to;
  }
  return from;
}

const COMPOUND_FS = `${PASS_HEADER}${COMPOUND_OP}
uniform sampler2D u_extra0;
uniform sampler2D u_extra1;
uniform sampler2D u_extra2;
uniform sampler2D u_extra3;
uniform int u_channels;
uniform int u_overflow;
uniform float u_blend;
vec4 lo;
vec4 hi;
float over(float v, int c) {
  if (u_overflow == ${Overflow.CLIP}) return clamp(v, 0.0, 1.0);
  if (u_overflow == ${Overflow.WRAP}) return fract(v * 255.0 / 256.0) * 256.0 / 255.0;
  // Scale: each channel's results stretched to 0..1 from their range over the layer, widened to hold 0..256/255.
  float l = min(0.0, lo[c]);
  float h = max(256.0 / 255.0, hi[c]);
  return clamp((v - l) / (h - l), 0.0, 1.0);
}
void main() {
  vec4 c = texture(u_source, v_uv);
  vec4 m = texture(u_extra0, v_uv);
  if (u_overflow == ${Overflow.SCALE}) { lo = texelFetch(u_extra2, ivec2(0), 0); hi = texelFetch(u_extra3, ivec2(0), 0); }
  vec3 s = straight(c);
  vec4 v = compound(c, m, texture(u_extra1, v_uv).r);
  vec4 r = vec4(s, c.a);
  if (u_channels != 3) r.rgb = vec3(over(v.r, 0), over(v.g, 1), over(v.b, 2));
  if (u_channels != 1) r.a = over(v.a, 3);
  r = mix(r, vec4(s, c.a), u_blend);
  outColor = vec4(r.rgb * r.a, r.a);
}`;

/**
 * GLSL for a layerPass over source 0: `vec4 straightAt(vec2 q)`, `at(0, q)` with its colour unpremultiplied
 * (straight, alpha last), interpolated at full precision from each pixel's 8-bit straight colour and rounded to 8 bits
 * as After Effects resamples a stretched layer (the texture unit's weights have 8 bits, and a premultiplied 8-bit
 * result loses the colour where little alpha remains). After Effects' sample falls a hair towards the layer's top
 * left, which decides the halves a stretch by 1.5 or 1.6 lands on.
 */
const STRAIGHT_AT = `${STRAIGHT8}
vec4 straightAt(vec2 q) {
  vec2 t = uvIn(q, u_img0Origin, u_img0Height, u_img0Target) * u_img0Target;
  if (t.x < u_pad || t.y < u_pad || t.x > u_img0Target.x - u_pad || t.y > u_img0Target.y - u_pad) return vec4(0.0);
  vec2 f = t - 0.5 + vec2(-1e-4, 1e-4);
  vec2 w = fract(f);
  ivec2 i = ivec2(floor(f));
  ivec2 hi = ivec2(u_img0Target) - 1;
  vec4 a = texelFetch(u_src0, clamp(i, ivec2(0), hi), 0);
  vec4 b = texelFetch(u_src0, clamp(i + ivec2(1, 0), ivec2(0), hi), 0);
  vec4 c = texelFetch(u_src0, clamp(i + ivec2(0, 1), ivec2(0), hi), 0);
  vec4 d = texelFetch(u_src0, clamp(i + ivec2(1, 1), ivec2(0), hi), 0);
  vec4 k = vec4((1.0 - w.x) * (1.0 - w.y), w.x * (1.0 - w.y), (1.0 - w.x) * w.y, w.x * w.y) * vec4(a.a, b.a, c.a, d.a);
  float alpha = k.x + k.y + k.z + k.w;
  if (alpha <= 0.0) return vec4(0.0);
  vec3 s = (k.x * vec3(straight8(a)) + k.y * vec3(straight8(b)) + k.z * vec3(straight8(c)) + k.w * vec3(straight8(d))) / alpha;
  return vec4(floor(s + 0.5), floor(alpha * 255.0 + 0.5)) / 255.0;
}
`;

// Compound Arithmetic: the layer combined channel by channel with a second layer (stretched over the layer's box or
// at its top left), on the colour channels, the alpha or both, at 1 - Blend With Original.
registerStock(
  "ADBE Compound Arithmetic",
  (input, p, ctx, layer, time) => {
    const second = secondImage(ctx, layer, input, p.num(1, 0), p.bool(5, true), time, { unstretched: "topLeft", clampEdges: true });
    if (!second) return input;
    const bind = (u: (name: string) => WebGLUniformLocation | null) => bindSecond(ctx.gl, u, 0, second);
    // Straight colour, not premultiplied.
    const aligned = layerPass(ctx, imageRect(input), [second.image], SECOND_UNIFORMS(0) + STRAIGHT_AT, `  outColor = straightAt(${secondPoint(0)});`, bind, input.scale);
    // A stretched layer's edges keep their colour but fade out in alpha: the factor, apart so the colour keeps 8 bits.
    const fade = second.clampTo
      ? layerPass(
          ctx,
          imageRect(input),
          [second.image],
          SECOND_UNIFORMS(0),
          `  float edge = at(0, ${secondPoint(0)}).a;
  float a = at(0, p * u_scale0 + u_offset0).a;
  outColor = vec4(a >= edge ? 1.0 : a / edge);`,
          bind,
          input.scale,
        )
      : null;
    release(ctx, second);
    const op = Math.round(p.num(2, Compound.COPY));
    const overflow = Math.round(p.num(4, Overflow.CLIP));
    let lo: Target | undefined;
    let hi: Target | undefined;
    // Only Add and Subtract leave 0..1, so only their results are scaled.
    if (overflow === Overflow.SCALE && (op === Compound.ADD || op === Compound.SUBTRACT)) {
      const raw = acquireFloat(ctx, input.target.width, input.target.height);
      ctx.pass(ctx.program(COMPOUND_RAW_FS), raw, [input.target, aligned.target, (fade ?? aligned).target], (u) => {
        ctx.gl.uniform1i(u("u_source"), 0);
        ctx.gl.uniform1i(u("u_extra0"), 1);
        ctx.gl.uniform1i(u("u_extra1"), 2);
        ctx.gl.uniform1i(u("u_fades"), fade ? 1 : 0);
        ctx.gl.uniform1i(u("u_op"), op);
      });
      lo = reduceMinMax(ctx, raw, false);
      hi = reduceMinMax(ctx, raw, true);
      releaseFloat(ctx, raw);
    }
    const asImage = (target: Target): LayerImage => ({ target, width: target.width, height: target.height, origin: [0, 0] });
    const extra = [aligned, fade ?? aligned, ...(lo && hi ? [asImage(lo), asImage(hi)] : [])];
    const out = mapPass(
      ctx,
      input,
      COMPOUND_FS,
      (u) => {
        const gl = ctx.gl;
        gl.uniform1i(u("u_op"), op);
        gl.uniform1i(u("u_fades"), fade ? 1 : 0);
        gl.uniform1i(u("u_channels"), Math.round(p.num(3, 1)));
        gl.uniform1i(u("u_overflow"), lo && hi ? Overflow.SCALE : overflow === Overflow.WRAP ? Overflow.WRAP : Overflow.CLIP);
        gl.uniform1f(u("u_blend"), Math.min(1, Math.max(0, p.num(6, 0) / 100)));
      },
      extra,
    );
    releaseFloat(ctx, lo, hi);
    ctx.pool.release(aligned.target);
    if (fade) ctx.pool.release(fade.target);
    return out;
  },
  LIVE,
);

// --- Blend --------------------------------------------------------------------------------------------------------

const BlendFx = { CROSSFADE: 1, COLOR_ONLY: 2, TINT_ONLY: 3, DARKEN_ONLY: 4, LIGHTEN_ONLY: 5 } as const;

registerStock(
  "ADBE Blend",
  (input, p, ctx, layer, time) => {
    const second = secondImage(ctx, layer, input, p.num(1, 0), p.num(4, 1) === 2, time);
    if (!second) return input;
    const out = withSeconds(
      ctx,
      input,
      [second],
      `uniform int u_mode;
uniform float u_original;`,
      `  vec4 c = at(0, p);
  vec4 m = second0(p);
  vec4 r;
  if (u_mode == ${BlendFx.CROSSFADE}) r = m;
  else {
    vec3 s = straight(c);
    vec3 t = straight(m);
    vec3 v;
    // A grey second layer has no hue to give: the colour modes keep the layer's colour there.
    bool grey = max(t.r, max(t.g, t.b)) - min(t.r, min(t.g, t.b)) < 0.5 / 255.0;
    if (u_mode == ${BlendFx.COLOR_ONLY}) { vec3 a = rgb2hsl(s); vec3 b = rgb2hsl(t); v = grey ? s : hsl2rgb(vec3(b.x, b.y, a.z)); }
    else if (u_mode == ${BlendFx.TINT_ONLY}) { vec3 a = rgb2hsl(s); vec3 b = rgb2hsl(t); v = grey ? s : hsl2rgb(vec3(b.x, a.y, a.z)); }
    else if (u_mode == ${BlendFx.DARKEN_ONLY}) v = min(s, t);
    else v = max(s, t);
    // The result has the second layer's coverage, whatever the mode.
    r = vec4(v * m.a, m.a);
  }
  outColor = mix(r, c, u_original);`,
      (u) => {
        ctx.gl.uniform1i(u("u_mode"), Math.round(p.num(2, BlendFx.CROSSFADE)));
        ctx.gl.uniform1f(u("u_original"), Math.min(1, Math.max(0, p.num(3, 0))));
      },
    );
    release(ctx, second);
    ctx.pool.release(input.target);
    return out;
  },
  LIVE,
);

// --- Blend modes shared by Calculations, Solid Composite and CC Composite ----------------------------------------------

/** GLSL: `vec4 composite(vec4 src, vec4 dst, int mode)`, a premultiplied source over a backdrop in a layer blending mode (BlendMode). */
const COMPOSITE_LIB = `
float blum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = blum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - blum(c))); }
float bsat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  if (mx <= mn) return vec3(0.0);
  return (c - mn) * s / (mx - mn);
}
float colorDodge(float b, float s) { return b <= 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s))); }
float colorBurn(float b, float s) { return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s)); }
float softLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
float hardLight(float b, float s) { return s <= 0.5 ? b * 2.0 * s : 1.0 - (1.0 - b) * (1.0 - (2.0 * s - 1.0)); }
float vividLight(float b, float s) { return s <= 0.5 ? colorBurn(b, 2.0 * s) : colorDodge(b, 2.0 * s - 1.0); }
vec3 blendColor(vec3 b, vec3 s, int mode) {
  if (mode == ${BlendMode.MULTIPLY}) return b * s;
  if (mode == ${BlendMode.SCREEN}) return b + s - b * s;
  if (mode == ${BlendMode.OVERLAY}) return vec3(hardLight(s.r, b.r), hardLight(s.g, b.g), hardLight(s.b, b.b));
  if (mode == ${BlendMode.DARKEN}) return min(b, s);
  if (mode == ${BlendMode.LIGHTEN}) return max(b, s);
  if (mode == ${BlendMode.LINEAR_DODGE}) return min(b + s, vec3(1.0));
  if (mode == ${BlendMode.DIFFERENCE} || mode == ${BlendMode.CLASSIC_DIFFERENCE}) return abs(b - s);
  if (mode == ${BlendMode.EXCLUSION}) return b + s - 2.0 * b * s;
  if (mode == ${BlendMode.COLOR_DODGE} || mode == ${BlendMode.CLASSIC_COLOR_DODGE}) return vec3(colorDodge(b.r, s.r), colorDodge(b.g, s.g), colorDodge(b.b, s.b));
  if (mode == ${BlendMode.COLOR_BURN} || mode == ${BlendMode.CLASSIC_COLOR_BURN}) return vec3(colorBurn(b.r, s.r), colorBurn(b.g, s.g), colorBurn(b.b, s.b));
  if (mode == ${BlendMode.LINEAR_BURN}) return max(b + s - 1.0, vec3(0.0));
  if (mode == ${BlendMode.SOFT_LIGHT}) return vec3(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b));
  if (mode == ${BlendMode.HARD_LIGHT}) return vec3(hardLight(b.r, s.r), hardLight(b.g, s.g), hardLight(b.b, s.b));
  if (mode == ${BlendMode.LINEAR_LIGHT}) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
  if (mode == ${BlendMode.VIVID_LIGHT}) return vec3(vividLight(b.r, s.r), vividLight(b.g, s.g), vividLight(b.b, s.b));
  if (mode == ${BlendMode.PIN_LIGHT}) return mix(min(b, 2.0 * s), max(b, 2.0 * s - 1.0), step(0.5, s));
  if (mode == ${BlendMode.HARD_MIX}) return step(1.0 + 0.5 / 255.0, b + s);
  if (mode == ${BlendMode.HUE}) return setLum(setSat(s, bsat(b)), blum(b));
  if (mode == ${BlendMode.SATURATION}) return setLum(setSat(b, bsat(s)), blum(b));
  if (mode == ${BlendMode.COLOR}) return setLum(s, blum(b));
  if (mode == ${BlendMode.LUMINOSITY}) return setLum(b, blum(s));
  return s;
}
vec4 composite(vec4 src, vec4 dst, int mode) {
  if (mode == ${BlendMode.STENCIL_ALPHA}) return dst * src.a;
  if (mode == ${BlendMode.SILHOUETTE_ALPHA}) return dst * (1.0 - src.a);
  if (mode == ${BlendMode.STENCIL_LUMA}) return dst * dot(src.rgb, vec3(0.299, 0.587, 0.114));
  if (mode == ${BlendMode.SILHOUETTE_LUMA}) return dst * (1.0 - dot(src.rgb, vec3(0.299, 0.587, 0.114)));
  if (mode == ${BlendMode.ALPHA_ADD}) {
    float a = min(1.0, src.a + dst.a);
    return vec4(src.rgb + (dst.a > 0.0 ? dst.rgb / dst.a : vec3(0.0)) * (a - src.a), a);
  }
  if (mode == ${BlendMode.ADD}) return vec4(min(dst.rgb + src.rgb, vec3(1.0)), src.a + dst.a * (1.0 - src.a));
  if (mode == ${BlendMode.NORMAL} || mode == ${BlendMode.LUMINESCENT_PREMUL}) return src + dst * (1.0 - src.a);
  float a = src.a + dst.a * (1.0 - src.a);
  if (mode == ${BlendMode.CLASSIC_COLOR_BURN} || mode == ${BlendMode.CLASSIC_COLOR_DODGE} || mode == ${BlendMode.CLASSIC_DIFFERENCE}) {
    // The classic modes fill transparency with the mode's neutral colour (white for Color Burn, else black), blend, and
    // take the fill out of the result again.
    float n = mode == ${BlendMode.CLASSIC_COLOR_BURN} ? 1.0 : 0.0;
    vec3 cb = dst.rgb + n * (1.0 - dst.a);
    vec3 cs = src.rgb + n * (1.0 - src.a);
    vec3 f = mode == ${BlendMode.CLASSIC_COLOR_BURN} ? vec3(colorBurn(cb.r, cs.r), colorBurn(cb.g, cs.g), colorBurn(cb.b, cs.b))
      : mode == ${BlendMode.CLASSIC_COLOR_DODGE} ? vec3(colorDodge(cb.r, cs.r), colorDodge(cb.g, cs.g), colorDodge(cb.b, cs.b))
      : abs(cb - cs);
    return vec4(clamp(clamp(f, 0.0, 1.0) - n * (1.0 - a), 0.0, a), a);
  }
  vec3 b = dst.a > 0.0 ? dst.rgb / dst.a : vec3(0.0);
  vec3 s = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  vec3 mixed = (1.0 - dst.a) * src.rgb + (1.0 - src.a) * dst.rgb + src.a * dst.a * clamp(blendColor(b, s, mode), 0.0, 1.0);
  return vec4(mixed, a);
}`;

const B = BlendMode;

/** Calculations' Blending Mode popup (stored values, separators counted) as layer blending modes; 2 is Copy. */
const CALC_MODES: Record<number, number> = {
  1: B.NORMAL, 4: B.DARKEN, 5: B.MULTIPLY, 6: B.COLOR_BURN, 7: B.CLASSIC_COLOR_BURN, 9: B.ADD, 10: B.LIGHTEN, 11: B.SCREEN,
  12: B.COLOR_DODGE, 13: B.CLASSIC_COLOR_DODGE, 15: B.OVERLAY, 16: B.SOFT_LIGHT, 17: B.HARD_LIGHT, 18: B.LINEAR_LIGHT, 19: B.VIVID_LIGHT,
  20: B.PIN_LIGHT, 22: B.DIFFERENCE, 23: B.CLASSIC_DIFFERENCE, 24: B.EXCLUSION, 26: B.HUE, 27: B.SATURATION, 28: B.COLOR, 29: B.LUMINOSITY,
  31: B.STENCIL_ALPHA, 32: B.STENCIL_LUMA, 33: B.SILHOUETTE_ALPHA, 34: B.SILHOUETTE_LUMA, 36: B.ALPHA_ADD, 37: B.LUMINESCENT_PREMUL,
};

/** Calculations' channel popups: the image, or one channel as grey (Alpha as a grey of that coverage, inverted whole). */
const CALC_CHANNEL = `
vec4 calcChannel(vec4 c, int channel, int invert) {
  if (channel == 6) {
    float a = invert == 1 ? 1.0 - c.a : c.a;
    return vec4(a * a, a * a, a * a, a);
  }
  vec3 s = straight(c);
  vec3 v = channel == 1 ? s : vec3(channel == 2 ? luma(s) : channel == 3 ? s.r : channel == 4 ? s.g : s.b);
  if (invert == 1) v = 1.0 - v;
  return vec4(v * c.a, c.a);
}`;

registerStock(
  "ADBE Calculations",
  (input, p, ctx, layer, time) => {
    const second = secondImage(ctx, layer, input, p.num(6, 0), p.bool(10, true), time);
    const mode = Math.round(p.num(12, 1));
    const out = withSeconds(
      ctx,
      input,
      second ? [second] : [{ image: input, scale: [1, 1], offset: [0, 0], owned: false }],
      `${CALC_CHANNEL}${COMPOSITE_LIB}
uniform int u_inChannel;
uniform int u_inInvert;
uniform int u_secondChannel;
uniform int u_secondInvert;
uniform int u_hasSecond;
uniform float u_opacity;
uniform int u_mode;
uniform int u_copy;
uniform int u_preserve;`,
      `  vec4 c = at(0, p);
  vec4 base = calcChannel(c, u_inChannel, u_inInvert);
  vec4 top = u_hasSecond == 1 ? calcChannel(second0(p), u_secondChannel, u_secondInvert) * u_opacity : vec4(0.0);
  vec4 r = u_copy == 1 ? top : composite(top, base, u_mode);
  if (u_preserve == 1) r = mix(base, r, base.a);
  outColor = r;`,
      (u) => {
        const gl = ctx.gl;
        gl.uniform1i(u("u_inChannel"), Math.round(p.num(2, 1)));
        gl.uniform1i(u("u_inInvert"), p.bool(3, false) ? 1 : 0);
        gl.uniform1i(u("u_secondChannel"), Math.round(p.num(7, 1)));
        gl.uniform1i(u("u_secondInvert"), p.bool(9, false) ? 1 : 0);
        gl.uniform1i(u("u_hasSecond"), second ? 1 : 0);
        gl.uniform1f(u("u_opacity"), Math.min(1, Math.max(0, p.num(8, 0))));
        gl.uniform1i(u("u_mode"), CALC_MODES[mode] ?? B.NORMAL);
        gl.uniform1i(u("u_copy"), mode === 2 ? 1 : 0);
        gl.uniform1i(u("u_preserve"), p.bool(13, true) ? 1 : 0);
      },
    );
    release(ctx, second);
    ctx.pool.release(input.target);
    return out;
  },
  LIVE,
);

// --- Solid Composite ----------------------------------------------------------------------------------------------

/** Solid Composite's Blending Mode popup (stored values, separators counted); its Color Dodge, Color Burn and Difference
 *  are the classic modes. */
const SOLID_MODES: Record<number, number> = {
  1: B.NORMAL, 3: B.ADD, 4: B.MULTIPLY, 5: B.SCREEN, 6: B.OVERLAY, 7: B.SOFT_LIGHT, 8: B.HARD_LIGHT, 10: B.CLASSIC_COLOR_DODGE,
  11: B.CLASSIC_COLOR_BURN, 13: B.DARKEN, 14: B.LIGHTEN, 15: B.CLASSIC_DIFFERENCE, 16: B.EXCLUSION, 18: B.HUE, 19: B.SATURATION, 20: B.COLOR, 21: B.LUMINOSITY,
};

const SOLID_COMPOSITE_FS = `${PASS_HEADER}${COLOR_LIB}${COMPOSITE_LIB}
uniform float u_sourceOpacity;
uniform vec3 u_color;
uniform float u_opacity;
uniform int u_mode;
void main() {
  vec4 c = texture(u_source, v_uv) * u_sourceOpacity;
  outColor = composite(c, vec4(u_color, 1.0) * u_opacity, u_mode);
}`;

registerStock("ADBE Solid Composite", (input, p, ctx) =>
  mapPass(ctx, input, SOLID_COMPOSITE_FS, (u) => {
    const gl = ctx.gl;
    gl.uniform1f(u("u_sourceOpacity"), Math.min(1, Math.max(0, p.num(1, 100) / 100)));
    gl.uniform3fv(u("u_color"), p.rgb(2, [1, 1, 1]));
    gl.uniform1f(u("u_opacity"), Math.min(1, Math.max(0, p.num(3, 100) / 100)));
    gl.uniform1i(u("u_mode"), SOLID_MODES[Math.round(p.num(4, 1))] ?? B.NORMAL);
  }),
);

// --- CC Composite -------------------------------------------------------------------------------------------------

/** CC Composite's Composite Original popup (stored values, separators counted); 1 Copy, 2 Behind, 3 In Front.
 *  21 sits where Linear Light does in the layer modes but composites as Linear Dodge. RGB Only (keeping the effects'
 *  alpha) leaves the stencil, silhouette and luminescent modes (35 on) alone. */
const CC_MODES: Record<number, number> = {
  5: B.DARKEN, 6: B.MULTIPLY, 7: B.LINEAR_BURN, 8: B.COLOR_BURN, 9: B.CLASSIC_COLOR_BURN, 11: B.ADD, 12: B.LIGHTEN, 13: B.SCREEN,
  14: B.LINEAR_DODGE, 15: B.COLOR_DODGE, 16: B.CLASSIC_COLOR_DODGE, 18: B.OVERLAY, 19: B.SOFT_LIGHT, 20: B.HARD_LIGHT, 21: B.LINEAR_DODGE,
  22: B.VIVID_LIGHT, 23: B.PIN_LIGHT, 24: B.HARD_MIX, 26: B.DIFFERENCE, 27: B.CLASSIC_DIFFERENCE, 28: B.EXCLUSION, 30: B.HUE,
  31: B.SATURATION, 32: B.COLOR, 33: B.LUMINOSITY, 35: B.STENCIL_ALPHA, 36: B.STENCIL_LUMA, 37: B.SILHOUETTE_ALPHA, 38: B.SILHOUETTE_LUMA,
  40: B.ALPHA_ADD, 41: B.LUMINESCENT_PREMUL,
};

/** Stand-ins reading a layer's own source: the renderer gives no image of a layer while its effects render. */
const selves = new WeakMap<Layer, Layer>();

function ownSource(ctx: RenderContext, layer: Layer, time: number): LayerImage | null {
  let self = selves.get(layer);
  if (!self) selves.set(layer, (self = Object.create(layer) as Layer));
  return ctx.layerImage(self, time, false);
}

// CC Composite: the layer before its effects (its source) composited with the effects' result, at Opacity.
registerStock(
  "CC Composite",
  (input, p, ctx, layer, time) => {
    const original = ownSource(ctx, layer, time);
    if (!original) return input;
    const k = input.scale ?? 1;
    const ok = original.scale ?? 1;
    const second: Second = { image: original, scale: [ok / k, ok / k], offset: [0, 0], owned: true };
    const mode = Math.round(p.num(2, 3));
    const out = withSeconds(
      ctx,
      input,
      [second],
      `${COMPOSITE_LIB}
uniform int u_op;
uniform int u_mode;
uniform float u_opacity;
uniform int u_rgbOnly;`,
      `  vec4 c = at(0, p);
  vec4 o = second0(p) * u_opacity;
  vec4 r;
  if (u_op == 1) r = o;
  else if (u_op == 2) r = c + o * (1.0 - c.a);
  else if (u_op == 3) r = o + c * (1.0 - o.a);
  else r = composite(o, c, u_mode);
  if (u_rgbOnly == 1) r = r.a > 0.0 ? vec4(r.rgb / r.a * c.a, c.a) : vec4(0.0);
  outColor = r;`,
      (u) => {
        const gl = ctx.gl;
        gl.uniform1i(u("u_op"), mode <= 3 ? mode : 0);
        gl.uniform1i(u("u_mode"), CC_MODES[mode] ?? B.NORMAL);
        gl.uniform1f(u("u_opacity"), Math.min(1, Math.max(0, p.num(1, 100) / 100)));
        gl.uniform1i(u("u_rgbOnly"), p.bool(3, true) && mode < 35 ? 1 : 0);
      },
    );
    release(ctx, second);
    ctx.pool.release(input.target);
    return out;
  },
  LIVE,
);

// --- Grow Bounds --------------------------------------------------------------------------------------------------

/** Grow Bounds' growth (layer pixels) beyond which a texture could exceed what devices allocate. */
const MAX_GROW = 2048;

// Grow Bounds: the layer's image grown by Pixels of transparency on every side, for the effects after it.
registerStock("ADBE GROW BOUNDS", (input, p, ctx) => {
  const pixels = Math.min(MAX_GROW, Math.max(0, p.num(1, 10))) * (input.scale ?? 1);
  return input.scale === undefined ? grown(ctx, input, pixels) : { ...grown(ctx, input, pixels), scale: input.scale };
});

// --- Cineon Converter ---------------------------------------------------------------------------------------------

const Cineon = { LINEAR_TO_LOG: 1, LOG_TO_LINEAR: 2, LOG_TO_LOG: 3 } as const;

// Codes are 10-bit. Linear light is (10^((code - white) k) - o) / (1 - o), o its value at the black point, with
// k = 0.0034 / gamma; Highlight Rolloff R eases the codes from white - R to white + 2R into white - R to white.
const CINEON_FS = `${PASS_HEADER}${COLOR_LIB}
uniform int u_type;
uniform float u_black;
uniform float u_white;
uniform float u_k;
uniform float u_rolloff;
uniform float u_lo;
uniform float u_hi;
float offset() { return pow(10.0, (u_black - u_white) * u_k); }
vec3 rolled(vec3 code) {
  if (u_rolloff <= 0.0) return min(code, vec3(u_white));
  vec3 t = clamp((code - (u_white - u_rolloff)) / u_rolloff, 0.0, 3.0);
  vec3 eased = u_white - u_rolloff + u_rolloff * (1.0 - (1.0 - t / 3.0) * (1.0 - t / 3.0));
  return mix(code, eased, step(u_white - u_rolloff, code));
}
vec3 unrolled(vec3 code) {
  if (u_rolloff <= 0.0) return min(code, vec3(u_white));
  vec3 e = clamp((code - (u_white - u_rolloff)) / u_rolloff, 0.0, 1.0);
  vec3 t = 3.0 * (1.0 - sqrt(1.0 - e));
  return mix(code, u_white - u_rolloff + u_rolloff * t, step(u_white - u_rolloff, code));
}
vec3 logToLinear(vec3 code) {
  float o = offset();
  return (pow(vec3(10.0), (rolled(code) - u_white) * u_k) - o) / (1.0 - o);
}
vec3 linearToLog(vec3 lin) {
  float o = offset();
  return unrolled(u_white + log(max(lin * (1.0 - o) + o, 1e-6)) / log(10.0) / u_k);
}
void main() {
  vec4 c = texture(u_source, v_uv);
  vec3 s = straight(c);
  vec3 v;
  if (u_type == ${Cineon.LOG_TO_LINEAR}) v = mix(vec3(u_lo), vec3(u_hi), max(logToLinear(s * 1023.0), 0.0));
  else if (u_type == ${Cineon.LINEAR_TO_LOG}) v = linearToLog((s - u_lo) / max(1e-6, u_hi - u_lo)) / 1023.0;
  else {
    // Log to Log: decoded with the gamma given (without rolloff), encoded again at gamma 1, black to white as 0 to 1.
    float o = offset();
    vec3 lin = max((pow(vec3(10.0), (s * 1023.0 - u_white) * u_k) - o) / (1.0 - o), 0.0);
    float k1 = 0.0034;
    float o1 = pow(10.0, (u_black - u_white) * k1);
    vec3 code = u_white + log(lin * (1.0 - o1) + o1) / log(10.0) / k1;
    v = mix(vec3(u_lo), vec3(u_hi), clamp((code - u_black) / (u_white - u_black), 0.0, 1.0));
  }
  outColor = vec4(clamp(v, 0.0, 1.0) * c.a, c.a);
}`;

registerStock("ADBE Cineon Converter2", (input, p, ctx) =>
  mapPass(ctx, input, CINEON_FS, (u) => {
    const gl = ctx.gl;
    gl.uniform1i(u("u_type"), Math.round(p.num(1, Cineon.LOG_TO_LINEAR)));
    gl.uniform1f(u("u_black"), p.num(2, 95));
    gl.uniform1f(u("u_white"), p.num(4, 685));
    gl.uniform1f(u("u_k"), 0.0034 / Math.max(1e-3, p.num(6, 1.7)));
    gl.uniform1f(u("u_rolloff"), Math.max(0, p.num(7, 20)));
    gl.uniform1f(u("u_lo"), p.num(8, 0));
    gl.uniform1f(u("u_hi"), p.num(9, 1));
  }),
);

// --- CC Overbrights, HDR Compander, HDR Highlight Compression ------------------------------------------------------

// CC Overbrights shows or clips values above white, which 8-bit images do not hold: it leaves them unchanged.
registerStock("CC Overbrights", (input) => input);

const Compander = { COMPRESS: 1, EXPAND: 2 } as const;

const COMPANDER_FS = `${PASS_HEADER}${COLOR_LIB}
uniform int u_mode;
uniform float u_gain;
uniform float u_gamma;
void main() {
  vec4 c = texture(u_source, v_uv);
  vec3 s = straight(c);
  vec3 v = u_mode == ${Compander.COMPRESS} ? pow(s / u_gain, vec3(1.0 / u_gamma)) : pow(s, vec3(u_gamma)) * u_gain;
  outColor = vec4(clamp(v, 0.0, 1.0) * c.a, c.a);
}`;

registerStock("ADBE Compander", (input, p, ctx) =>
  mapPass(ctx, input, COMPANDER_FS, (u) => {
    const gl = ctx.gl;
    gl.uniform1i(u("u_mode"), Math.round(p.num(1, Compander.COMPRESS)));
    gl.uniform1f(u("u_gain"), Math.max(1e-6, p.num(2, 1)));
    gl.uniform1f(u("u_gamma"), Math.max(1e-6, p.num(3, 1)));
  }),
);

/** GLSL: the sRGB transfer curve and its inverse. */
const SRGB_LIB = `
vec3 srgbToLinear(vec3 v) { return mix(v / 12.92, pow((v + 0.055) / 1.055, vec3(2.4)), step(0.04045, v)); }
vec3 linearToSrgb(vec3 v) { return mix(v * 12.92, 1.055 * pow(v, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, v)); }`;

// HDR Highlight Compression: a pixel's linear light scaled by 1 / (1 + its Rec. 601 luminance), mixed in by Amount.
const HDR_TONEMAP_FS = `${PASS_HEADER}${COLOR_LIB}${SRGB_LIB}
uniform float u_amount;
void main() {
  vec4 c = texture(u_source, v_uv);
  vec3 s = straight(c);
  vec3 lin = srgbToLinear(s);
  vec3 v = linearToSrgb(lin / (1.0 + dot(lin, vec3(0.299, 0.587, 0.114))));
  outColor = vec4(mix(s, v, u_amount) * c.a, c.a);
}`;

registerStock("ADBE HDR ToneMap", (input, p, ctx) =>
  mapPass(ctx, input, HDR_TONEMAP_FS, (u) => ctx.gl.uniform1f(u("u_amount"), Math.min(1, Math.max(0, p.num(1, 100) / 100)))),
);
