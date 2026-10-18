// Generate effects beyond generate.ts: Checkerboard, Circle and Grid. Each draws a pattern's coverage in layer
// pixels (points times the image's scale at a reduced resolution) and lays its colour over the layer by its
// Blending Mode at Opacity; None shows the pattern alone.
import type { Layer } from "../../aep/model.ts";
import type { LayerImage, RenderContext } from "../registry.ts";
import type { Uniforms } from "./fxextraUtil.ts";
import { imageRect, layerPass, layerRect, type Params, registerStock, unionRect } from "./stockUtil.ts";

/** Checkerboard's, Circle's and Grid's Blending Mode menu as After Effects stores it. */
const BLEND_MENU = ["None", "Normal", "Stencil Alpha", "(-", "Add", "Multiply", "Screen", "Overlay", "Soft Light", "Hard Light", "(-", "Color Dodge", "Color Burn", "(-", "Darken", "Lighten", "Difference", "Exclusion", "(-", "Hue", "Saturation", "Color", "Luminosity"];

/** BLEND_MENU's choices, separators skipped. */
const Blend = { NONE: 1, NORMAL: 2, STENCIL: 3, ADD: 4, MULTIPLY: 5, SCREEN: 6, OVERLAY: 7, SOFT_LIGHT: 8, HARD_LIGHT: 9, COLOR_DODGE: 10, COLOR_BURN: 11, DARKEN: 12, LIGHTEN: 13, DIFFERENCE: 14, EXCLUSION: 15, HUE: 16, SATURATION: 17, COLOR: 18, LUMINOSITY: 19 } as const;

/**
 * GLSL: `vec4 composite(vec4 c, vec3 color, float a)`, the pattern of straight colour `color` and alpha `a` laid
 * over the layer's pixel c by u_blend: None replaces the layer, Normal lays the pattern over it, Stencil Alpha
 * keeps the layer where the pattern is, and the other modes blend the layer's straight colour with the pattern
 * laid over the mode's neutral colour (black, white or grey; Darken, Lighten and the hue modes mix with the layer
 * instead), keeping the layer's alpha.
 */
