// Stylize effects beyond stylize.ts: CC Threshold, CC Threshold RGB, Strobe Light, Find Edges, Emboss, Color Emboss,
// CC RepeTile, CC Kaleida, CS HexTile, CS BlockLoad and Texturize, measured against After Effects renders
// (refs/fixtures/stylize2.aep). Scatter, Roughen Edges, Brush Strokes and CC Burn Film are look-alikes: After Effects
// draws them from its own random generator and noise.
import type { Layer } from "../../aep/model.ts";
import type { LayerImage, RenderContext } from "../registry.ts";
import { FRACTAL_GLSL, FractalShape, noiseSpace, NoiseType, octaveTransform, setFractalUniforms } from "./fractal.ts";
import { copyImage } from "./fxextraUtil.ts";
import { directionVector } from "./stockMath.ts";
import { clampRect, compOf, gaussian, growRect, imageRect, layerCenter, layerPass, layerRect, registerStock, warp, type Params } from "./stockUtil.ts";

/** `body` over `input`'s pixels (layerPass, `extra` as sources 1...), releasing `input`. */
function pixelPass(ctx: RenderContext, input: LayerImage, decls: string, body: string, setUniforms?: (u: (name: string) => WebGLUniformLocation | null) => void, extra: LayerImage[] = []): LayerImage {
  const out = layerPass(ctx, imageRect(input), [input, ...extra], decls, body, setUniforms, input.scale);
  ctx.pool.release(input.target);
  return out;
}

/** Below an 8-bit level: a level equal to the threshold does not exceed it, whatever the float rounding. */
const THRESHOLD_TIE = 1e-5;

/** 8-bit levels as the 16-bit values the CC thresholds compare ((v * 32768 + 127) / 255), against Threshold * 32768
 * truncated (`threshold16`). */
const LEVEL16_GLSL = `
ivec3 level16(vec3 v) { return (ivec3(v * 255.0 + 0.5) * 32768 + 127) / 255; }`;
const threshold16 = (t: number) => Math.floor(t * 32768);

/** CC Threshold's Channel popup. */
const ThresholdChannel = { LUMINANCE: 1, RGB: 2, SATURATION: 3, ALPHA: 4 } as const;

// CC Threshold: white where the channel exceeds Threshold, black elsewhere (each of R, G, B on its own with RGB);
// Invert swaps them, Blend w. Original mixes the layer back in. Luminance compares with Threshold rounded to an
// 8-bit level, the other channels as 16-bit values.
registerStock("CC Threshold", (input, p, ctx) =>
  pixelPass(
    ctx,
    input,
    `uniform float u_threshold;
uniform int u_threshold16;
uniform int u_channel;
uniform int u_invert;
uniform float u_blend;
const vec3 THRESHOLD_LUMA = vec3(0.3039, 0.5297, 0.1664);${LEVEL16_GLSL}`,
    `  vec4 c = at(0, p);
  vec3 s = straight(c);
  if (u_channel == ${ThresholdChannel.ALPHA}) {
    float a = level16(vec3(c.a)).x > u_threshold16 ? 1.0 : 0.0;
    if (u_invert == 1) a = 1.0 - a;
    a = mix(a, c.a, u_blend);
    outColor = vec4(s * a, a);
    return;
  }
  if (c.a <= 0.0) { outColor = vec4(0.0); return; }
  ivec3 level = level16(s);
  vec3 r;
  if (u_channel == ${ThresholdChannel.RGB}) r = vec3(greaterThan(level, ivec3(u_threshold16)));
  else if (u_channel == ${ThresholdChannel.SATURATION}) r = vec3(max(level.r, max(level.g, level.b)) - min(level.r, min(level.g, level.b)) > u_threshold16);
  else r = vec3(dot(s, THRESHOLD_LUMA) > u_threshold);
  if (u_invert == 1) r = 1.0 - r;
  r = mix(r, s, u_blend);
  outColor = vec4(r * c.a, c.a);`,
    (u) => {
      ctx.gl.uniform1f(u("u_threshold"), Math.round(p.num(1, 0.5) * 255) / 255 + THRESHOLD_TIE);
      ctx.gl.uniform1i(u("u_threshold16"), threshold16(p.num(1, 0.5)));
      ctx.gl.uniform1i(u("u_channel"), p.choice(2, ThresholdChannel.LUMINANCE));
      ctx.gl.uniform1i(u("u_invert"), p.bool(3, false) ? 1 : 0);
      ctx.gl.uniform1f(u("u_blend"), Math.min(1, Math.max(0, p.num(4, 0))));
    },
  ),
);

// CC Threshold RGB: each of R, G, B white where it exceeds its own threshold as 16-bit values, each optionally
// inverted.
registerStock("CC Threshold RGB", (input, p, ctx) =>
  pixelPass(
    ctx,
    input,
    `uniform ivec3 u_threshold;
uniform vec3 u_invert;
uniform float u_blend;${LEVEL16_GLSL}`,
    `  vec4 c = at(0, p);
  if (c.a <= 0.0) { outColor = vec4(0.0); return; }
  vec3 s = straight(c);
  vec3 r = vec3(greaterThan(level16(s), u_threshold));
  r = mix(r, 1.0 - r, u_invert);
  r = mix(r, s, u_blend);
  outColor = vec4(r * c.a, c.a);`,
    (u) => {
      ctx.gl.uniform3i(u("u_threshold"), ...([1, 2, 3].map((i) => threshold16(p.num(i, 0.5))) as [number, number, number]));
      ctx.gl.uniform3f(u("u_invert"), p.bool(4, false) ? 1 : 0, p.bool(5, false) ? 1 : 0, p.bool(6, false) ? 1 : 0);
      ctx.gl.uniform1f(u("u_blend"), Math.min(1, Math.max(0, p.num(7, 0))));
    },
  ),
);

