// Transition effects beyond transitions.ts: Iris Wipe and Gradient Wipe. Angles are degrees clockwise from up;
// sizes are layer pixels.
import type { Layer } from "../../aep/model.ts";
import { acquireFloat, releaseFloat } from "../floatTargets.ts";
import type { LayerImage, RenderContext } from "../registry.ts";
import type { Uniforms } from "./fxextraUtil.ts";
import { directionVector, projectionRange } from "./stockMath.ts";
import { irisFeatherSigma, irisVertices } from "./transitionsExtraMath.ts";
import { COORDS, compOf, imageRect, layerCenter, layerPass, layerRect, registerStock, type Rect } from "./stockUtil.ts";

/** Vertices a polygon uniform holds at most (Iris Wipe: 16 tips and their notches). */
const MAX_VERTICES = 32;

/** GLSL: the signed distance from p to the polygon u_poly[0..u_count) (negative inside). */
const POLYGON = `
uniform vec2 u_poly[${MAX_VERTICES}];
uniform int u_count;
float polygonDistance(vec2 p) {
  float d = 1e20;
  float s = 1.0;
  for (int i = 0; i < u_count; i++) {
    vec2 a = u_poly[i];
    vec2 b = u_poly[i == 0 ? u_count - 1 : i - 1];
    vec2 e = b - a;
    vec2 w = p - a;
    vec2 q = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(q, q));
    bvec3 c = bvec3(p.y >= a.y, p.y < b.y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}
`;

/**
 * One axis of a feather: a Gaussian of sigma u_sigma truncated at u_radius taps over the float image u_source,
 * its content's edge pixels repeated.
 */
const FEATHER_FS = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform ivec2 u_step;
uniform int u_radius;
uniform float u_sigma;
uniform int u_pad;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(u_source, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -u_radius; i <= u_radius; i++) {
    float w = exp(-float(i * i) / (2.0 * u_sigma * u_sigma));
    sum += texelFetch(u_source, clamp(p + u_step * i, ivec2(u_pad), size - 1 - u_pad), 0) * w;
    total += w;
  }
  outColor = sum / total;
}`;

/**
 * The layer kept where `keep` (GLSL declaring `float keep(vec2 p)` of the layer point, 1 kept, 0 cut away, its edges
 * ramping over a pixel) says, the edges blurred to fall off as a Gaussian of `sigma` image pixels (the matte drawn on
 * beyond the image, so edges leaving it blur as they would inside). Releases `input`.
 */
function keepMatte(ctx: RenderContext, input: LayerImage, keep: string, setUniforms: Uniforms, sigma: number): LayerImage {
  const blur = Math.sqrt(Math.max(0, sigma * sigma - 1 / 12));
  if (blur < 0.2) {
    const out = layerPass(ctx, imageRect(input), [input], keep, "  outColor = at(0, p) * keep(p);", setUniforms, input.scale);
    ctx.pool.release(input.target);
    return out;
  }
  const radius = Math.ceil(3.5 * blur);
  const width = input.target.width + 2 * radius;
  const height = input.target.height + 2 * radius;
  const origin: [number, number] = [input.origin[0] - radius, input.origin[1] - radius];
  let matte = acquireFloat(ctx, width, height);
  const fragment = `#version 300 es