const COMPOSITE_GLSL = `
uniform int u_blend;
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  return mx <= mn ? vec3(0.0) : (c - mn) * s / (mx - mn);
}
float dodge(float b, float s) { return b <= 0.0 ? 0.0 : (s >= 1.0 ? 1.0 : min(1.0, b / (1.0 - s))); }
float burn(float b, float s) { return b >= 1.0 ? 1.0 : (s <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - b) / s)); }
float softLight(float b, float s) {
  if (s <= 0.5) return b - (1.0 - 2.0 * s) * b * (1.0 - b);
  float d = b <= 0.25 ? ((16.0 * b - 12.0) * b + 4.0) * b : sqrt(b);
  return b + (2.0 * s - 1.0) * (d - b);
}
float hardLight(float b, float s) { return s <= 0.5 ? b * 2.0 * s : 1.0 - (1.0 - b) * (2.0 - 2.0 * s); }
vec3 blendColor(vec3 b, vec3 s) {
  if (u_blend == ${Blend.MULTIPLY}) return b * s;
  if (u_blend == ${Blend.SCREEN}) return b + s - b * s;
  if (u_blend == ${Blend.OVERLAY}) return vec3(hardLight(s.r, b.r), hardLight(s.g, b.g), hardLight(s.b, b.b));
  if (u_blend == ${Blend.SOFT_LIGHT}) return vec3(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b));
  if (u_blend == ${Blend.HARD_LIGHT}) return vec3(hardLight(b.r, s.r), hardLight(b.g, s.g), hardLight(b.b, s.b));
  if (u_blend == ${Blend.COLOR_DODGE}) return vec3(dodge(b.r, s.r), dodge(b.g, s.g), dodge(b.b, s.b));
  if (u_blend == ${Blend.COLOR_BURN}) return vec3(burn(b.r, s.r), burn(b.g, s.g), burn(b.b, s.b));
  if (u_blend == ${Blend.DARKEN}) return min(b, s);
  if (u_blend == ${Blend.LIGHTEN}) return max(b, s);
  if (u_blend == ${Blend.DIFFERENCE}) return abs(b - s);
  if (u_blend == ${Blend.EXCLUSION}) return b + s - 2.0 * b * s;
  if (u_blend == ${Blend.HUE}) return setLum(setSat(s, sat(b)), lum(b));
  if (u_blend == ${Blend.SATURATION}) return setLum(setSat(b, sat(s)), lum(b));
  if (u_blend == ${Blend.COLOR}) return setLum(s, lum(b));
  if (u_blend == ${Blend.LUMINOSITY}) return setLum(b, lum(s));
  return s;
}
vec4 composite(vec4 c, vec3 color, float a) {
  vec4 g = vec4(color * a, a);
  if (u_blend == ${Blend.NONE}) return g;
  if (u_blend == ${Blend.NORMAL}) return g + c * (1.0 - a);
  if (u_blend == ${Blend.STENCIL}) return c * a;
  float alpha = a + c.a * (1.0 - a);
  vec3 sum;
  if (u_blend >= ${Blend.HUE} || u_blend == ${Blend.DARKEN} || u_blend == ${Blend.LIGHTEN} || u_blend == ${Blend.SOFT_LIGHT}) {
    vec3 b = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
    sum = (1.0 - c.a) * a * color + c.a * mix(b, blendColor(b, color), a);
  } else {
    // Both laid over the mode's neutral colour, blended, and the neutral taken out again.
    float neutral = u_blend == ${Blend.MULTIPLY} || u_blend == ${Blend.COLOR_BURN} ? 1.0
      : u_blend == ${Blend.OVERLAY} || u_blend == ${Blend.HARD_LIGHT} ? 0.5 : 0.0;
    vec3 b = c.rgb + neutral * (1.0 - c.a);
    vec3 s = color * a + neutral * (1.0 - a);
    sum = (u_blend == ${Blend.ADD} ? b + s : blendColor(b, s)) - neutral * (1.0 - alpha);
  }
  vec3 straight = alpha > 0.0 ? sum / alpha : vec3(0.0);
  return vec4(clamp(straight, 0.0, 1.0) * c.a, c.a);
}
`;

/**
 * A generator's output: `body` is GLSL setting `float cov` (the pattern's coverage at layer point p, image
 * pixels); the pattern in `color` at `opacity` is composited over the layer by `blend`. Covers the layer's
 * rectangle (and the input's when it lays over it). Releases `input`.
 */
function generate(ctx: RenderContext, input: LayerImage, layer: Layer, p: Params, color: [number, number, number], opacity: number, blend: number, decls: string, body: string, setUniforms: Uniforms): LayerImage {
  const own = layerRect(layer, input);
  const rect = blend === Blend.NONE ? own : unionRect(own, imageRect(input));
  const out = layerPass(
    ctx,
    rect,
    [input],
    `${COMPOSITE_GLSL}
uniform vec3 u_color;
uniform float u_opacity;
uniform vec4 u_own;
${decls}`,
    `  vec4 c = at(0, p);
  float cov = 0.0;
  if (p.x >= u_own.x && p.y >= u_own.y && p.x <= u_own.z && p.y <= u_own.w) {
${body}
  }
  outColor = composite(c, u_color, clamp(cov, 0.0, 1.0) * u_opacity);`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform1i(u("u_blend"), blend);
      gl.uniform3f(u("u_color"), color[0], color[1], color[2]);
      gl.uniform1f(u("u_opacity"), Math.min(1, Math.max(0, opacity)));
      gl.uniform4f(u("u_own"), own.x, own.y, own.x + own.width, own.y + own.height);
      setUniforms(u);
    },
    input.scale,
  );
  void p;
  ctx.pool.release(input.target);
  return out;
}

/**
 * GLSL: `ramp(e, f)`, how far a pixel whose centre is `e` pixels inside an edge feathered by `f` is covered: a
 * smoothstep over f + 1 pixels centred on the edge, or the linear one-pixel ramp of an unfeathered edge (both as
 * After Effects draws Checkerboard and Grid). `cellPhase(x, a, w)` places x in the cells of size w from a: its
 * distance to the nearest cell boundary and the cell's parity (1 or -1). Effect points lie on pixel centres.
 */