/** Strobe Light's Strobe popup. */
const StrobeKind = { COLOR: 1, TRANSPARENT: 2 } as const;
/** Strobe Light's Strobe Operator popup. */
const StrobeOperator = { COPY: 1, ADD: 2, SUBTRACT: 3, MULTIPLY: 4, DIFFERENCE: 5, AND: 6, OR: 7, XOR: 8, LIGHTER: 9, DARKER: 10, MINIMUM: 11, MAXIMUM: 12, SCREEN: 13 } as const;

/** Steps per second Strobe Light rounds Strobe Duration and Period to: this decides the frames on the boundaries. */
const STROBE_TICKS = 10000;

/** Whether Strobe Light strobes at layer time `t`: from the start of each Strobe Period until Strobe Duration before its end. */
export function strobeOn(t: number, duration: number, period: number): boolean {
  const p = Math.round(period * STROBE_TICKS);
  if (p <= 0) return false;
  return (t * STROBE_TICKS) % p < p - Math.round(duration * STROBE_TICKS);
}

// Strobe Light: during each strobe the layer's colour combined with Strobe Color by Strobe Operator (or the layer
// made transparent), mixed with the layer by Blend With Original. Time-based, so drawn every frame.
registerStock(
  "ADBE Strobe",
  (input, p, ctx, layer, time) => {
    const t = time - layer.startTime;
    if (p.num(5, 0) > 0) ctx.warn("Strobe Light: Random Strobe Probability is not rendered");
    if (!strobeOn(t, p.num(3, 0.5), p.num(4, 1))) return input;
    const blend = Math.min(1, Math.max(0, p.num(2, 0) / 100));
    return pixelPass(
      ctx,
      input,
      `uniform vec3 u_color;
uniform int u_kind;
uniform int u_op;
uniform float u_blend;
const vec3 STROBE_LUMA = vec3(0.299, 0.587, 0.114);
vec3 bits(vec3 a, vec3 b, int op) {
  ivec3 x = ivec3(floor(a * 255.0 + 0.5));
  ivec3 y = ivec3(floor(b * 255.0 + 0.5));
  ivec3 r = op == ${StrobeOperator.AND} ? (x & y) : op == ${StrobeOperator.OR} ? (x | y) : (x ^ y);
  return vec3(r) / 255.0;
}`,
      `  vec4 c = at(0, p);
  if (u_kind == ${StrobeKind.TRANSPARENT}) { outColor = c * u_blend; return; }
  if (c.a <= 0.0) { outColor = vec4(0.0); return; }
  vec3 s = straight(c);
  vec3 k = u_color;
  vec3 r;
  if (u_op == ${StrobeOperator.ADD}) r = s + k;
  else if (u_op == ${StrobeOperator.SUBTRACT}) r = s - k;
  else if (u_op == ${StrobeOperator.MULTIPLY}) r = s * k;
  else if (u_op == ${StrobeOperator.DIFFERENCE}) r = abs(s - k);
  else if (u_op == ${StrobeOperator.AND} || u_op == ${StrobeOperator.OR} || u_op == ${StrobeOperator.XOR}) r = bits(s, k, u_op);
  else if (u_op == ${StrobeOperator.LIGHTER}) r = dot(s, STROBE_LUMA) >= dot(k, STROBE_LUMA) ? s : k;
  else if (u_op == ${StrobeOperator.DARKER}) r = dot(s, STROBE_LUMA) <= dot(k, STROBE_LUMA) ? s : k;
  else if (u_op == ${StrobeOperator.MAXIMUM}) r = max(s, k);
  else if (u_op == ${StrobeOperator.MINIMUM}) r = min(s, k);
  else if (u_op == ${StrobeOperator.SCREEN}) r = s + k - s * k;
  else r = k;
  r = mix(clamp(r, 0.0, 1.0), s, u_blend);
  outColor = vec4(r * c.a, c.a);`,
      (u) => {
        ctx.gl.uniform3fv(u("u_color"), p.rgb(1, [1, 1, 1]));
        ctx.gl.uniform1i(u("u_kind"), p.choice(6, StrobeKind.COLOR));
        ctx.gl.uniform1i(u("u_op"), p.choice(7, StrobeOperator.COPY));
        ctx.gl.uniform1f(u("u_blend"), blend);
      },
    );
  },
  { cacheable: false, scalable: true },
);

// Find Edges: each channel's Sobel gradient magnitude (straight colours, edge pixels repeated), drawn dark on white
// (bright on black with Invert), mixed with the layer by Blend With Original.
registerStock("ADBE Find Edges", (input, p, ctx, layer) => {
  const box = layerRect(layer, input);
  const flat = unpremultiplied(ctx, input);
  const out = layerPass(
    ctx,
    imageRect(input),
    [input, flat],
    `uniform int u_invert;
uniform float u_blend;
${CLAMPED_AT}
#define S(q) FLAT_CLAMPED(q)`,
    `  vec4 c = at(0, p);
  if (c.a <= 0.0) { outColor = vec4(0.0); return; }
  vec3 tl = S(p + vec2(-1.0, -1.0)), t = S(p + vec2(0.0, -1.0)), tr = S(p + vec2(1.0, -1.0));
  vec3 l = S(p + vec2(-1.0, 0.0)), r = S(p + vec2(1.0, 0.0));
  vec3 bl = S(p + vec2(-1.0, 1.0)), b = S(p + vec2(0.0, 1.0)), br = S(p + vec2(1.0, 1.0));
  vec3 gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
  vec3 gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
  vec3 e = clamp(sqrt(gx * gx + gy * gy), 0.0, 1.0);
  if (u_invert == 0) e = 1.0 - e;
  vec3 o = mix(e, straight(c), u_blend);
  outColor = vec4(o * c.a, c.a);`,
    (u) => {
      ctx.gl.uniform4f(u("u_box"), box.x, box.y, box.width, box.height);
      ctx.gl.uniform1i(u("u_invert"), p.bool(1, false) ? 1 : 0);
      ctx.gl.uniform1f(u("u_blend"), Math.min(1, Math.max(0, p.num(2, 0))));
    },
    input.scale,
  );
  ctx.pool.release(flat.target);
  ctx.pool.release(input.target);
  return out;
});