precision highp float;
out vec4 outColor;
${COORDS}${keep}
void main() { outColor = vec4(keep(layerPoint())); }`;
  ctx.pass(ctx.program(fragment), matte, [], (u) => {
    ctx.gl.uniform2f(u("u_size"), width, height);
    ctx.gl.uniform1f(u("u_pad"), ctx.pad);
    ctx.gl.uniform2f(u("u_origin"), origin[0], origin[1]);
    setUniforms(u);
  });
  for (const step of [
    [1, 0],
    [0, 1],
  ]) {
    const next = acquireFloat(ctx, width, height);
    ctx.pass(ctx.program(FEATHER_FS), next, [matte], (u) => {
      ctx.gl.uniform1i(u("u_source"), 0);
      ctx.gl.uniform2i(u("u_step"), step[0], step[1]);
      ctx.gl.uniform1i(u("u_radius"), radius);
      ctx.gl.uniform1f(u("u_sigma"), blur);
      ctx.gl.uniform1i(u("u_pad"), ctx.pad);
    });
    releaseFloat(ctx, matte);
    matte = next;
  }
  const blurred = { ...input, target: matte, origin, width: input.width + 2 * radius, height: input.height + 2 * radius };
  const out = layerPass(ctx, imageRect(input), [input, blurred], "", "  outColor = at(0, p) * at(1, p).r;", undefined, input.scale);
  releaseFloat(ctx, matte);
  ctx.pool.release(input.target);
  return out;
}

/** The layer a layer parameter names (by index in the layer's comp), or undefined for None or the layer itself. */
function layerParam(ctx: RenderContext, layer: Layer, index: number): Layer | undefined {
  const i = Math.round(index);
  return i > 0 ? compOf(ctx, layer)?.layers.find((l) => l.index === i && l !== layer) : undefined;
}

/** Gradient Wipe's Gradient Placement popup. */
const GradientPlacement = { TILE: 1, CENTER: 2, STRETCH: 3 } as const;

/**
 * Layer point -> point of another layer's image `map` = scale * p + offset, per axis: `map` tiled from the layer's
 * top-left corner, centred on the layer at its own size, or stretched over the layer's box (pixel i showing the
 * map's pixel i * scale, as After Effects resamples).
 */
function placement(layer: Layer, input: LayerImage, other: Layer, map: LayerImage, mode: number): { scale: number[]; offset: number[]; mapRect: Rect } {
  const rect = layerRect(layer, input);
  const mapRect = layerRect(other, map);
  const k = input.scale ?? 1;
  const mk = map.scale ?? 1;
  if (mode === GradientPlacement.STRETCH) {
    const scale = [mapRect.width / rect.width, mapRect.height / rect.height];
    const offset = [0, 1].map((i) => [mapRect.x, mapRect.y][i] - [rect.x, rect.y][i] * scale[i] + 0.5 * (1 - scale[i]));
    return { scale, offset, mapRect };
  }
  const s = mk / k;
  if (mode === GradientPlacement.CENTER)
    return { scale: [s, s], offset: [mapRect.x + mapRect.width / 2 - (rect.x + rect.width / 2) * s, mapRect.y + mapRect.height / 2 - (rect.y + rect.height / 2) * s], mapRect };
  return { scale: [s, s], offset: [mapRect.x - rect.x * s, mapRect.y - rect.y * s], mapRect };
}

// Gradient Wipe: pixels whose gradient luminance (premultiplied, in 8-bit levels L) is below the completion become
// transparent. With S = round(softness * 255) levels and T = floor(completion * (255 + S)) - S, a pixel keeps
// (L - T) / S of itself (half a level per level without softness); Invert Gradient keeps (T' - L) / S with
// T' = floor((1 - completion) * (255 + S)). The gradient is the Gradient Layer's source (the layer itself for None),
// placed by Gradient Placement.
registerStock(
  "ADBE Gradient Wipe",
  (input, p, ctx, layer, time) => {
    const completion = Math.min(1, Math.max(0, p.num(1, 0)));
    if (completion <= 0) return input;
    const soft = Math.round(Math.min(1, Math.max(0, p.num(2, 0))) * 255);
    const invert = p.bool(5, false);
    const threshold = invert ? Math.floor((1 - completion) * (255 + soft)) : Math.floor(completion * (255 + soft)) - soft;
    const other = layerParam(ctx, layer, p.num(3, 0));
    const map = other ? ctx.layerImage(other, time, false) : null;
    const place = other && map ? placement(layer, input, other, map, p.choice(4, GradientPlacement.STRETCH)) : undefined;
    const sources = map ? [input, map] : [input];
    const out = layerPass(
      ctx,
      imageRect(input),
      sources,
      `uniform vec2 u_scale;