const RAMP_GLSL = `
float ramp(float e, float f) { return f > 0.0 ? smoothstep(0.0, 1.0, e / (f + 1.0) + 0.5) : clamp(e + 0.5, 0.0, 1.0); }
vec2 cellPhase(float x, float a, float w) {
  float q = x - 0.5 - a;
  float i = floor(q / w);
  float u = q - i * w;
  return vec2(min(u, w - u), mod(i, 2.0) < 0.5 ? 1.0 : -1.0);
}
`;

/** An effect point in layer pixels: points are measured from the top left of the layer's box (layerRect). */
function layerPoint(layer: Layer, point: number[]): [number, number] {
  const shape = layer.layerType === "ShapeLayer" && layer.width > 0 && layer.height > 0;
  return shape ? [point[0] - Math.floor(layer.width / 2), (point[1] ?? 0) - Math.floor(layer.height / 2)] : [point[0], point[1] ?? 0];
}

/** Size From: 1 Corner Point, 2 Width Slider, 3 Width & Height Sliders. */
function cellSize(p: Params, anchor: number[], cornerIndex: number, widthIndex: number, heightIndex: number, sizeFrom: number): [number, number] {
  if (sizeFrom === 1) {
    const corner = p.vec(cornerIndex, anchor);
    return [Math.abs(corner[0] - anchor[0]), Math.abs((corner[1] ?? 0) - anchor[1])];
  }
  const w = p.num(widthIndex, 16);
  return [w, sizeFrom === 2 ? w : p.num(heightIndex, 8)];
}

/** Eyedropper Fill's Average Pixel Colors: 1 Skip Empty, 2 All, 3 All Premultiplied, 4 Including Alpha. */
const Average = { SKIP_EMPTY: 1, ALL: 2, ALL_PREMULTIPLIED: 3, INCLUDING_ALPHA: 4 } as const;

// Eyedropper Fill: the layer's pixels whose centres lie within Sample Radius of Sample Point, averaged by one
// fragment into a 1 x 1 image, fill the layer (keeping its alpha with Maintain Original Alpha), mixed with the
// original by Blend With Original.
registerStock("ADBE Eyedropper Fill", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const point = layerPoint(layer, p.vec(1, [0, 0]));
  const radius = Math.max(0.5, p.num(2, 10)) * k;
  const mode = p.choice(3, Average.SKIP_EMPTY, ["Skip Empty", "All", "All Premultiplied", "Including Alpha"]);
  const sample: LayerImage = { target: ctx.pool.acquire(1 + 2 * ctx.pad, 1 + 2 * ctx.pad, true), width: 1, height: 1, origin: [0, 0] };
  const reach = Math.ceil(radius);
  const averaged = layerPass(
    ctx,
    imageRect(sample),
    [input],
    `uniform vec2 u_point;
uniform float u_radius;
uniform int u_reach;
uniform int u_mode;`,
    `  vec2 centre = floor(u_point) + 0.5;
  vec4 sum = vec4(0.0);
  float n = 0.0;
  for (int j = -u_reach; j <= u_reach; j++) {
    for (int i = -u_reach; i <= u_reach; i++) {
      vec2 q = centre + vec2(float(i), float(j));
      if (length(q - u_point) > u_radius) continue;
      vec4 c = at(0, q);
      if (u_mode == ${Average.SKIP_EMPTY}) { if (c.a > 0.0) { sum += vec4(c.rgb / c.a, 1.0); n += 1.0; } }
      else if (u_mode == ${Average.ALL}) { sum += vec4(c.a > 0.0 ? c.rgb / c.a : vec3(0.0), 1.0); n += 1.0; }
      else { sum += c; n += 1.0; }
    }
  }
  vec4 m = n > 0.0 ? sum / n : vec4(0.0);
  if (u_mode == ${Average.SKIP_EMPTY} || u_mode == ${Average.ALL}) outColor = vec4(m.rgb, 1.0);
  else if (u_mode == ${Average.ALL_PREMULTIPLIED}) outColor = vec4(m.rgb, 1.0);
  else outColor = m;`,
    (u) => {
      ctx.gl.uniform2f(u("u_point"), point[0] * k, (point[1] ?? 0) * k);
      ctx.gl.uniform1f(u("u_radius"), radius);
      ctx.gl.uniform1i(u("u_reach"), reach);
      ctx.gl.uniform1i(u("u_mode"), mode);
    },
  );
  ctx.pool.release(sample.target);
  const out = layerPass(
    ctx,
    imageRect(input),
    [input, averaged],
    `uniform int u_keepAlpha;
uniform float u_blend;`,
    `  vec4 c = at(0, p);
  vec4 fill = at(1, vec2(0.5));
  vec4 f = u_keepAlpha == 1 ? vec4(fill.a > 0.0 ? fill.rgb / fill.a : vec3(0.0), 1.0) * c.a : fill;
  outColor = mix(f, c, u_blend);`,
    (u) => {
      ctx.gl.uniform1i(u("u_keepAlpha"), p.bool(4, false) ? 1 : 0);
      ctx.gl.uniform1f(u("u_blend"), Math.min(1, Math.max(0, p.num(5, 0))));
    },
    input.scale,
  );
  ctx.pool.release(averaged.target);
  ctx.pool.release(input.target);
  return out;
});