/**
 * GLSL: the straight colour of source 1 (unpremultiplied) at a point held within the layer's box `u_box` (x, y,
 * width, height), so edge pixels repeat.
 */
const CLAMPED_AT = `uniform vec4 u_box;
#define FLAT_CLAMPED(q) at(1, clamp(q, u_box.xy + 0.5, u_box.xy + u_box.zw - 0.5)).rgb`;

/** `input`'s straight colours, opaque: what the effects that interpolate unpremultiplied colours read. */
function unpremultiplied(ctx: RenderContext, input: LayerImage): LayerImage {
  return layerPass(ctx, imageRect(input), [input], "", "  outColor = vec4(straight(at(0, p)), 1.0);");
}

// Emboss and Color Emboss: each channel's difference between the layer Relief pixels ahead along Direction and as
// far behind (bilinear, edge pixels repeated), times Contrast, added to mid grey (Emboss) or to the layer (Color
// Emboss), mixed with the layer by Blend With Original.
function emboss(color: boolean) {
  return (input: LayerImage, p: Params, ctx: RenderContext, layer: Layer): LayerImage => {
    const k = input.scale ?? 1;
    const [ux, uy] = directionVector(p.num(1, 45));
    const relief = Math.max(0, p.num(2, 1)) * k;
    const box = layerRect(layer, input);
    const flat = unpremultiplied(ctx, input);
    const out = layerPass(
      ctx,
      imageRect(input),
      [input, flat],
      `uniform vec2 u_step;
uniform float u_contrast;
uniform float u_blend;
uniform int u_color;
${CLAMPED_AT}`,
      `  vec4 c = at(0, p);
  if (c.a <= 0.0) { outColor = vec4(0.0); return; }
  vec3 s = straight(c);
  vec3 d = (FLAT_CLAMPED(p + u_step) - FLAT_CLAMPED(p - u_step)) * u_contrast;
  vec3 o = clamp((u_color == 1 ? s : vec3(0.5)) + d, 0.0, 1.0);
  o = mix(o, s, u_blend);
  outColor = vec4(o * c.a, c.a);`,
      (u) => {
        ctx.gl.uniform4f(u("u_box"), box.x, box.y, box.width, box.height);
        ctx.gl.uniform2f(u("u_step"), ux * relief, uy * relief);
        ctx.gl.uniform1f(u("u_contrast"), Math.max(0, p.num(3, 100)) / 100);
        ctx.gl.uniform1f(u("u_blend"), Math.min(1, Math.max(0, p.num(4, 0) / 100)));
        ctx.gl.uniform1i(u("u_color"), color ? 1 : 0);
      },
      input.scale,
    );
    ctx.pool.release(flat.target);
    ctx.pool.release(input.target);
    return out;
  };
}

registerStock("ADBE Emboss", emboss(false));
registerStock("ADBE Color Emboss", emboss(true));

/** CC RepeTile's Tiling popup. */
const Tiling = {
  REPEAT: 1,
  FLIP_H: 2,
  FLIP_V: 3,
  UNFOLD: 4,
  CHECKER_180: 5,
  FLIP_45: 6,
  CHECKER_CCW: 7,
  CHECKER_CW: 8,
  ROSETTE: 9,
  RANDOM: 10,
  NONE: 11,
  TURN_CW: 12,
  TURN_CCW: 13,
  TWIST: 14,
  SLIDE: 15,
  BRICK: 16,
} as const;

/** The tilings that turn tiles: they tile a square of the layer's shorter side from its top left corner. */
const TURNING = new Set<number>([Tiling.FLIP_45, Tiling.CHECKER_CCW, Tiling.CHECKER_CW, Tiling.ROSETTE, Tiling.RANDOM, Tiling.TURN_CW, Tiling.TURN_CCW, Tiling.TWIST]);