uniform vec2 u_offset;
uniform vec4 u_mapRect;
uniform int u_mode;
uniform int u_own;
uniform int u_invert;
uniform float u_threshold;
uniform float u_soft;`,
      `  vec4 c = at(0, p);
  vec4 g = c;
  if (u_own == 0) {
    vec2 q = p * u_scale + u_offset;
    if (u_mode == ${GradientPlacement.TILE}) q = u_mapRect.xy + mod(q - u_mapRect.xy, u_mapRect.zw);
    g = at(1, q);
  }
  float level = luma(g.rgb) * 255.0;
  float keep = clamp((u_invert == 1 ? u_threshold - level : level - u_threshold) / u_soft, 0.0, 1.0);
  outColor = c * keep;`,
      (u) => {
        const gl = ctx.gl;
        gl.uniform2f(u("u_scale"), place?.scale[0] ?? 1, place?.scale[1] ?? 1);
        gl.uniform2f(u("u_offset"), place?.offset[0] ?? 0, place?.offset[1] ?? 0);
        const r = place?.mapRect;
        gl.uniform4f(u("u_mapRect"), r?.x ?? 0, r?.y ?? 0, r?.width ?? 1, r?.height ?? 1);
        gl.uniform1i(u("u_mode"), p.choice(4, GradientPlacement.STRETCH));
        gl.uniform1i(u("u_own"), map ? 0 : 1);
        gl.uniform1i(u("u_invert"), invert ? 1 : 0);
        gl.uniform1f(u("u_threshold"), threshold);
        gl.uniform1f(u("u_soft"), soft || 2);
      },
      input.scale,
    );
    if (map) ctx.pool.release(map.target);
    ctx.pool.release(input.target);
    return out;
  },
  { cacheable: false, scalable: true },
);

/** CC Image Wipe's Property popup. */
const ImageProperty = { RED: 1, GREEN: 2, BLUE: 3, ALPHA: 4, LUMINANCE: 5, LIGHTNESS: 6, HUE: 7, SATURATION: 8 } as const;

// CC Image Wipe: pixels whose gradient value v (a Property of the Layer's source stretched over the layer, in 0..1)
// is below Completion c become transparent; with Border Softness s a pixel keeps (v - c (1 + s) + s) / s' of itself,
// s' being s in whole 8-bit levels. Inverse Gradient reads 1 - v. Luminance is Rec. 601 luma, which After Effects'
// differs from on coloured gradients (it agrees on greys).
registerStock(
  "CC Image Wipe",
  (input, p, ctx, layer, time) => {
    const completion = Math.min(1, Math.max(0, p.num(1, 0)));
    if (completion <= 0) return input;
    const soft = Math.min(1, Math.max(0, p.num(2, 0.1)));
    if (p.bool(3, false)) ctx.warn("CC Image Wipe: Auto Softness is drawn as the Border Softness");
    if (p.num(4, 0) > 0) ctx.warn("CC Image Wipe: Blur is not drawn");
    const other = layerParam(ctx, layer, p.num(5, 0));
    const map = other ? ctx.layerImage(other, time, false) : null;
    const place = other && map ? placement(layer, input, other, map, GradientPlacement.STRETCH) : undefined;
    const out = layerPass(
      ctx,
      imageRect(input),
      map ? [input, map] : [input],
      `uniform vec2 u_scale;