registerStock("ADBE Checkerboard", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const anchor = p.vec(1, [layer.width / 2, layer.height / 2]);
  const [w, h] = cellSize(p, anchor, 3, 4, 5, p.choice(2, 2, ["Corner Point", "Width Slider", "Width & Height Sliders"]));
  const feather = [p.num(7, 0), p.num(8, 0)];
  return generate(
    ctx,
    input,
    layer,
    p,
    p.rgb(10, [1, 1, 1]),
    p.num(11, 100) / 100,
    p.choice(12, Blend.NONE, BLEND_MENU),
    `${RAMP_GLSL}
uniform vec2 u_anchor;
uniform vec2 u_cell;
uniform vec2 u_soft;`,
    `    vec2 cx = cellPhase(p.x, u_anchor.x, u_cell.x);
    vec2 cy = cellPhase(p.y, u_anchor.y, u_cell.y);
    float sx = cx.y * (2.0 * ramp(cx.x, u_soft.x) - 1.0);
    float sy = cy.y * (2.0 * ramp(cy.x, u_soft.y) - 1.0);
    cov = 0.5 + 0.5 * sign(sx * sy) * min(abs(sx), abs(sy));`,
    (u) => {
      const [ax, ay] = layerPoint(layer, anchor);
      ctx.gl.uniform2f(u("u_anchor"), ax * k, ay * k);
      ctx.gl.uniform2f(u("u_cell"), Math.max(1e-3, w * k), Math.max(1e-3, h * k));
      ctx.gl.uniform2f(u("u_soft"), feather[0] * k, feather[1] * k);
    },
  );
});

/** Circle's Edge menu: 1 None, 2 Edge Radius, 3 Thickness, 4 Thickness * Radius, 5 Thickness & Feather * Radius. */
const Edge = { NONE: 1, EDGE_RADIUS: 2, THICKNESS: 3, THICKNESS_RADIUS: 4, THICKNESS_FEATHER_RADIUS: 5 } as const;