// CC RepeTile: the layer's box grown by Expand Right, Left, Down and Up, the new area filled with copies of the
// layer tiled by Tiling (Slide stretches the layer's edge pixels instead). Twist turns the tiles of a row by 0, 3,
// 1, 2 quarters clockwise in turn, the odd rows starting two tiles on. Random (look-alike) draws its turns and flips
// from a seeded hash; After Effects uses its own generator. Blend Tiles averages each pixel's tile with its
// neighbours (straight colours, transparent ones black), each continued past its edges mirrored: a neighbour k pixels past its edge (0 for the first pixel after a
// seam) weighs 1 - smoothstep(k / width), width a quarter of the tile times Blend Tiles.
registerStock("CC RepeTile", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const box = layerRect(layer, input);
  const [right, left, down, up] = [1, 2, 3, 4].map((i) => Math.max(0, Math.round(p.num(i, 0))) * k);
  const tiling = p.choice(5, Tiling.REPEAT);
  const blend = Math.min(1, Math.max(0, p.num(6, 0)));
  const side = Math.min(box.width, box.height);
  const tile = TURNING.has(tiling) ? { ...box, width: side, height: side } : box;
  const out = layerPass(
    ctx,
    clampRect({ x: box.x - left, y: box.y - up, width: box.width + left + right, height: box.height + up + down }),
    [input],
    `uniform vec4 u_rect;
uniform vec4 u_box;
uniform int u_tiling;
uniform vec2 u_width;${HASH_GLSL}
const int TWIST_TURNS[4] = int[4](0, 3, 1, 2);
vec2 turn(vec2 f, int quarter) {
  int q = quarter & 3;
  if (q == 1) return vec2(f.y, 1.0 - f.x);
  if (q == 2) return 1.0 - f;
  if (q == 3) return vec2(1.0 - f.y, f.x);
  return f;
}
vec2 tileSource(ivec2 c, vec2 f) {
  vec2 odd = vec2(c & 1);
  bool checker = ((c.x + c.y) & 1) == 1;
  if (u_tiling == ${Tiling.NONE} && (c.x != 0 || c.y != 0)) return vec2(-1e9);
  if (u_tiling == ${Tiling.FLIP_H} && checker) f.x = 1.0 - f.x;
  if (u_tiling == ${Tiling.FLIP_V} && checker) f.y = 1.0 - f.y;
  if (u_tiling == ${Tiling.UNFOLD}) f = mix(f, 1.0 - f, odd);
  if (u_tiling == ${Tiling.CHECKER_180} && checker) f = 1.0 - f;
  if (u_tiling == ${Tiling.FLIP_45} && checker) f = f.yx;
  if (u_tiling == ${Tiling.CHECKER_CCW} && checker) f = turn(f, 3);
  if (u_tiling == ${Tiling.CHECKER_CW} && checker) f = turn(f, 1);
  if (u_tiling == ${Tiling.ROSETTE}) f = turn(f, odd.x == 1.0 ? (odd.y == 1.0 ? 2 : 1) : (odd.y == 1.0 ? 3 : 0));
  if (u_tiling == ${Tiling.TURN_CW}) f = turn(f, c.x + c.y);
  if (u_tiling == ${Tiling.TURN_CCW}) f = turn(f, -(c.x + c.y));
  if (u_tiling == ${Tiling.TWIST}) f = turn(f, TWIST_TURNS[(c.x + 2 * (c.y & 1)) & 3]);
  if (u_tiling == ${Tiling.RANDOM}) {
    f = turn(f, int(hash21(c, 1u) * 4.0));
    if (hash21(c, 2u) > 0.5) f.x = 1.0 - f.x;
  }
  return u_rect.xy + f * u_rect.zw;
}
float rowShift(float row) { return u_tiling == ${Tiling.BRICK} ? 0.5 * mod(row, 2.0) : 0.0; }
float seamWeight(float outside, float width) { return outside <= 0.0 ? 1.0 : 1.0 - smoothstep(0.0, 1.0, outside / width); }`,
    `  if (u_tiling == ${Tiling.SLIDE}) { outColor = at(0, clamp(p, u_box.xy + 0.5, u_box.xy + u_box.zw - 0.5)); return; }
  vec2 t = (p - u_rect.xy) / u_rect.zw;
  float row = floor(t.y);
  if (u_width.x <= 0.0) {
    t.x += rowShift(row);
    vec2 cell = floor(t);
    outColor = at(0, tileSource(ivec2(cell), t - cell));
    return;
  }
  vec2 edge = 0.5 / u_rect.zw;
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (float j = -1.0; j <= 1.0; j++) {
    float r = row + j;
    float tx = t.x + rowShift(r);
    float column = floor(tx);
    for (float i = -1.0; i <= 1.0; i++) {
      vec2 f = vec2(tx - column - i, t.y - r);
      vec2 outside = max(-f * u_rect.zw + 0.5, (f - 1.0) * u_rect.zw - 0.5);
      float w = seamWeight(outside.x, u_width.x) * seamWeight(outside.y, u_width.y);
      if (w <= 0.0) continue;
      vec4 c = at(0, tileSource(ivec2(column + i, r), clamp(1.0 - abs(1.0 - abs(f)), edge, 1.0 - edge)));
      sum += w * vec4(straight(c), c.a);
      total += w;
    }
  }
  sum /= total;
  outColor = vec4(sum.rgb * sum.a, sum.a);`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform4f(u("u_rect"), tile.x, tile.y, tile.width, tile.height);
      gl.uniform4f(u("u_box"), box.x, box.y, box.width, box.height);
      gl.uniform1i(u("u_tiling"), tiling);
      gl.uniform2f(u("u_width"), (blend * tile.width) / 4, (blend * tile.height) / 4);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

/** GLSL: a hash of a lattice point and a seed, 0..1, the same on every GPU. */
const HASH_GLSL = `
float hash21(ivec2 q, uint seed) {
  uvec3 v = uvec3(uvec2(q), seed) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z;
  return float(v.x >> 8u) * (1.0 / 16777215.0);
}`;

/** CC Kaleida's Mirroring popup. */
const Mirroring = { UNFOLD: 1, WHEEL: 2, FISH_HEAD: 3, CAN_MEAS: 4, FLIP_FLOP: 5, FLOWER: 6, DIA_CROSS: 7, FLIPPER: 8, STARLISH: 9 } as const;

// CC Kaleida: the plane around the layer's centre (around Center with Floating Center) cut into squares of Size,
// each filled by mirrored and turned copies of the square's quarter up and left of Center, as Mirroring arranges
// them (Starlish folds Flower's eighths once more, into sixteenths); Rotation turns the copies about Center, not
// the squares. The layer mirrors at its edges.
registerStock("CC Kaleida", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const box = layerRect(layer, input);
  const [cx, cy] = p.vec(1, layerCenter(layer, input)).map((v) => v * k);
  const origin = p.bool(5, false) ? [cx, cy] : [box.x + box.width / 2, box.y + box.height / 2];
  const size = Math.max(1, p.num(2, 30) * k);
  const mirroring = p.choice(3, Mirroring.UNFOLD);
  const angle = (p.num(4, 0) * Math.PI) / 180;
  return warp(
    ctx,
    input,
    box,
    `uniform vec2 u_anchor;
uniform vec2 u_center;
uniform float u_cell;
uniform int u_mode;
uniform vec2 u_turn;
uniform vec4 u_box;
const float STAR_TAN = 0.41421356;
const vec2 STAR_LINE = vec2(-0.38268343, -0.92387953);
vec2 map(vec2 p) {
  vec2 d = p - u_anchor - 0.5;
  float h = 0.5 * u_cell;
  d -= u_cell * floor(d / u_cell + 0.5);
  vec2 a = abs(d);
  bool l = d.x < 0.0;
  bool t = d.y < 0.0;
  vec2 u;
  if (u_mode == ${Mirroring.WHEEL}) u = l ? (t ? d : vec2(-d.y, d.x)) : (t ? vec2(d.y, -d.x) : -d);
  else if (u_mode == ${Mirroring.FISH_HEAD}) u = l ? (t ? d.yx : vec2(-d.y, d.x)) : (t ? vec2(-d.x, d.y) : -d);
  else if (u_mode == ${Mirroring.CAN_MEAS}) u = l ? (t ? d.yx : vec2(d.x, -d.y)) : (t ? vec2(d.y, -d.x) : -d);
  else if (u_mode == ${Mirroring.FLIP_FLOP}) u = vec2(-a.x, -mod(d.y, h));
  else if (u_mode == ${Mirroring.FLOWER} || u_mode == ${Mirroring.STARLISH}) {
    u = -vec2(min(a.x, a.y), max(a.x, a.y));
    if (u_mode == ${Mirroring.STARLISH} && -u.x > STAR_TAN * -u.y) u = 2.0 * dot(u, STAR_LINE) * STAR_LINE - u;
  }
  else if (u_mode == ${Mirroring.DIA_CROSS}) u = vec2(l == t ? -min(a.x, a.y) : min(a.x, a.y), -max(a.x, a.y));
  else if (u_mode == ${Mirroring.FLIPPER}) u = t ? vec2(d.x > 0.0 ? d.x - h : d.x, d.y) : vec2(-mod(d.x, h), -d.y);
  else u = -a;
  u = vec2(u_turn.x * u.x - u_turn.y * u.y, u_turn.y * u.x + u_turn.x * u.y);
  vec2 period = 2.0 * max(u_box.zw - 1.0, 1.0);
  vec2 m = mod(u_center + u - u_box.xy, period);
  return u_box.xy + min(m, period - m) + 0.5;
}`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform2f(u("u_anchor"), origin[0], origin[1]);
      gl.uniform2f(u("u_center"), cx, cy);
      gl.uniform1f(u("u_cell"), size);
      gl.uniform1i(u("u_mode"), mirroring);
      gl.uniform2f(u("u_turn"), Math.cos(angle), Math.sin(angle));
      gl.uniform4f(u("u_box"), box.x, box.y, box.width, box.height);
    },
  );
});