uniform vec2 u_offset;
uniform int u_own;
uniform int u_property;
uniform int u_invert;
uniform float u_completion;
uniform float u_soft;
uniform float u_ramp;`,
      `  vec4 c = at(0, p);
  vec4 g = u_own == 1 ? c : at(1, p * u_scale + u_offset);
  vec3 s = straight(g);
  vec3 hsl = rgb2hsl(s);
  float v;
  if (u_property == ${ImageProperty.RED}) v = g.r;
  else if (u_property == ${ImageProperty.GREEN}) v = g.g;
  else if (u_property == ${ImageProperty.BLUE}) v = g.b;
  else if (u_property == ${ImageProperty.ALPHA}) v = g.a;
  else if (u_property == ${ImageProperty.LIGHTNESS}) v = hsl.z * g.a;
  else if (u_property == ${ImageProperty.HUE}) v = hsl.x;
  else if (u_property == ${ImageProperty.SATURATION}) v = hsl.y;
  else v = luma(g.rgb);
  if (u_invert == 1) v = 1.0 - v;
  float keep = u_soft > 0.0 ? clamp((v - u_completion * (1.0 + u_soft) + u_soft) / u_ramp, 0.0, 1.0) : (v > u_completion ? 1.0 : 0.0);
  outColor = c * keep;`,
      (u) => {
        const gl = ctx.gl;
        gl.uniform2f(u("u_scale"), place?.scale[0] ?? 1, place?.scale[1] ?? 1);
        gl.uniform2f(u("u_offset"), place?.offset[0] ?? 0, place?.offset[1] ?? 0);
        gl.uniform1i(u("u_own"), map ? 0 : 1);
        gl.uniform1i(u("u_property"), p.choice(6, ImageProperty.LUMINANCE));
        gl.uniform1i(u("u_invert"), p.bool(7, false) ? 1 : 0);
        gl.uniform1f(u("u_completion"), completion);
        gl.uniform1f(u("u_soft"), soft);
        gl.uniform1f(u("u_ramp"), Math.max(1, Math.round(soft * 255)) / 255);
      },
      input.scale,
    );
    if (map) ctx.pool.release(map.target);
    ctx.pool.release(input.target);
    return out;
  },
  { cacheable: false, scalable: true },
);

/**
 * A CC effect's point parameter as a layer point in image pixels: Cycore effects place a point at the centre of the
 * pixel it names.
 */
const ccPoint = (v: number[], k: number): [number, number] => [(v[0] + 0.5) * k, ((v[1] ?? 0) + 0.5) * k];

// CC Scale Wipe: beyond the line through Center across Direction (behind it for a negative Stretch), a point d layer
// pixels from the line shows the point d / (1 + |Stretch| d / 100) from it, along the direction: the pixels at the
// line smeared out.
registerStock("CC Scale Wipe", (input, p, ctx, layer) => {
  const stretch = p.num(1, 0);
  if (stretch === 0) return input;
  const k = input.scale ?? 1;
  const [cx, cy] = ccPoint(p.vec(2, layerCenter(layer, input).map((v) => v - 0.5)), k);
  const [dx, dy] = directionVector(p.num(3, 50)).map((v) => v * Math.sign(stretch));
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    `uniform vec2 u_center;
uniform vec2 u_dir;
uniform float u_rate;`,
    `  float d = dot(p - u_center, u_dir);
  vec2 q = d > 0.0 ? p - u_dir * (d - d / (1.0 + u_rate * d)) : p;
  outColor = at(0, q);`,
    (u) => {
      ctx.gl.uniform2f(u("u_center"), cx, cy);
      ctx.gl.uniform2f(u("u_dir"), dx, dy);
      ctx.gl.uniform1f(u("u_rate"), Math.abs(stretch) / 100 / k);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

/** CC Radial ScaleWipe's band, from the hole out to this many times its radius, and how far out its edge lies, in pixels. */
const RADIAL_BAND = 1.309;
const RADIAL_EDGE = 0.72;

// CC Radial ScaleWipe: a hole of radius R = Completion times the distance from Center to the layer's farthest corner
// opens at Center; a point r from Center out to 1.309 R shows the point r sin(pi s / 2) from it on its ray, s = (r - R)
// / (0.309 R), so the layer's middle is smeared around the hole (measured).
registerStock("CC Radial ScaleWipe", (input, p, ctx, layer) => {
  const completion = Math.min(1, Math.max(0, p.num(1, 0)));
  if (completion <= 0) return input;
  const k = input.scale ?? 1;
  const center = ccPoint(p.vec(2, layerCenter(layer, input).map((v) => v - 0.5)), k);
  if (p.bool(3, false)) ctx.warn("CC Radial ScaleWipe: Reverse is drawn forwards");
  const rect = layerRect(layer, input);
  const reach = Math.max(
    ...[
      [rect.x, rect.y],
      [rect.x + rect.width, rect.y],
      [rect.x, rect.y + rect.height],
      [rect.x + rect.width, rect.y + rect.height],
    ].map(([x, y]) => Math.hypot(x - center[0] + 0.5 * k, y - center[1] + 0.5 * k)),
  );
  const radius = completion * reach;
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    `uniform vec2 u_center;
uniform float u_radius;
uniform float u_band;
uniform float u_edge;
vec2 shown(vec2 p) {
  vec2 v = p - u_center;
  return u_center + v * sin(1.5707963 * clamp((length(v) - u_radius) / u_band, 0.0, 1.0));
}`,
    `  float r = length(p - u_center);
  vec4 c = vec4(0.0);
  if (r < u_radius + u_band + 1.0) {
    for (int i = 0; i < 4; i++)
      for (int j = 0; j < 4; j++) c += at(0, shown(p + (vec2(i, j) - 1.5) / 4.0));
    c /= 16.0;
  } else c = at(0, p);
  outColor = c * clamp(r - u_radius - u_edge + 0.5, 0.0, 1.0);`,
    (u) => {
      ctx.gl.uniform2f(u("u_center"), center[0], center[1]);
      ctx.gl.uniform1f(u("u_radius"), radius);
      ctx.gl.uniform1f(u("u_band"), Math.max(1e-3, (RADIAL_BAND - 1) * radius));
      ctx.gl.uniform1f(u("u_edge"), RADIAL_EDGE * k);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

/** CC Light Wipe's cut edge: a ramp this many pixels wide in d, centred 0.75 pixels inside R (measured). */
const HOLE_RAMP = 1.5;

/** CC Light Wipe's Shape popup. */
const LightShape = { DOORS: 1, ROUND: 2, SQUARE: 3 } as const;

// CC Light Wipe: the layer is cut away within a shape around Center (the axes turned by Direction) of size R =
// Completion times the distance from Center (as given, not its pixel's centre) to the layer's farthest corner (across
// the doors for Doors, straight otherwise), and
// Color times L = min(Intensity R / d, 1) is added to the pixels d away in whole levels of 254, the pixels with L over
// 1/2 losing one level of opacity (measured).
registerStock("CC Light Wipe", (input, p, ctx, layer) => {
  const completion = Math.min(1, Math.max(0, p.num(1, 0) / 100));
  if (completion <= 0) return input;
  const k = input.scale ?? 1;
  const center = ccPoint(p.vec(2, layerCenter(layer, input).map((v) => v - 0.5)), k);
  const shape = p.choice(4, LightShape.ROUND);
  const u = directionVector(p.num(5, 0));
  if (p.bool(6, false)) ctx.warn("CC Light Wipe: Color from Source is drawn with Color");
  if (p.bool(8, false)) ctx.warn("CC Light Wipe: Reverse Transition is not drawn");
  const rect = layerRect(layer, input);
  const [x0, y0, x1, y1] = [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height];
  const reach = Math.max(
    ...[
      [x0, y0],
      [x1, y0],
      [x0, y1],
      [x1, y1],
    ].map(([x, y]) => {
      const [vx, vy] = [x - center[0] + 0.5 * k, y - center[1] + 0.5 * k];
      return shape === LightShape.DOORS ? Math.abs(vx * u[0] + vy * u[1]) : Math.hypot(vx, vy);
    }),
  );
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    `uniform vec2 u_center;
uniform vec2 u_u;
uniform int u_shape;
uniform float u_radius;
uniform vec3 u_light;
uniform float u_intensity;`,
    `  vec2 v = p - u_center;
  float along = dot(v, u_u);
  float d = u_shape == ${LightShape.DOORS} ? abs(along) : u_shape == ${LightShape.SQUARE} ? max(abs(along), abs(v.x * u_u.y - v.y * u_u.x)) : length(v);
  float keep = clamp((d - u_radius + 0.75) / ${HOLE_RAMP.toFixed(2)} + 0.5, 0.0, 1.0);
  vec4 c = at(0, p);
  float light = min(u_intensity * u_radius / max(d, 1e-3), 1.0);
  vec3 lit = min(c.rgb + floor(254.0 * u_light * light) / 255.0 * c.a, vec3(c.a));
  outColor = vec4(lit, c.a) * keep * (1.0 - (light > 0.5 ? 1.0 : 0.0) / 255.0);`,
    (uniform) => {
      const gl = ctx.gl;
      gl.uniform2f(uniform("u_center"), center[0], center[1]);
      gl.uniform2f(uniform("u_u"), u[0], u[1]);
      gl.uniform1i(uniform("u_shape"), shape);
      gl.uniform1f(uniform("u_radius"), completion * reach);
      gl.uniform3fv(uniform("u_light"), p.rgb(7, [1, 1, 1]));
      gl.uniform1f(uniform("u_intensity"), Math.max(0, p.num(3, 100)) / 100);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

/** CC Jaws' Shape popup. */
const JawShape = { SPIKES: 1, ROBOJAW: 2, BLOCK: 3, WAVES: 4 } as const;

/**
 * Waves' tooth over half its height: cos q + c2 cos 2q + s2 sin 2q + c4 cos 4q + s4 sin 4q of the phase q, crests
 * sharper than troughs (fitted to a reference at Height 0.2, Width 8).
 */
const WAVE = { c1: 1.0023, c2: 0.0523, s2: -0.0066, c4: 0.0106, s4: -0.0029 };

/** How far Waves' jaws part beyond the layer's farthest edge, and overlap at Completion 0, in half tooth heights. */
const WAVE_TRAVEL = 1.1696;
const WAVE_OVERLAP = 0.0589;

/** Where Block's teeth start, in pixels along the jaw from Center, and the width of their sides' ramp (measured). */
const BLOCK_PHASE = 0.77;
const BLOCK_RAMP = 1.5;

// CC Jaws: the layer is two jaws meeting along the line through Center turned by Direction, the lower the upper turned
// half a turn. Their teeth are Height times the layer's width tall, 2 Width / 100 of it apart, the upper one's notch
// at Center; they part by Completion times M, M taking the upper jaw's tip past the layer's farthest edge (measured).
registerStock("CC Jaws", (input, p, ctx, layer) => {
  const completion = Math.min(1, Math.max(0, p.num(1, 0)));
  if (completion <= 0) return input;
  const k = input.scale ?? 1;
  const center = ccPoint(p.vec(2, layerCenter(layer, input).map((v) => v - 0.5)), k);
  const theta = (p.num(3, 0) * Math.PI) / 180;
  const e = [Math.cos(theta), Math.sin(theta)];
  const n = [-e[1], e[0]];
  const shape = p.choice(6, JawShape.SPIKES);
  const rect = layerRect(layer, input);
  const height = Math.max(0, p.num(4, 0.2)) * rect.width;
  const period = ((2 * Math.max(2, p.num(5, 8))) / 100) * rect.width;
  const reach = Math.max(
    ...[
      [rect.x, rect.y],
      [rect.x + rect.width, rect.y],
      [rect.x, rect.y + rect.height],
      [rect.x + rect.width, rect.y + rect.height],
    ].map(([x, y]) => Math.abs((x - center[0] + 0.5 * k) * n[0] + (y - center[1] + 0.5 * k) * n[1])),
  );
  const half = height / 2;
  const slope = (2 * height) / period;
  const travel =
    shape === JawShape.SPIKES
      ? reach + half + 0.5 * Math.hypot(1, slope)
      : shape === JawShape.WAVES
        ? reach + half * WAVE_TRAVEL
        : reach + half + 0.73;
  const parted = completion * travel - (shape === JawShape.WAVES ? half * WAVE_OVERLAP : 0);
  return keepMatte(
    ctx,
    input,
    `uniform vec2 u_center;