// Circle: a disc, or a ring by Edge, whose edges are smoothsteps over twice their feather plus 1.5 pixels; After
// Effects measures the distance from Center three quarters of a pixel longer.
registerStock("ADBE Circle", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const center = layerPoint(layer, p.vec(1, [layer.width / 2, layer.height / 2]));
  const radius = Math.abs(p.num(2, 75));
  const edge = p.choice(3, Edge.NONE, ["None", "Edge Radius", "Thickness", "Thickness * Radius", "Thickness & Feather * Radius"]);
  const value = p.num(4, 10);
  let featherOut = p.num(6, 0);
  let featherIn = p.num(7, 0);
  let inner = -1;
  let outer = radius;
  if (edge === Edge.EDGE_RADIUS) [inner, outer] = [Math.min(radius, Math.abs(value)), Math.max(radius, Math.abs(value))];
  else if (edge !== Edge.NONE) {
    const thickness = edge === Edge.THICKNESS ? value : (value * radius) / 100;
    if (edge === Edge.THICKNESS_FEATHER_RADIUS) [featherOut, featherIn] = [(featherOut * radius) / 100, (featherIn * radius) / 100];
    [inner, outer] = [radius - thickness / 2, radius + thickness / 2];
  }
  return generate(
    ctx,
    input,
    layer,
    p,
    p.rgb(10, [1, 1, 1]),
    p.num(11, 100) / 100,
    p.choice(12, Blend.NONE, BLEND_MENU),
    `uniform vec2 u_center;
uniform vec2 u_radii;
uniform vec2 u_halfRamps;
uniform int u_invert;`,
    `    float d = length(p - u_center) + 0.75;
    float o = 1.0 - smoothstep(0.0, 1.0, (d - u_radii.y) / (2.0 * u_halfRamps.y) + 0.5);
    float i = u_radii.x < 0.0 ? 1.0 : smoothstep(0.0, 1.0, (d - u_radii.x) / (2.0 * u_halfRamps.x) + 0.5);
    cov = o * i;
    if (u_invert == 1) cov = 1.0 - cov;`,
    (u) => {
      ctx.gl.uniform2f(u("u_center"), center[0] * k, center[1] * k);
      ctx.gl.uniform2f(u("u_radii"), inner < 0 ? -1 : inner * k, outer * k);
      ctx.gl.uniform2f(u("u_halfRamps"), Math.max(0, featherIn) * k + 0.75, Math.max(0, featherOut) * k + 0.75);
      ctx.gl.uniform1i(u("u_invert"), p.bool(9, false) ? 1 : 0);
    },
  );
});

// Grid: lines Border wide through the cell corners. A feathered line's coverage is a smoothstep, from its edge
// inwards over its feather plus a pixel, of the length of the two axes' linear ramps; unfeathered lines are
// one-pixel ramps whose coverages add up where they cross.
registerStock("ADBE Grid", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const anchor = p.vec(1, [layer.width / 2, layer.height / 2]);
  const [w, h] = cellSize(p, anchor, 3, 4, 5, p.choice(2, 1, ["Corner Point", "Width Slider", "Width & Height Sliders"]));
  const feather = [Math.max(0, p.num(8, 0)), Math.max(0, p.num(9, 0))];
  return generate(
    ctx,
    input,
    layer,
    p,
    p.rgb(12, [1, 1, 1]),
    p.num(13, 100) / 100,
    p.choice(14, Blend.NONE, BLEND_MENU),
    `${RAMP_GLSL}
uniform vec2 u_anchor;
uniform vec2 u_cell;
uniform float u_border;
uniform vec2 u_soft;
uniform int u_invert;`,
    `    vec2 e = u_border * 0.5 - vec2(cellPhase(p.x, u_anchor.x, u_cell.x).x, cellPhase(p.y, u_anchor.y, u_cell.y).x);
    if (u_soft.x > 0.0 || u_soft.y > 0.0) cov = smoothstep(0.0, 1.0, length(clamp(e / (u_soft + 1.0), 0.0, 1.0)));
    else cov = min(1.0, clamp(e.x, 0.0, 1.0) + clamp(e.y, 0.0, 1.0));
    if (u_invert == 1) cov = 1.0 - cov;`,
    (u) => {
      const [ax, ay] = layerPoint(layer, anchor);
      ctx.gl.uniform2f(u("u_anchor"), ax * k, ay * k);
      ctx.gl.uniform2f(u("u_cell"), Math.max(1e-3, w * k), Math.max(1e-3, h * k));
      ctx.gl.uniform1f(u("u_border"), Math.max(0, p.num(6, 5)) * k);
      ctx.gl.uniform2f(u("u_soft"), feather[0] * k, feather[1] * k);
      ctx.gl.uniform1i(u("u_invert"), p.bool(11, false) ? 1 : 0);
    },
  );
});

/**
 * GLSL: `vec4 glow(float d, float thickness)`, Ellipse's and Beam's stroke at distance d from its centre line
 * (premultiplied): Inside Color on the line turning linearly into Outside Color at half the thickness, where its
 * alpha, a linear ramp 1 + Softness x (thickness - 1) pixels wide, is one half.
 */
