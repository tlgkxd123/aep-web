// Stock Noise & Grain and Generate effects that colour the layer anew: Fractal Noise and 4-Color Gradient. Both
// keep the layer's alpha (as Gradient Ramp does) and lay their colour over the layer's by Blending Mode at Opacity;
// None shows their colour alone, at Opacity. Points are layer pixels, times the image's scale at a reduced
// resolution. Look-alikes from the effects' documented behaviour, not yet measured against After Effects renders.
import { FRACTAL_GLSL, FractalShape, NOISE_CELL, noiseSpace, octaveTransform, setFractalUniforms } from "./fractal.ts";
import { fourColorPower } from "./stockMath.ts";
import { imageRect, layerCenter, layerPass, layerRect, registerStock } from "./stockUtil.ts";

/** Fractal Noise's Blending Mode menu as After Effects stores it; 4-Color Gradient's is taken to be the same. */
const BLEND_MENU = ["None", "Normal", "(-", "Add", "Multiply", "Screen", "Overlay", "Soft Light", "Hard Light", "(-", "Color Dodge", "Color Burn", "(-", "Darken", "Lighten", "Difference", "Exclusion", "(-", "Hue", "Saturation", "Luminosity"];

/** Blending Mode choices: BLEND_MENU without its separators. */
const Blend = { NONE: 1, NORMAL: 2, ADD: 3, MULTIPLY: 4, SCREEN: 5, OVERLAY: 6, SOFT_LIGHT: 7, HARD_LIGHT: 8, COLOR_DODGE: 9, COLOR_BURN: 10, DARKEN: 11, LIGHTEN: 12, DIFFERENCE: 13, EXCLUSION: 14, HUE: 15, SATURATION: 16, LUMINOSITY: 17 } as const;

/** GLSL: `vec4 over(vec4 c, vec3 n)`, the layer's pixel c with straight colour n laid over it (u_blend, u_opacity). */
const OVER_GLSL = `
uniform int u_blend;
uniform float u_opacity;
vec3 blended(vec3 s, vec3 n) {
  if (u_blend == ${Blend.ADD}) return s + n;
  if (u_blend == ${Blend.MULTIPLY}) return s * n;
  if (u_blend == ${Blend.SCREEN}) return 1.0 - (1.0 - s) * (1.0 - n);
  if (u_blend == ${Blend.OVERLAY}) return mix(2.0 * s * n, 1.0 - 2.0 * (1.0 - s) * (1.0 - n), step(0.5, s));
  if (u_blend == ${Blend.SOFT_LIGHT}) {
    vec3 d = mix(((16.0 * s - 12.0) * s + 4.0) * s, sqrt(s), step(0.25, s));
    return mix(s - (1.0 - 2.0 * n) * s * (1.0 - s), s + (2.0 * n - 1.0) * (d - s), step(0.5, n));
  }
  if (u_blend == ${Blend.HARD_LIGHT}) return mix(2.0 * s * n, 1.0 - 2.0 * (1.0 - s) * (1.0 - n), step(0.5, n));
  if (u_blend == ${Blend.COLOR_DODGE}) return mix(s / max(1.0 - n, 1e-6), vec3(0.0), step(s, vec3(0.0)));
  if (u_blend == ${Blend.COLOR_BURN}) return mix(1.0 - (1.0 - s) / max(n, 1e-6), vec3(1.0), step(1.0, s));
  if (u_blend == ${Blend.DARKEN}) return min(s, n);
  if (u_blend == ${Blend.LIGHTEN}) return max(s, n);
  if (u_blend == ${Blend.DIFFERENCE}) return abs(s - n);
  if (u_blend == ${Blend.EXCLUSION}) return s + n - 2.0 * s * n;
  vec3 hs = rgb2hsl(s);
  vec3 hn = rgb2hsl(n);
  if (u_blend == ${Blend.HUE}) return hsl2rgb(vec3(hn.x, hs.y, hs.z));
  if (u_blend == ${Blend.SATURATION}) return hsl2rgb(vec3(hs.x, hn.y, hs.z));
  if (u_blend == ${Blend.LUMINOSITY}) return hsl2rgb(vec3(hs.x, hs.y, hn.z));
  return n;
}
vec4 over(vec4 c, vec3 n) {
  if (u_blend == ${Blend.NONE}) return vec4(n, 1.0) * (c.a * u_opacity);
  vec3 s = straight(c);
  return vec4(mix(s, clamp(blended(s, n), 0.0, 1.0), u_opacity) * c.a, c.a);
}
`;