uniform vec2 u_e;
uniform vec2 u_n;
uniform int u_shape;
uniform float u_half;
uniform float u_period;
uniform float u_parted;
const float PI = 3.14159265;
vec2 tooth(float a) {
  float t = a / u_period - floor(a / u_period + 0.5);
  float s = sign(t);
  t = abs(t);
  if (u_shape == ${JawShape.ROBOJAW}) {
    float r = clamp((t - 0.18333) / 0.16667, 0.0, 1.0);
    float f = r > 0.0 && r < 1.0 ? 2.0 * u_half / (0.16667 * u_period) : 0.0;
    return vec2(u_half * (2.0 * r - 1.0), s * f);
  }
  if (u_shape == ${JawShape.WAVES}) {
    float q = 2.0 * PI * a / u_period;
    float f = ${WAVE.c1} * cos(q) + ${WAVE.c2} * cos(2.0 * q) + ${WAVE.s2} * sin(2.0 * q) + ${WAVE.c4} * cos(4.0 * q) + ${WAVE.s4} * sin(4.0 * q);
    float df = -${WAVE.c1} * sin(q) - ${2 * WAVE.c2} * sin(2.0 * q) + ${2 * WAVE.s2} * cos(2.0 * q) - ${4 * WAVE.c4} * sin(4.0 * q) + ${4 * WAVE.s4} * cos(4.0 * q);
    return u_half * vec2(f, df * 2.0 * PI / u_period);
  }
  return vec2(u_half * (4.0 * t - 1.0), s * 4.0 * u_half / u_period);
}
float edge(float d, float slope) { return clamp(0.5 + d / sqrt(1.0 + slope * slope), 0.0, 1.0); }
float blockTeeth(float a) {
  float s = mod(a - ${BLOCK_PHASE} + 0.25 * u_period, u_period) - 0.25 * u_period;
  return clamp(0.5 + min(s, 0.5 * u_period - s) / ${BLOCK_RAMP.toFixed(2)}, 0.0, 1.0);
}
float keep(vec2 p) {
  vec2 v = p - u_center;
  float a = dot(v, u_e);
  float b = dot(v, u_n);
  if (u_shape == ${JawShape.BLOCK}) {
    float top = max(clamp(0.5 - u_parted - u_half - b, 0.0, 1.0), clamp(0.5 - u_parted + u_half - b, 0.0, 1.0) * blockTeeth(a));
    float bottom = max(clamp(0.5 + b - u_parted - u_half, 0.0, 1.0), clamp(0.5 + b - u_parted + u_half, 0.0, 1.0) * blockTeeth(a + 0.5 * u_period));
    return min(top + bottom, 1.0);
  }
  vec2 f = tooth(a);
  vec2 g = tooth(a + 0.5 * u_period);
  return min(edge(f.x - u_parted - b, f.y) + edge(b - u_parted + g.x, g.y), 1.0);
}`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform2f(u("u_center"), center[0], center[1]);
      gl.uniform2f(u("u_e"), e[0], e[1]);
      gl.uniform2f(u("u_n"), n[0], n[1]);
      gl.uniform1i(u("u_shape"), shape);
      gl.uniform1f(u("u_half"), half);
      gl.uniform1f(u("u_period"), period);
      gl.uniform1f(u("u_parted"), parted);
    },
    0,
  );
});

/**
 * How far CC Line Sweep's edges lie before where its geometry puts them along an axis: 0.286 pixels and a pixel more
 * for each of the axis's negative components (measured).
 */
const lineShift = (axis: number[]) => 0.286 - Math.min(axis[0], 0) - Math.min(axis[1], 0);

// CC Line Sweep: the layer's box is cut into N = floor(extent / Thickness) lines stacked along Direction from its far
// end, what is left over before them making one more line, numbered -1. Each is swept away across its length L (Flip
// Direction from the other end), lagging the one before by L (1 - Slant / 100)^2; line 0's edge runs from one lag
// before the box at Completion 0 on by L + N lags.
registerStock("CS LineSweep", (input, p, ctx, layer) => {
  const completion = Math.min(1, Math.max(0, p.num(1, 0) / 100));
  if (completion <= 0) return input;
  const k = input.scale ?? 1;
  const d = directionVector(p.num(2, 180));
  const flip = p.bool(5, false);
  const s: [number, number] = flip ? [-d[1], d[0]] : [d[1], -d[0]];
  const [lo, hi] = projectionRange(layerRect(layer, input), d);
  const [slo, shi] = projectionRange(layerRect(layer, input), s);
  const thickness = Math.max(1, p.num(3, 50)) * k;
  const length = shi - slo;
  const lines = Math.max(1, Math.floor((hi - lo) / thickness + 1e-6));
  const first = hi - lo - lines * thickness > 1e-6 ? -1 : 0;
  const lag = length * (1 - Math.min(99, Math.max(0, p.num(4, 50))) / 100) ** 2;
  const lead = completion * (length + lines * lag) - lag;
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    `uniform vec2 u_d;
uniform vec2 u_s;
uniform float u_slo;
uniform float u_thickness;
uniform float u_lead;
uniform float u_lag;
uniform float u_lines;
uniform float u_first;
uniform float u_start;
float keepLine(float i, float u, float h) {
  if (i < u_first || i >= u_lines) return 1.0;
  return clamp((u - (u_lead - i * u_lag)) / (2.0 * h) + 0.5, 0.0, 1.0);
}`,
    `  float v = dot(p, u_d) - u_start;
  float u = dot(p, u_s) - u_slo;
  float hv = 0.5 * (abs(u_d.x) + abs(u_d.y));
  float hu = 0.5 * (abs(u_s.x) + abs(u_s.y));
  float i = clamp(floor(v / u_thickness), u_first, u_lines - 1.0);
  float near = v - i * u_thickness;
  float far = (i + 1.0) * u_thickness - v;
  float keep = keepLine(i, u, hu);
  if (near < hv && i > u_first) keep = mix(keepLine(i - 1.0, u, hu), keep, near / (2.0 * hv) + 0.5);
  else if (far < hv && i < u_lines - 1.0) keep = mix(keepLine(i + 1.0, u, hu), keep, far / (2.0 * hv) + 0.5);
  outColor = at(0, p) * keep;`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform2f(u("u_d"), d[0], d[1]);
      gl.uniform2f(u("u_s"), s[0], s[1]);
      gl.uniform1f(u("u_slo"), slo - lineShift(s));
      gl.uniform1f(u("u_thickness"), thickness);
      gl.uniform1f(u("u_lead"), lead);
      gl.uniform1f(u("u_lag"), lag);
      gl.uniform1f(u("u_lines"), lines);
      gl.uniform1f(u("u_first"), first);
      gl.uniform1f(u("u_start"), hi - lines * thickness - lineShift(d));
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

// Iris Wipe: the layer is cut away inside a star (a regular polygon without the inner radius) around Iris Center;
// Feather blurs its edge (about Feather / 5, not as a mask's feather).
registerStock("ADBE IRIS_WIPE", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const outer = Math.max(0, p.num(3, 0));
  if (outer <= 0) return input;
  const center = p.vec(1, layerCenter(layer, input));
  const verts = irisVertices(center, p.num(2, 6), outer, p.bool(4, false) ? Math.max(0, p.num(5, 0)) : null, p.num(6, 0)).map((v) => v * k);
  return keepMatte(
    ctx,
    input,
    `${POLYGON}