const GLOW_GLSL = `
uniform vec3 u_inside;
uniform vec3 u_outside;
uniform float u_softness;
uniform int u_onOriginal;
vec4 glow(float d, float thickness) {
  float half_ = thickness * 0.5;
  float t = half_ > 0.0 ? clamp(1.0 - d / half_, 0.0, 1.0) : 0.0;
  float a = clamp(0.5 - (d - half_) / (1.0 + u_softness * max(thickness - 1.0, 0.0)), 0.0, 1.0);
  return vec4(mix(u_outside, u_inside, t) * a, a);
}
vec4 overOriginal(vec4 g, vec4 c) { return u_onOriginal == 1 ? g + c * (1.0 - g.a) : g; }
`;

function setGlow(ctx: RenderContext, u: (name: string) => WebGLUniformLocation | null, p: Params, inside: number, outside: number, softness: number, onOriginal: number): void {
  const gl = ctx.gl;
  const i = p.rgb(inside, [1, 1, 1]);
  const o = p.rgb(outside, [1, 0, 0]);
  gl.uniform3f(u("u_inside"), i[0], i[1], i[2]);
  gl.uniform3f(u("u_outside"), o[0], o[1], o[2]);
  gl.uniform1f(u("u_softness"), Math.min(1, Math.max(0, p.num(softness, 0.5))));
  gl.uniform1i(u("u_onOriginal"), p.bool(onOriginal, false) ? 1 : 0);
}

/** A generator drawing over the layer's own rectangle (`body` sets outColor from p and c = the layer's pixel). */
function strokePass(ctx: RenderContext, input: LayerImage, layer: Layer, decls: string, body: string, setUniforms: Uniforms): LayerImage {
  const out = layerPass(ctx, layerRect(layer, input), [input], `${GLOW_GLSL}${decls}`, `  vec4 c = at(0, p);\n${body}`, setUniforms, input.scale);
  ctx.pool.release(input.target);
  return out;
}

const MAX_ELLIPSE_SIDES = 512;

/**
 * The number of sides of the polygon Ellipse draws (in layer pixels): each quarter of the ellipse in at least 8
 * segments, none longer than 0.8 x Thickness along a quarter of its perimeter, π (a + b) / 4.
 */
function ellipseSides(width: number, height: number, thickness: number): number {
  const quarter = (Math.PI * (Math.max(0, width) + Math.max(0, height))) / 8;
  const segments = thickness > 0 ? Math.ceil(quarter / (0.8 * thickness)) : Infinity;
  return 4 * Math.min(MAX_ELLIPSE_SIDES / 4, Math.max(8, segments));
}

// Ellipse: the glow around the ellipse of Width and Height centred on Center (on a pixel centre), at the distance
// to a polygon inscribed in it, with vertices at equal angles of its parametric form.
registerStock("ADBE ELLIPSE", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const center = layerPoint(layer, p.vec(1, [layer.width / 2, layer.height / 2]));
  return strokePass(
    ctx,
    input,
    layer,
    `uniform vec2 u_center;
uniform vec2 u_radii;
uniform float u_thickness;
uniform int u_sides;
float ellipseDistance(vec2 q, vec2 r) {
  float best = 1e9;
  vec2 a = vec2(r.x, 0.0);
  for (int k = 1; k <= ${MAX_ELLIPSE_SIDES}; k++) {
    if (k > u_sides) break;
    float th = 6.28318531 * float(k) / float(u_sides);
    vec2 b = vec2(r.x * cos(th), r.y * sin(th));
    vec2 s = b - a;
    float l = dot(s, s);
    float u = l > 0.0 ? clamp(dot(q - a, s) / l, 0.0, 1.0) : 0.0;
    best = min(best, length(q - a - u * s));
    a = b;
  }
  return best;
}`,
    `  outColor = overOriginal(glow(ellipseDistance(p - u_center, u_radii), u_thickness), c);`,
    (u) => {
      ctx.gl.uniform2f(u("u_center"), (center[0] + 0.5) * k, (center[1] + 0.5) * k);
      ctx.gl.uniform2f(u("u_radii"), (Math.max(0, p.num(2, 50)) / 2) * k, (Math.max(0, p.num(3, 50)) / 2) * k);
      ctx.gl.uniform1f(u("u_thickness"), Math.max(0, p.num(4, 8)) * k);
      ctx.gl.uniform1i(u("u_sides"), ellipseSides(p.num(2, 50), p.num(3, 50), p.num(4, 8)));
      setGlow(ctx, u, p, 6, 7, 5, 8);
    },
  );
});

