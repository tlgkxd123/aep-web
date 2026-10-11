// Stock Perspective, Stylize and Noise effects: Drop Shadow, Glow, Mosaic and
// Noise. Shadow softness and glow radius map to Gaussians as Gaussian Blur's
// Blurriness does (stockMath.ts). Look-alikes from the effects' documented
// behaviour, not yet measured against After Effects renders.
import { blurrinessSigma, directionVector } from "./stockMath.ts";
import { blurAxes, gaussian, growRect, imageRect, layerPass, layerRect, registerStock, unionRect } from "./stockUtil.ts";

// Drop Shadow: the layer's alpha in Shadow Color at Opacity (stored 0..255), moved Distance along Direction and
// softened, behind the layer (or alone, with Shadow Only).
registerStock("ADBE Drop Shadow", (input, p, ctx) => {
  const k = input.scale ?? 1;
  const color = p.rgb(1, [0, 0, 0]);
  const opacity = Math.min(1, Math.max(0, p.num(2, 127.5) / 255));
  const [ux, uy] = directionVector(p.num(3, 135));
  const distance = Math.max(0, p.num(4, 5)) * k;
  const sigma = blurrinessSigma(p.num(5, 0)) * k;
  const shadowOnly = p.bool(6, false);
  const [dx, dy] = [ux * distance, uy * distance];
  const source = imageRect(input);
  const moved = growRect({ ...source, x: source.x + Math.floor(dx), y: source.y + Math.floor(dy) }, 1);
  let shadow = layerPass(
    ctx,
    moved,
    [input],
    `uniform vec2 u_offset;
uniform vec3 u_color;
uniform float u_opacity;`,
    `  float a = at(0, p - u_offset).a * u_opacity;
  outColor = vec4(u_color * a, a);`,
    (u) => {
      ctx.gl.uniform2f(u("u_offset"), dx, dy);
      ctx.gl.uniform3fv(u("u_color"), color);
      ctx.gl.uniform1f(u("u_opacity"), opacity);
    },
  );
  shadow = gaussian(ctx, shadow, sigma, sigma);
  const out = layerPass(
    ctx,
    shadowOnly ? imageRect(shadow) : unionRect(imageRect(shadow), source),
    [input, shadow],
    "uniform int u_only;",
    `  vec4 s = at(1, p);
  if (u_only == 1) { outColor = s; return; }
  vec4 o = at(0, p);
  outColor = o + s * (1.0 - o.a);`,
    (u) => ctx.gl.uniform1i(u("u_only"), shadowOnly ? 1 : 0),
    input.scale,
  );
  ctx.pool.release(shadow.target);
  ctx.pool.release(input.target);
  return out;
});

/** Glow's Composite Original popup. */
const Composite = { ON_TOP: 1, BEHIND: 2, NONE: 3 } as const;
/** Glow Operation popup entries this look-alike blends with. */
const Operation = { NONE: 1, NORMAL: 2, ADD: 3, MULTIPLY: 4, SCREEN: 6, DARKEN: 10, LIGHTEN: 11, DIFFERENCE: 12 } as const;
const SUPPORTED_OPERATIONS = new Set<number>(Object.values(Operation));

// Glow: the parts of the layer above Glow Threshold (in its brightest colour channel, or its alpha), blurred by
// Glow Radius, times Glow Intensity, in their own colours or ramped from Color B to Color A, then blended with the
// layer by Glow Operation (Behind), placed under it (On Top) or alone (None).
registerStock("ADBE Glo2", (input, p, ctx) => {
  const k = input.scale ?? 1;
  const basedOnAlpha = p.num(1, 2) === 1;
  const threshold = Math.min(1, Math.max(0, p.num(2, 153) / 255));
  const sigma = blurrinessSigma(p.num(3, 10)) * k;
  const intensity = Math.max(0, p.num(4, 1));
  const composite = p.num(5, Composite.BEHIND);
  let operation = p.num(6, Operation.ADD);
  if (!SUPPORTED_OPERATIONS.has(operation)) {
    ctx.warn("Glow: this Glow Operation is drawn as Add");
    operation = Operation.ADD;
  }
  const abColors = p.num(7, 1) !== 1;
  if (p.num(7, 1) === 3) ctx.warn("Glow: Arbitrary Map colours are drawn as A & B Colors");
  const [h, v] = blurAxes(p.num(14, 1));
  const bright = layerPass(
    ctx,
    imageRect(input),
    [input],
    `uniform float u_threshold;
uniform int u_alpha;`,
    `  vec4 c = at(0, p);
  vec3 s = straight(c);
  float level = u_alpha == 1 ? c.a : max(s.r, max(s.g, s.b));
  float m = clamp((level - u_threshold) / max(1.0 - u_threshold, 1e-3), 0.0, 1.0);
  outColor = c * m;`,
    (u) => {
      ctx.gl.uniform1f(u("u_threshold"), threshold);
      ctx.gl.uniform1i(u("u_alpha"), basedOnAlpha ? 1 : 0);
    },
  );
  const glow = gaussian(ctx, bright, h ? sigma : 0, v ? sigma : 0);
  const out = layerPass(
    ctx,
    composite === Composite.NONE ? imageRect(glow) : unionRect(imageRect(glow), imageRect(input)),
    [input, glow],
    `uniform float u_intensity;
uniform int u_composite;
uniform int u_operation;
uniform int u_ab;
uniform vec3 u_colorA;
uniform vec3 u_colorB;`,
    `  vec4 o = at(0, p);
  vec4 g = at(1, p);
  if (u_ab == 1) g = vec4(mix(u_colorB, u_colorA, g.a) * g.a, g.a);
  g = clamp(g * u_intensity, 0.0, 1.0);
  g.rgb = min(g.rgb, vec3(g.a));
  if (u_composite == 3) { outColor = g; return; }
  if (u_composite == 1) { outColor = o + g * (1.0 - o.a); return; }
  float a = o.a + g.a - o.a * g.a;
  vec3 c;
  if (u_operation == 1) { outColor = o; return; }
  else if (u_operation == 2) c = g.rgb + o.rgb * (1.0 - g.a);
  else if (u_operation == 3) { c = o.rgb + g.rgb; a = min(1.0, o.a + g.a); }
  else if (u_operation == 4) c = o.rgb * g.rgb + o.rgb * (1.0 - g.a) + g.rgb * (1.0 - o.a);
  else if (u_operation == 6) c = o.rgb + g.rgb - o.rgb * g.rgb;
  else if (u_operation == 10) c = min(o.rgb * g.a, g.rgb * o.a) + o.rgb * (1.0 - g.a) + g.rgb * (1.0 - o.a);
  else if (u_operation == 11) c = max(o.rgb * g.a, g.rgb * o.a) + o.rgb * (1.0 - g.a) + g.rgb * (1.0 - o.a);
  else c = abs(o.rgb * g.a - g.rgb * o.a) + o.rgb * (1.0 - g.a) + g.rgb * (1.0 - o.a);
  outColor = vec4(min(clamp(c, 0.0, 1.0), vec3(a)), a);`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform1f(u("u_intensity"), intensity);
      gl.uniform1i(u("u_composite"), composite);
      gl.uniform1i(u("u_operation"), operation);
      gl.uniform1i(u("u_ab"), abColors ? 1 : 0);
      gl.uniform3fv(u("u_colorA"), p.rgb(12, [1, 1, 1]));
      gl.uniform3fv(u("u_colorB"), p.rgb(13, [0, 0, 0]));
    },
    input.scale,
  );
  ctx.pool.release(glow.target);
  ctx.pool.release(input.target);
  return out;
});