/** CS HexTile's Render popup. */
const HexRender = { TILE: 1, FOLD_ALIGNED: 2, FOLD_SEAMLESSLY: 3 } as const;

// CS HexTile: a hexagonal lattice through Center (cells Radius from their centre to their flat sides, turned by
// Rotate), each cell showing the layer around Center, scaled by 1 + Smearing / 100; the Fold renders fold each cell
// onto one twelfth of it. Tile and Fold Aligned draw the cells slightly inset, with soft edges.
registerStock("CS HexTile", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const box = layerRect(layer, input);
  const [cx, cy] = p.vec(3, layerCenter(layer, input)).map((v) => v * k);
  const radius = Math.max(0.5, p.num(2, 20) * k);
  const angle = (p.num(5, 0) * Math.PI) / 180;
  if (p.bool(4, false)) ctx.warn("CS HexTile: Lock Center Tile is not rendered");
  const out = layerPass(
    ctx,
    box,
    [input],
    `uniform vec2 u_center;
uniform float u_radius;
uniform int u_render;
uniform vec2 u_turn;
uniform float u_smear;
const float SQRT3 = 1.7320508;
float hexDistance(vec2 o) { vec2 a = abs(o); return max(a.y, (SQRT3 * a.x + a.y) * 0.5); }
vec2 foldInto(vec2 o, float wedge) {
  float r = length(o);
  float th = degrees(atan(o.y, o.x));
  float f = mod(th - wedge, 60.0);
  if (f >= 30.0) f = 60.0 - f;
  return r * vec2(cos(radians(wedge + f)), sin(radians(wedge + f)));
}`,
    `  vec2 q = p - u_center;
  q = vec2(u_turn.x * q.x + u_turn.y * q.y, -u_turn.y * q.x + u_turn.x * q.y);
  float pitch = SQRT3 * u_radius;
  float i0 = floor(q.x / pitch + 0.5);
  vec2 o = q;
  float hd = 1e9;
  for (float i = i0 - 1.0; i <= i0 + 1.0; i++) {
    float j0 = floor((q.y - i * u_radius) / (2.0 * u_radius) + 0.5);
    for (float j = j0 - 1.0; j <= j0 + 1.0; j++) {
      vec2 c = q - vec2(i * pitch, i * u_radius + j * 2.0 * u_radius);
      float d = hexDistance(c);
      if (d < hd) { hd = d; o = c; }
    }
  }
  if (u_render == ${HexRender.FOLD_ALIGNED}) o = foldInto(o, 0.0);
  else if (u_render == ${HexRender.FOLD_SEAMLESSLY}) o = foldInto(o, 270.0);
  o = vec2(u_turn.x * o.x - u_turn.y * o.y, u_turn.y * o.x + u_turn.x * o.y);
  float cover = u_render == ${HexRender.FOLD_SEAMLESSLY} ? 1.0 : clamp((u_radius - hd) * 0.5 * SQRT3, 0.0, 1.0);
  outColor = at(0, u_center + o + (p - u_center) * u_smear) * cover;`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform2f(u("u_center"), cx, cy);
      gl.uniform1f(u("u_radius"), radius);
      gl.uniform1i(u("u_render"), p.choice(1, HexRender.TILE));
      gl.uniform2f(u("u_turn"), Math.cos(angle), Math.sin(angle));
      gl.uniform1f(u("u_smear"), p.num(6, 0) / 100);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

// CS BlockLoad: the layer drawn in Scans passes of square blocks, each pass half the size of the one before and
// ending in single pixels, each twice as long as the one before; a pass covers the layer block by block in rows
// from the top as Completion advances. A block shows its top left pixel (Bilinear blends those pixels between their
// own positions); blocks a pass has not reached yet show the blocks of twice its size, or nothing in the first
// pass with Start Cleared.
registerStock("CS BlockLoad", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const box = layerRect(layer, input);
  const completion = Math.min(1, Math.max(0, p.num(1, 0) / 100));
  if (completion >= 1) return input;
  const scans = Math.max(1, Math.min(16, Math.round(p.num(2, 4))));
  const done = completion * (2 ** scans - 1);
  let scan = 1;
  while (scan < scans && done >= 2 ** scan - 1) scan++;
  const progress = (done - (2 ** (scan - 1) - 1)) / 2 ** (scan - 1);
  const block = 2 ** (scans - scan) * k;
  const columns = Math.ceil(box.width / block);
  const blocks = columns * Math.ceil(box.height / block);
  return pixelPass(
    ctx,
    input,
    `uniform vec4 u_box;
uniform float u_block;
uniform float u_columns;
uniform float u_revealed;
uniform int u_first;
uniform int u_cleared;
uniform int u_bilinear;
#define BLOCK_AT(cell, b, last) at(0, u_box.xy + clamp(cell, vec2(0.0), last) * (b) + 0.5)`,
    `  vec2 q = p - u_box.xy;
  vec2 cell = floor(q / u_block);
  float b = u_block;
  if (cell.y * u_columns + cell.x >= u_revealed) {
    if (u_first == 1 && u_cleared == 1) { outColor = vec4(0.0); return; }
    b = 2.0 * u_block;
  }
  vec2 last = ceil(u_box.zw / b) - 1.0;
  if (u_bilinear == 0) { outColor = BLOCK_AT(floor(q / b), b, last); return; }
  vec2 g = (q - 0.5) / b;
  vec2 i = floor(g);
  vec2 f = g - i;
  vec4 top = mix(BLOCK_AT(i, b, last), BLOCK_AT(i + vec2(1.0, 0.0), b, last), f.x);
  vec4 bottom = mix(BLOCK_AT(i + vec2(0.0, 1.0), b, last), BLOCK_AT(i + 1.0, b, last), f.x);
  outColor = mix(top, bottom, f.y);`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform4f(u("u_box"), box.x, box.y, box.width, box.height);
      gl.uniform1f(u("u_block"), block);
      gl.uniform1f(u("u_columns"), columns);
      gl.uniform1f(u("u_revealed"), Math.floor(progress * blocks + 1e-9));
      gl.uniform1i(u("u_first"), scan === 1 ? 1 : 0);
      gl.uniform1i(u("u_cleared"), p.bool(3, true) ? 1 : 0);
      gl.uniform1i(u("u_bilinear"), p.bool(4, false) ? 1 : 0);
    },
  );
});