// Beam: the glow around the part of the line from Start Point to End Point that Length (a share of the line) and
// Time (its head, from the start at 0 to Length past the end at 1) select, round at both ends, its thickness
// changing linearly from Starting to Ending Thickness. 3D Perspective places the shares along a line receding from
// its thicker end, the far end 2 x thick / thin - 1 times as deep as the near one (positions on the screen then go
// as u A / ((1 - u) + u A), A the far end's depth over the start's).
registerStock("ADBE Laser", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const start = layerPoint(layer, p.vec(1, [layer.width * 0.1, layer.height / 2]));
  const end = layerPoint(layer, p.vec(2, [layer.width * 0.9, layer.height / 2]));
  const length = Math.min(1, Math.max(0, p.num(3, 0.25)));
  const time = Math.min(1, Math.max(0, p.num(4, 0.5)));
  const t0 = Math.max(0, p.num(5, 8));
  const t1 = Math.max(0, p.num(6, 8));
  const head = Math.min(1, time * (1 + length));
  const tail = Math.min(1, Math.max(0, time * (1 + length) - length));
  const perspective = p.bool(10, true) && t0 > 0 && t1 > 0;
  const depth = t0 >= t1 ? (2 * t0) / t1 - 1 : 1 / ((2 * t1) / t0 - 1);
  const onScreen = (u: number) => (perspective ? (u * depth) / (1 - u + u * depth) : u);
  return strokePass(
    ctx,
    input,
    layer,
    `uniform vec2 u_start;
uniform vec2 u_end;
uniform vec2 u_span;
uniform vec2 u_thickness;`,
    `  vec2 axis = u_end - u_start;
  float len2 = dot(axis, axis);
  float s = len2 > 0.0 ? clamp(dot(p - u_start, axis) / len2, u_span.x, u_span.y) : 0.0;
  outColor = overOriginal(glow(length(p - u_start - axis * s), mix(u_thickness.x, u_thickness.y, s)), c);`,
    (u) => {
      ctx.gl.uniform2f(u("u_start"), (start[0] + 0.5) * k, (start[1] + 0.5) * k);
      ctx.gl.uniform2f(u("u_end"), (end[0] + 0.5) * k, (end[1] + 0.5) * k);
      ctx.gl.uniform2f(u("u_span"), onScreen(tail), onScreen(head));
      ctx.gl.uniform2f(u("u_thickness"), t0 * k, t1 * k);
      setGlow(ctx, u, p, 8, 9, 7, 11);
    },
  );
});

/** Light Sweep's Shape menu: 1 Linear, 2 Smooth, 3 Sharp. */
const SweepShape = { LINEAR: 1, SMOOTH: 2, SHARP: 3 } as const;
/** Light Sweep's Light Reception menu: 1 Add, 2 Composite, 3 Cutout. */
const Reception = { ADD: 1, COMPOSITE: 2, CUTOUT: 3 } as const;

const MAX_BOX_TAPS = 2048;

/**
 * The layer's alpha averaged along one axis over a box 2 x `half` wide whose centre is `shift` along that axis from
 * the pixel (pixels weighted by their overlap with the box), in every channel.
 */
function alphaBox(ctx: RenderContext, input: LayerImage, rect: ReturnType<typeof layerRect>, axis: 0 | 1, shift: number, half: number): LayerImage {
  return layerPass(
    ctx,
    rect,
    [input],
    `uniform int u_axis;
uniform float u_shift;
uniform float u_half;`,
    `  float c = (u_axis == 0 ? p.x : p.y) + u_shift;
  float lo = c - u_half;
  float hi = c + u_half;
  float first = floor(lo) + 0.5;
  float sum = 0.0;
  for (int i = 0; i < ${MAX_BOX_TAPS}; i++) {
    float q = first + float(i);
    if (q - 0.5 >= hi) break;
    float w = min(q + 0.5, hi) - max(q - 0.5, lo);
    sum += w * at(0, u_axis == 0 ? vec2(q, p.y) : vec2(p.x, q)).a;
  }
  outColor = vec4(sum / (2.0 * u_half));`,
    (u) => {
      ctx.gl.uniform1i(u("u_axis"), axis);
      ctx.gl.uniform1f(u("u_shift"), shift);
      ctx.gl.uniform1f(u("u_half"), half);
    },
    input.scale,
  );
}