/** Samples per axis a Mosaic block averages at most. */
const MOSAIC_SAMPLES = 16;

// Mosaic: the layer's box split into Horizontal x Vertical Blocks, each filled with its average colour (or, with
// Sharp Colors, the colour at its centre).
registerStock("ADBE Mosaic", (input, p, ctx, layer) => {
  const rect = layerRect(layer, input);
  const blocks = [Math.max(1, Math.round(p.num(1, 10))), Math.max(1, Math.round(p.num(2, 10)))];
  const size = [rect.width / blocks[0], rect.height / blocks[1]];
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    `uniform vec4 u_rect;
uniform vec2 u_block;
uniform ivec2 u_samples;
uniform int u_sharp;`,
    `  vec2 local = p - u_rect.xy;
  if (local.x < 0.0 || local.y < 0.0 || local.x >= u_rect.z || local.y >= u_rect.w) { outColor = at(0, p); return; }
  vec2 cell = u_rect.xy + floor(local / u_block) * u_block;
  if (u_sharp == 1) { outColor = at(0, cell + 0.5 * u_block); return; }
  vec4 sum = vec4(0.0);
  for (int j = 0; j < u_samples.y; j++)
    for (int i = 0; i < u_samples.x; i++)
      sum += at(0, cell + (vec2(i, j) + 0.5) / vec2(u_samples) * u_block);
  outColor = sum / float(u_samples.x * u_samples.y);`,
    (u) => {
      ctx.gl.uniform4f(u("u_rect"), rect.x, rect.y, rect.width, rect.height);
      ctx.gl.uniform2f(u("u_block"), size[0], size[1]);
      ctx.gl.uniform2i(u("u_samples"), Math.min(MOSAIC_SAMPLES, Math.max(1, Math.ceil(size[0]))), Math.min(MOSAIC_SAMPLES, Math.max(1, Math.ceil(size[1]))));
      ctx.gl.uniform1i(u("u_sharp"), p.bool(3, false) ? 1 : 0);
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

// Noise: every pixel's straight colour moved by up to half Amount of Noise, the same in all channels unless Use
// Color Noise; values past the range clip, or wrap around when Clipping is off. New noise every frame.
registerStock(
  "ADBE Noise2",
  (input, p, ctx, _layer, time) => {
    const amount = Math.min(1, Math.max(0, p.num(1, 0) / 100));
    if (!amount) return input;
    const out = layerPass(
      ctx,
      imageRect(input),
      [input],
      `uniform float u_amount;
uniform float u_seed;
uniform int u_color;
uniform int u_clip;
float hash(vec2 q, float s) { return fract(sin(dot(q, vec2(12.9898, 78.233)) + s * 43.7) * 43758.5453); }`,
      `  vec4 c = at(0, p);
  if (c.a <= 0.0) { outColor = c; return; }
  vec2 q = floor(p);
  vec3 n = u_color == 1 ? vec3(hash(q, u_seed), hash(q, u_seed + 1.0), hash(q, u_seed + 2.0)) : vec3(hash(q, u_seed));
  vec3 s = straight(c) + (n - 0.5) * u_amount;
  s = u_clip == 1 ? clamp(s, 0.0, 1.0) : fract(s);
  outColor = vec4(s * c.a, c.a);`,
      (u) => {
        ctx.gl.uniform1f(u("u_amount"), amount);
        ctx.gl.uniform1f(u("u_seed"), (Math.round(time * 1000) % 9973) / 7.0);
        ctx.gl.uniform1i(u("u_color"), p.bool(2, true) ? 1 : 0);
        ctx.gl.uniform1i(u("u_clip"), p.bool(3, true) ? 1 : 0);
      },
      input.scale,
    );
    ctx.pool.release(input.target);
    return out;
  },
  { scalable: true },
);