/** Fractal Noise's Fractal Type menu as After Effects stores it. */
const FRACTAL_TYPE_MENU = ["Basic", "(-", "Turbulent Smooth", "Turbulent Basic", "Turbulent Sharp", "(-", "Dynamic", "Dynamic Progressive", "Dynamic Twist", "(-", "Max", "Smeary", "Swirly", "Rocky", "Cloudy", "Terrain", "Subscale", "Small Bumps", "Strings", "Threads"];
const FRACTAL_TYPES = FRACTAL_TYPE_MENU.filter((t) => !t.startsWith("(-"));

/** The shape each Fractal Type is drawn with: the first four exactly, the others by the closest of them. */
const FRACTAL_TYPE_SHAPES = [1, 2, 3, 4, 1, 1, 1, 3, 1, 1, 4, 1, 1, 1, 2, 4, 4];

const Overflow = { CLIP: 1, SOFT_CLAMP: 2, WRAP_BACK: 3, HDR: 4 } as const;

// Fractal Noise: fractal value noise (fractal.ts) over the layer, through Contrast and Brightness (about ½), Invert
// and Overflow (Allow HDR Results clips in 8 bpc). Offset Turbulence is where the noise is anchored, and Scale makes
// its cells NOISE_CELL × Scale pixels wide.
registerStock("ADBE Fractal Noise", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const typeChoice = p.choice(1, 1, FRACTAL_TYPE_MENU);
  const shape = FRACTAL_TYPE_SHAPES[typeChoice - 1] ?? FractalShape.BASIC;
  if (typeChoice > 4) ctx.warn(`Fractal Noise: the ${FRACTAL_TYPES[typeChoice - 1] ?? "chosen"} Fractal Type is drawn as a basic or turbulent type`);
  if (p.bool(31, false)) ctx.warn("Fractal Noise: Perspective Offset is ignored");
  const uniform = p.bool(9, true);
  const scale: [number, number] = uniform ? [p.num(10, 100) / 100, p.num(10, 100) / 100] : [p.num(11, 100) / 100, p.num(12, 100) / 100];
  const toNoise = noiseSpace(p.vec(13, layerCenter(layer, input)), scale, p.num(8, 0), k);
  const subOffset = p.vec(20, [0, 0]);
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    `${FRACTAL_GLSL}${OVER_GLSL}
uniform mat3 u_toNoise;
uniform int u_invert;
uniform float u_contrast;
uniform float u_brightness;
uniform int u_overflow;`,
    `  vec4 c = at(0, p);
  if (c.a <= 0.0) { outColor = vec4(0.0); return; }
  float v = fractal((u_toNoise * vec3(p, 1.0)).xy, 0u);
  if (u_invert == 1) v = 1.0 - v;
  v = (v - 0.5) * u_contrast + 0.5 + u_brightness;
  if (u_overflow == ${Overflow.SOFT_CLAMP}) v = v > 0.75 ? 0.75 + 0.25 * tanh((v - 0.75) * 4.0) : v < 0.25 ? 0.25 + 0.25 * tanh((v - 0.25) * 4.0) : v;
  else if (u_overflow == ${Overflow.WRAP_BACK}) v = 1.0 - abs(1.0 - mod(v, 2.0));
  outColor = over(c, vec3(clamp(v, 0.0, 1.0)));`,
    (u) => {
      const gl = ctx.gl;
      const m = toNoise;
      gl.uniformMatrix3fv(u("u_toNoise"), false, [m[0], m[1], 0, m[2], m[3], 0, m[4], m[5], 1]);
      gl.uniform1i(u("u_invert"), p.bool(3, false) ? 1 : 0);
      gl.uniform1f(u("u_contrast"), p.num(4, 100) / 100);
      gl.uniform1f(u("u_brightness"), p.num(5, 0) / 100);
      gl.uniform1i(u("u_overflow"), p.choice(6, Overflow.HDR, ["Clip", "Soft Clamp", "Wrap Back", "Allow HDR Results"]));
      gl.uniform1i(u("u_blend"), p.choice(30, Blend.NORMAL, BLEND_MENU));
      gl.uniform1f(u("u_opacity"), Math.min(1, Math.max(0, p.num(29, 100) / 100)));
      setFractalUniforms(gl, u, {
        noiseType: p.choice(2, 3),
        shape,
        complexity: p.num(15, 6),
        persistence: p.num(17, 70) / 100,
        sub: octaveTransform(p.num(18, 56), p.num(19, 0), [-subOffset[0] / NOISE_CELL, -(subOffset[1] ?? 0) / NOISE_CELL]),
        evolution: p.num(23, 0),
        cycle: p.bool(25, false),
        revolutions: p.num(26, 1),
        seed: p.num(27, 0),
      });
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});