/** Texturize's Texture Placement popup. */
const TexturePlacement = { TILE: 1, CENTER: 2, STRETCH: 3 } as const;

// Texturize: the layer's straight colour plus Texture Contrast times the relief of the texture layer, channel by
// channel: the difference of its colour one texture pixel either way along Light Direction (bilinear), taken at its
// pixels and interpolated between them. The texture is tiled from the layer's top left corner, stretched over the
// layer (and wrapping at its edges), or placed once centred on it (transparent around). Reads another layer, so it
// is drawn every frame.
registerStock(
  "ADBE Texturize",
  (input, p, ctx, layer, time) => {
    const index = Math.round(p.num(1, 0));
    const other = index > 0 ? compOf(ctx, layer)?.layers.find((l) => l.index === index && l !== layer) : undefined;
    const texture = other ? ctx.layerImage(other, time, false) : null;
    if (!texture) return input;
    const k = input.scale ?? 1;
    const box = layerRect(layer, input);
    const textureBox = layerRect(other!, texture);
    const placement = p.choice(4, TexturePlacement.TILE);
    const [dx, dy] = directionVector(p.num(2, 135));
    const out = pixelPass(
      ctx,
      input,
      `uniform vec4 u_box;
uniform vec4 u_texture;
uniform int u_placement;
uniform vec2 u_light;
uniform float u_contrast;
#define TEXEL(q) at(1, u_texture.xy + (u_placement == ${TexturePlacement.CENTER} ? q : mod(q, u_texture.zw)) + 0.5)
#define TEXTURE_AT(s) mix(mix(TEXEL(floor(s)), TEXEL(floor(s) + vec2(1.0, 0.0)), fract(s).x), mix(TEXEL(floor(s) + vec2(0.0, 1.0)), TEXEL(floor(s) + 1.0), fract(s).x), fract(s).y)
#define RELIEF(i) (TEXTURE_AT((i) + u_light) - TEXTURE_AT((i) - u_light))
#define BILINEAR(F, s) mix(mix(F(floor(s)), F(floor(s) + vec2(1.0, 0.0)), fract(s).x), mix(F(floor(s) + vec2(0.0, 1.0)), F(floor(s) + 1.0), fract(s).x), fract(s).y)`,
      `  vec4 c = at(0, p);
  if (c.a <= 0.0) { outColor = vec4(0.0); return; }
  vec2 s = p - u_box.xy - 0.5;
  if (u_placement == ${TexturePlacement.CENTER}) s -= floor((u_box.zw - u_texture.zw) * 0.5);
  else if (u_placement == ${TexturePlacement.STRETCH}) s *= u_texture.zw / u_box.zw;
  vec3 relief = BILINEAR(RELIEF, s).rgb;
  outColor = vec4(clamp(straight(c) + u_contrast * relief, 0.0, 1.0) * c.a, c.a);`,
      (u) => {
        const gl = ctx.gl;
        gl.uniform4f(u("u_box"), box.x, box.y, box.width, box.height);
        gl.uniform4f(u("u_texture"), textureBox.x, textureBox.y, textureBox.width, textureBox.height);
        gl.uniform1i(u("u_placement"), placement);
        gl.uniform2f(u("u_light"), dx * k, dy * k);
        gl.uniform1f(u("u_contrast"), Math.max(0, p.num(3, 1)));
      },
      [texture],
    );
    ctx.pool.release(texture.target);
    return out;
  },
  { scalable: true },
);