float keep(vec2 p) { return clamp(polygonDistance(p) + 0.5, 0.0, 1.0); }`,
    (u) => {
      ctx.gl.uniform2fv(u("u_poly"), new Float32Array(verts));
      ctx.gl.uniform1i(u("u_count"), verts.length / 2);
    },
    irisFeatherSigma(p.num(7, 0)) * k,
  );
});

// Block Dissolve (a look-alike: After Effects picks the blocks with its own random numbers): the layer's grid of
// Block Width by Block Height blocks loses each block once Completion passes the block's own random level; Soft Edges
// blurs the blocks' edges by Feather.
registerStock("ADBE Block Dissolve", (input, p, ctx) => {
  const completion = Math.min(1, Math.max(0, p.num(1, 0) / 100));
  if (completion <= 0) return input;
  const k = input.scale ?? 1;
  const block = [Math.max(1, p.num(2, 10)), Math.max(1, p.num(3, 10))];
  return keepMatte(
    ctx,
    input,
    `uniform vec2 u_block;
uniform float u_completion;
float keep(vec2 p) {
  uvec2 c = uvec2(ivec2(floor(p / u_block)) + 32768);
  uint h = c.x * 0x8da6b343u ^ c.y * 0xd8163841u;
  h = (h ^ (h >> 15)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12)) * 0x297a2d39u;
  h ^= h >> 15;
  return float(h) / 4294967296.0 >= u_completion ? 1.0 : 0.0;
}`,
    (u) => {
      ctx.gl.uniform2f(u("u_block"), block[0] * k, block[1] * k);
      ctx.gl.uniform1f(u("u_completion"), completion);
    },
    p.bool(5, false) ? Math.max(0, p.num(4, 0)) * k : 0,
  );
});