// 4-Color Gradient: the four colours blended by inverse distance to their points, to a power Blend sets
// (fourColorPower); Jitter adds grain of up to a quarter of the range at 100 %.
registerStock("ADBE 4ColorGradient", (input, p, ctx, layer) => {
  const k = input.scale ?? 1;
  const r = layerRect(layer, input);
  const [x0, y0, w, h] = [r.x / k, r.y / k, r.width / k, r.height / k];
  const corner = (fx: number, fy: number) => [x0 + fx * w, y0 + fy * h];
  const points = [p.vec(1, corner(0.1, 0.1)), p.vec(3, corner(0.9, 0.1)), p.vec(5, corner(0.1, 0.9)), p.vec(7, corner(0.9, 0.9))];
  const colors = [p.rgb(2, [1, 1, 0]), p.rgb(4, [0, 1, 1]), p.rgb(6, [1, 0, 1]), p.rgb(8, [0, 0, 1])];
  const out = layerPass(
    ctx,
    imageRect(input),
    [input],
    `${OVER_GLSL}
uniform vec2 u_points[4];
uniform vec3 u_colors[4];
uniform float u_power;
uniform float u_jitter;
float grain(vec2 q) { return fract(sin(dot(q, vec2(12.9898, 78.233))) * 43758.5453); }`,
    `  vec4 c = at(0, p);
  if (c.a <= 0.0) { outColor = vec4(0.0); return; }
  float d[4];
  float nearest = 1e9;
  for (int i = 0; i < 4; i++) { d[i] = length(p - u_points[i]); nearest = min(nearest, d[i]); }
  vec3 col = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    float w = nearest < 1e-4 ? (d[i] < 1e-4 ? 1.0 : 0.0) : pow(nearest / d[i], u_power);
    col += w * u_colors[i];
    wsum += w;
  }
  col /= wsum;
  if (u_jitter > 0.0) col += (grain(floor(p)) - 0.5) * u_jitter;
  outColor = over(c, clamp(col, 0.0, 1.0));`,
    (u) => {
      const gl = ctx.gl;
      gl.uniform2fv(u("u_points"), points.flatMap((q) => [q[0] * k, (q[1] ?? 0) * k]));
      gl.uniform3fv(u("u_colors"), colors.flat());
      gl.uniform1f(u("u_power"), fourColorPower(p.num(9, 100)));
      gl.uniform1f(u("u_jitter"), Math.min(1, Math.max(0, p.num(10, 0) / 100)) * 0.25);
      gl.uniform1i(u("u_blend"), p.choice(14, Blend.NONE, BLEND_MENU));
      gl.uniform1f(u("u_opacity"), Math.min(1, Math.max(0, p.num(13, 100) / 100)));
    },
    input.scale,
  );
  ctx.pool.release(input.target);
  return out;
});