// Light Sweep: a band of light across the layer through Center (on a pixel centre), Direction turning its normal
// from the x axis, Width its half width at half strength (Linear, a smoothstep or Sharp's square of Linear). The
// edges facing (sin Direction, -cos Direction) catch Edge Intensity / 50 x (1 - the alpha averaged over a square
// 2 x Edge Thickness wide, centred Edge Thickness that way), times the alpha. Add adds the light (the band's
// truncated to 8 bits), Composite lays it over the layer and Cutout keeps only the light, all within the alpha.
registerStock("CC Light Sweep", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const center = layerPoint(layer, p.vec(1, [layer.width / 2, layer.height / 2]));
  const direction = (p.num(2, -30) * Math.PI) / 180;
  const color = p.rgb(8, [1, 1, 1]);
  const edge = Math.max(0, p.num(6, 50)) / 50;
  const thickness = Math.min(MAX_BOX_TAPS / 2 - 2, Math.max(0, p.num(7, 4)) * k);
  const rect = layerRect(layer, input);
  let box: LayerImage | null = null;
  if (edge > 0 && thickness > 0) {
    const across = alphaBox(ctx, input, rect, 0, Math.sin(direction) * thickness, thickness);
    box = alphaBox(ctx, across, rect, 1, -Math.cos(direction) * thickness, thickness);
    ctx.pool.release(across.target);
  }
  const out = layerPass(
    ctx,
    rect,
    box ? [input, box] : [input],
    `uniform vec2 u_center;
uniform vec2 u_normal;
uniform float u_width;
uniform float u_intensity;
uniform float u_edge;
uniform int u_shape;
uniform int u_reception;
uniform vec3 u_color;`,
    `  vec4 c = at(0, p);
  float r = abs(dot(p - u_center, u_normal)) / (2.0 * u_width);
  float s = u_shape == ${SweepShape.LINEAR} ? max(0.0, 1.0 - r)
    : u_shape == ${SweepShape.SMOOTH} ? 1.0 - smoothstep(0.0, 1.0, r)
    : max(0.0, 1.0 - r) * max(0.0, 1.0 - r);
  float light = u_intensity * s;
  float edge = ${box ? "u_edge * max(0.0, 1.0 - at(1, p).a) * c.a" : "0.0"};
  vec3 l = u_color * c.a;
  if (u_reception == ${Reception.ADD}) outColor = vec4(min(c.rgb + floor(l * light * 255.0 + 1e-4) / 255.0 + l * edge, vec3(c.a)), c.a);
  else if (u_reception == ${Reception.COMPOSITE}) outColor = vec4(mix(c.rgb, l, min(light + edge, 1.0)), c.a);
  else outColor = vec4(l, c.a) * min(light + edge, 1.0);`,
    (u) => {
      ctx.gl.uniform1f(u("u_edge"), edge);
      ctx.gl.uniform2f(u("u_center"), (center[0] + 0.5) * k, (center[1] + 0.5) * k);
      ctx.gl.uniform2f(u("u_normal"), Math.cos(direction), Math.sin(direction));
      ctx.gl.uniform1f(u("u_width"), Math.max(1e-3, p.num(4, 50) * k));
      ctx.gl.uniform1f(u("u_intensity"), Math.max(0, p.num(5, 100)) / 100);
      ctx.gl.uniform1i(u("u_shape"), p.choice(3, SweepShape.LINEAR, ["Linear", "Smooth", "Sharp"]));
      ctx.gl.uniform1i(u("u_reception"), p.choice(9, Reception.ADD, ["Add", "Composite", "Cutout"]));
      ctx.gl.uniform3f(u("u_color"), color[0], color[1], color[2]);
    },
    input.scale,
  );
  if (box) ctx.pool.release(box.target);
  ctx.pool.release(input.target);
  return out;
});