/** Scatter's Grain popup. */
const Grain = { BOTH: 1, HORIZONTAL: 2, VERTICAL: 3 } as const;

// Scatter (look-alike): each pixel shows the layer up to half Scatter Amount pixels away, in a direction drawn
// from a seeded hash (After Effects uses its own random generator), along both axes or one; Randomize Every Frame
// draws anew each frame.
registerStock(
  "ADBE Scatter",
  (input, p, ctx, _layer, time) => {
    const k = input.scale ?? 1;
    const reach = (Math.max(0, p.num(1, 0)) / 2) * k;
    if (reach <= 0) return input;
    const grain = p.choice(2, Grain.BOTH);
    const seed = p.bool(3, false) ? Math.round(time * 1000) : 0;
    const out = layerPass(
      ctx,
      growRect(imageRect(input), grain === Grain.VERTICAL ? 0 : reach, grain === Grain.HORIZONTAL ? 0 : reach),
      [input],
      `uniform float u_reach;
uniform vec2 u_axes;
uniform uint u_seed;${HASH_GLSL}`,
      `  ivec2 c = ivec2(floor(p));
  vec2 d = vec2(hash21(c, u_seed), hash21(c, u_seed + 7919u)) * 2.0 - 1.0;
  outColor = at(0, floor(p + d * u_reach * u_axes) + 0.5);`,
      (u) => {
        ctx.gl.uniform1f(u("u_reach"), reach);
        ctx.gl.uniform2f(u("u_axes"), grain === Grain.VERTICAL ? 0 : 1, grain === Grain.HORIZONTAL ? 0 : 1);
        ctx.gl.uniform1ui(u("u_seed"), seed >>> 0);
      },
      input.scale,
    );
    ctx.pool.release(input.target);
    return out;
  },
  { scalable: true },
);

/** Roughen Edges' Edge Type popup. */
const EdgeType = { ROUGHEN: 1, ROUGHEN_COLOR: 2, CUT: 3, SPIKY: 4, RUSTY: 5, RUSTY_COLOR: 6, PHOTOCOPY: 7, PHOTOCOPY_COLOR: 8 } as const;
const COLORED_EDGES = new Set<number>([EdgeType.ROUGHEN_COLOR, EdgeType.RUSTY_COLOR, EdgeType.PHOTOCOPY_COLOR]);
/** Roughen Edges' noise cells at Scale 100 %, as a share of NOISE_CELL. */
const ROUGHEN_CELL = 0.25;

// Roughen Edges (look-alike): the layer's alpha softened over Border pixels and pushed in or out by a fractal
// noise of Scale and Complexity (After Effects' own noise is not reproduced), cut at its midpoint with Edge
// Sharpness; the colour types paint the band inside the new edge in Edge Color.
registerStock("ADBE Roughen Edges", (input, p, ctx) => {
  const k = input.scale ?? 1;
  const type = p.choice(1, EdgeType.ROUGHEN);
  const border = Math.max(0, p.num(2, 8)) * k;
  if (border <= 0) return input;
  const scale = Math.max(10, p.num(5, 100)) / 100;
  const stretch = Math.pow(2, p.num(6, 0) / 100);
  const space = noiseSpace(p.vec(7, [0, 0]), [scale * stretch * ROUGHEN_CELL, (scale / stretch) * ROUGHEN_CELL], 0, k);
  const soft = gaussian(ctx, copyImage(ctx, input), border / 2, border / 2);
  const out = layerPass(
    ctx,
    imageRect(input),
    [input, soft],
    `uniform mat3 u_space;
uniform float u_sharpness;
uniform float u_influence;
uniform int u_type;
uniform int u_colored;
uniform vec3 u_edgeColor;${FRACTAL_GLSL}`,
    `  vec4 c = at(0, p);
  float a = at(1, p).a;
  float n = fractal((u_space * vec3(p, 1.0)).xy, 0u);
  if (u_type == ${EdgeType.SPIKY}) n = 1.0 - 2.0 * abs(n - 0.5);
  if (u_type == ${EdgeType.RUSTY} || u_type == ${EdgeType.RUSTY_COLOR}) n = n * n;
  float level = a + (n - 0.5) * u_influence;
  float w = 0.05 / max(u_sharpness, 0.05);
  float cut = smoothstep(0.5 - w, 0.5 + w, level);
  if (u_type == ${EdgeType.PHOTOCOPY} || u_type == ${EdgeType.PHOTOCOPY_COLOR}) cut = step(0.5, level);
  vec4 o = c * cut;
  if (u_colored == 1 && o.a > 0.0) {
    float band = 1.0 - smoothstep(0.5, 0.9, level);
    o.rgb = mix(o.rgb, u_edgeColor * o.a, band);
  }
  outColor = o;`,
    (u) => {
      const gl = ctx.gl;
      gl.uniformMatrix3fv(u("u_space"), false, [space[0], space[1], 0, space[2], space[3], 0, space[4], space[5], 1]);
      gl.uniform1f(u("u_sharpness"), Math.max(0, p.num(3, 1)));
      gl.uniform1f(u("u_influence"), Math.min(1, Math.max(0, p.num(4, 1))));
      gl.uniform1i(u("u_type"), type);
      gl.uniform1i(u("u_colored"), COLORED_EDGES.has(type) ? 1 : 0);
      gl.uniform3fv(u("u_edgeColor"), p.rgb(10, [0.6, 0.2, 0]));
      setFractalUniforms(gl, u, {
        noiseType: NoiseType.SOFT_LINEAR,
        shape: FractalShape.BASIC,
        complexity: Math.max(1, p.num(8, 2)),
        persistence: 0.7,
        sub: octaveTransform(56, 0),
        evolution: p.num(9, 0),
        cycle: p.bool(12, false),
        revolutions: Math.max(1, p.num(13, 1)),
        seed: p.num(14, 0),
      });
    },
    input.scale,
  );
  ctx.pool.release(soft.target);
  ctx.pool.release(input.target);
  return out;
});

// CC Burn Film (look-alike): the layer scorched where a fractal noise, raised towards Center, passes a level that
// Burn lowers: darkened first, then burnt through to a bright hole. After Effects' own noise is not reproduced.
registerStock("CC Burn Film", (input, p, ctx, layer) => {
  const burn = Math.min(1, Math.max(0, p.num(1, 0) / 100));
  if (burn <= 0) return input;
  const k = input.scale ?? 1;
  const box = layerRect(layer, input);
  const [cx, cy] = p.vec(2, layerCenter(layer, input)).map((v) => v * k);
  const space = noiseSpace([0, 0], [ROUGHEN_CELL / 2, ROUGHEN_CELL / 2], 0, k);
  return pixelPass(
    ctx,
    input,
    `uniform mat3 u_space;
uniform vec2 u_center;
uniform float u_reach;
uniform float u_burn;${FRACTAL_GLSL}`,
    `  vec4 c = at(0, p);
  float v = 0.6 * fractal((u_space * vec3(p, 1.0)).xy, 0u) + 0.4 * (1.0 - distance(p, u_center) / u_reach);
  float scorch = smoothstep(1.0 - u_burn, 1.05 - u_burn, v);
  float hole = smoothstep(1.2 - u_burn, 1.25 - u_burn, v);
  vec4 o = vec4(c.rgb * (1.0 - 0.85 * scorch), c.a);
  outColor = mix(o, vec4(c.a), hole);`,
    (u) => {
      const gl = ctx.gl;
      gl.uniformMatrix3fv(u("u_space"), false, [space[0], space[1], 0, space[2], space[3], 0, space[4], space[5], 1]);
      gl.uniform2f(u("u_center"), cx, cy);
      gl.uniform1f(u("u_reach"), Math.hypot(box.width, box.height));
      gl.uniform1f(u("u_burn"), burn);
      setFractalUniforms(gl, u, {
        noiseType: NoiseType.SOFT_LINEAR,
        shape: FractalShape.BASIC,
        complexity: 4,
        persistence: 0.6,
        sub: octaveTransform(50, 0),
        evolution: 0,
        cycle: false,
        revolutions: 1,
        seed: p.num(3, 0),
      });
    },
  );
});

/** Brush Strokes' Paint Surface popup. */
const PaintSurface = { ON_ORIGINAL: 1, ON_TRANSPARENT: 2, ON_WHITE: 3, ON_BLACK: 4 } as const;

/** Samples along a stroke Brush Strokes averages. */
const STROKE_SAMPLES = 16;

// Brush Strokes (look-alike): the layer smeared along Stroke Angle over Stroke Length, in cells of Brush Size each
// with its own jittered stroke (by Stroke Randomness; After Effects places strokes by its own random generator),
// painted over the layer, transparency, white or black, mixed back with Blend With Original.
registerStock("ADBE Brush Strokes", (input, p, ctx) => {
  const k = input.scale ?? 1;
  const [ux, uy] = directionVector(p.num(1, 135));
  const size = Math.max(0.5, p.num(2, 2)) * k;
  const length = Math.max(0, p.num(3, 5)) * k;
  const surface = p.choice(6, PaintSurface.ON_ORIGINAL);
  const out = layerPass(
    ctx,
    growRect(imageRect(input), length / 2 + size),
    [input],
    `uniform vec2 u_dir;
uniform float u_brush;
uniform float u_length;
uniform float u_density;
uniform float u_randomness;
uniform int u_surface;
uniform float u_blend;${HASH_GLSL}`,
    `  vec4 base = at(0, p);
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  ivec2 cell = ivec2(floor(p / (2.0 * u_brush)));
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    ivec2 q = cell + ivec2(i, j);
    if (hash21(q, 11u) > u_density) continue;
    vec2 centre = (vec2(q) + vec2(hash21(q, 3u), hash21(q, 5u))) * 2.0 * u_brush;
    float turn = (hash21(q, 13u) - 0.5) * u_randomness;
    vec2 d = vec2(u_dir.x * cos(turn) - u_dir.y * sin(turn), u_dir.x * sin(turn) + u_dir.y * cos(turn));
    vec2 rel = p - centre;
    float along = dot(rel, d);
    float across = abs(rel.x * d.y - rel.y * d.x);
    if (abs(along) > u_length * 0.5 + u_brush || across > u_brush) continue;
    vec4 c = vec4(0.0);
    for (int s = 0; s < ${STROKE_SAMPLES}; s++) c += at(0, centre + d * ((float(s) + 0.5) / float(${STROKE_SAMPLES}) - 0.5) * u_length);
    sum += c / float(${STROKE_SAMPLES});
    wsum += 1.0;
  }
  vec4 under = u_surface == ${PaintSurface.ON_ORIGINAL} ? base : u_surface == ${PaintSurface.ON_WHITE} ? vec4(1.0) : u_surface == ${PaintSurface.ON_BLACK} ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(0.0);
  vec4 paint = wsum > 0.0 ? sum / wsum : vec4(0.0);
  vec4 o = paint + under * (1.0 - paint.a);
  outColor = mix(o, base, u_blend);`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform2f(u("u_dir"), ux, uy);
      gl.uniform1f(u("u_brush"), size);
      gl.uniform1f(u("u_length"), length);
      gl.uniform1f(u("u_density"), Math.min(1, Math.max(0, p.num(4, 1)) / 2 + 0.5));
      gl.uniform1f(u("u_randomness"), Math.max(0, p.num(5, 1)));
      gl.uniform1i(u("u_surface"), surface);
      gl.uniform1f(u("u_blend"), Math.min(1, Math.max(0, p.num(7, 0))));
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});
