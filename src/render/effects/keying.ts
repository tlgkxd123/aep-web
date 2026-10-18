// Keying and Matte effects: Linear Color Key, Color Key, Luma Key, Extract, Color Range, Color Difference Key,
// Difference Matte, Spill Suppressor, Advanced Spill Suppressor, Matte Choker, Simple Wire Removal and Key
// Cleaner. The per-pixel models are keyingMath.ts's, fitted to After Effects' renders of the keying fixtures
// (scripts/fixtures/build_keying.py, scripts/check-keying-fit.ts).
import type { LayerImage, RenderContext } from "../registry.ts";
import { copyImage, grown, mapPass, PASS_HEADER, type Uniforms } from "./fxextraUtil.ts";
import { CHROMA_WEIGHTS, LINEAR_SOFTNESS, LINEAR_TOLERANCE, MatchColors, rgbToHsl } from "./keyingMath.ts";
import { COLOR_LIB, compOf, gaussian, imageRect, layerPass, layerRect, registerStock } from "./stockUtil.ts";

/**
 * GLSL run on every content pixel: `c` the exact premultiplied texel, `s` its straight colour; `body` sets `m`, the
 * share of the pixel's alpha kept, and may change `s`. With `restore` set, `m` is instead the share of the missing
 * alpha left missing (Keep Colors).
 */
function keyShader(decls: string, body: string): string {
  return `${PASS_HEADER}${COLOR_LIB}
uniform vec2 u_size;
uniform float u_pad;
uniform int u_view;
${decls}
void main() {
  vec2 px = gl_FragCoord.xy;
  if (px.x < u_pad || px.y < u_pad || px.x > u_size.x - u_pad || px.y > u_size.y - u_pad) { outColor = vec4(0.0); return; }
  // Exact texels: keys read the colour as a ratio to the alpha, which a filtered read would mix with a neighbour's.
  vec4 c = texelFetch(u_source, ivec2(px), 0);
  vec3 s = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  float m = 1.0;
  bool restore = false;
  bool keyClear = false;
${body}
  // A transparent pixel has no colour to match: it is never keyed, nor restored, unless the key takes it as black
  // (keyClear), which then spreads into the layer's edges under Edge Thin and Edge Feather.
  m = c.a > 0.0 || keyClear ? clamp(m, 0.0, 1.0) : 1.0;
  float a = restore ? (c.a > 0.0 ? c.a + (1.0 - c.a) * (1.0 - m) : 0.0) : c.a * m;
  outColor = u_view == 3 ? vec4(vec3(a), 1.0) : u_view == 4 ? vec4(a) : u_view == 5 ? vec4(m) : vec4(clamp(s, 0.0, 1.0) * a, a);
}`;
}

/**
 * View popups: 1 the result, 2 the source untouched, 3 the result's alpha as grey; 4 the alpha alone and 5 the key's
 * share alone (whatever the pixel's alpha), as mattes.
 */
export const View = { FINAL: 1, SOURCE: 2, MATTE: 3, ALPHA: 4, KEY: 5 } as const;

export function keyPass(ctx: RenderContext, input: LayerImage, decls: string, body: string, view: number, setUniforms?: Uniforms): LayerImage {
  if (view === View.SOURCE) return input;
  return mapPass(ctx, input, keyShader(decls, body), (u) => {
    ctx.gl.uniform1i(u("u_view"), view);
    setUniforms?.(u);
  });
}

/** A matte (every channel the value) of `input`, which stays valid: View.ALPHA its keyed alpha, View.KEY the key alone. */
function keyMatte(ctx: RenderContext, input: LayerImage, decls: string, body: string, view: number, setUniforms?: Uniforms): LayerImage {
  const out = ctx.pool.acquire(input.target.width, input.target.height, false);
  ctx.pass(ctx.program(keyShader(decls, body)), out, [input.target], (u) => {
    ctx.gl.uniform1i(u("u_source"), 0);
    ctx.gl.uniform2f(u("u_size"), input.target.width, input.target.height);
    ctx.gl.uniform1f(u("u_pad"), ctx.pad);
    ctx.gl.uniform1i(u("u_view"), view);
    setUniforms?.(u);
  });
  return { ...input, target: out };
}

/**
 * Color Key and Luma Key: the key (transparent pixels are not keyed), thinned by Edge Thin (layer pixels; positive
 * shrinks the opaque part) and softened by Edge Feather, multiplied into the layer's alpha. Releases `input`.
 */
function keyWithEdges(ctx: RenderContext, input: LayerImage, decls: string, body: string, thin: number, feather: number, setUniforms?: Uniforms): LayerImage {
  const k = input.scale ?? 1;
  const r = Math.round(Math.round(thin) * k);
  if (r === 0 && feather <= 0) return keyPass(ctx, input, decls, body, View.FINAL, setUniforms);
  let matte = keyMatte(ctx, input, decls, body, View.KEY, setUniforms);
  matte = morph(ctx, matte, r);
  if (feather > 0) matte = featherMatte(ctx, matte, feather * k);
  return withMatte(ctx, input, matte, View.FINAL, true);
}

const FEATHER_FS = `${PASS_HEADER}
uniform vec2 u_size;
uniform float u_pad;
uniform vec2 u_dir;
uniform int u_radius;
uniform float u_sigma;
void main() {
  vec2 px = gl_FragCoord.xy;
  if (px.x < u_pad || px.y < u_pad || px.x > u_size.x - u_pad || px.y > u_size.y - u_pad) { outColor = vec4(0.0); return; }
  vec4 sum = vec4(0.0);
  float weight = 0.0;
  for (int i = -u_radius; i <= u_radius; i++) {
    float w = exp(-float(i * i) / (2.0 * u_sigma * u_sigma));
    vec2 q = clamp(px + u_dir * float(i), vec2(u_pad + 0.5), u_size - u_pad - 0.5);
    sum += w * texture(u_source, q / u_size);
    weight += w;
  }
  outColor = sum / weight;
}`;

/**
 * The keying effects' blur (Edge Feather, Blur Before Difference; releases `image`): a Gaussian truncated at the
 * radius, its edge pixels repeated. The deviation, fitted to After Effects' feathered keys of 2, 6 and 15 pixels and
 * Difference Matte's blurs of 2 and 6, grows linearly with the radius but does not start at zero.
 */
function featherMatte(ctx: RenderContext, image: LayerImage, feather: number): LayerImage {
  const sigma = 0.3985 * feather + 0.443;
  let matte = image;
  for (const dir of [[1, 0], [0, 1]]) {
    matte = mapPass(ctx, matte, FEATHER_FS, (u) => {
      ctx.gl.uniform2f(u("u_dir"), dir[0], dir[1]);
      ctx.gl.uniform1i(u("u_radius"), Math.ceil(feather));
      ctx.gl.uniform1f(u("u_sigma"), sigma);
    });
  }
  return matte;
}

const MORPH_FS = `${PASS_HEADER}
uniform vec2 u_size;
uniform float u_pad;
uniform vec2 u_dir;
uniform int u_radius;
uniform int u_max;
// The matte's edge pixels repeat outward, as the layer's own edge is no edge of the key.
float at(vec2 q) {
  return texture(u_source, clamp(q, vec2(u_pad + 0.5), u_size - u_pad - 0.5) / u_size).a;
}
void main() {
  vec2 px = gl_FragCoord.xy;
  if (px.x < u_pad || px.y < u_pad || px.x > u_size.x - u_pad || px.y > u_size.y - u_pad) { outColor = vec4(0.0); return; }
  float acc = at(px);
  for (int i = -u_radius; i <= u_radius; i++) {
    float v = at(px + u_dir * float(i));
    acc = u_max == 1 ? max(acc, v) : min(acc, v);
  }
  outColor = vec4(acc);
}`;

/** A matte (alpha only, in every channel) eroded (`radius` > 0) or dilated (< 0) over a square of whole pixels. */
export function morph(ctx: RenderContext, matte: LayerImage, radius: number): LayerImage {
  const r = Math.round(Math.abs(radius));
  if (!r) return matte;
  for (const dir of [[1, 0], [0, 1]]) {
    matte = mapPass(ctx, matte, MORPH_FS, (u) => {
      ctx.gl.uniform2f(u("u_dir"), dir[0], dir[1]);
      ctx.gl.uniform1i(u("u_radius"), r);
      ctx.gl.uniform1i(u("u_max"), radius < 0 ? 1 : 0);
    });
  }
  return matte;
}

const COMBINE_FS = `${PASS_HEADER}
uniform sampler2D u_extra0;
uniform int u_view;
uniform int u_multiply;
void main() {
  vec4 c = texelFetch(u_source, ivec2(gl_FragCoord.xy), 0);
  float a = texelFetch(u_extra0, ivec2(gl_FragCoord.xy), 0).a;
  if (u_multiply == 1) a *= c.a;
  vec3 s = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
  outColor = u_view == 3 ? vec4(vec3(a), 1.0) : vec4(min(s, 1.0) * a, a);
}`;

/** The colour of `colour` under the alpha of `matte` (or its own alpha times `matte`'s); releases both. */
export function withMatte(ctx: RenderContext, colour: LayerImage, matte: LayerImage, view: number, multiply = false): LayerImage {
  const out = mapPass(ctx, colour, COMBINE_FS, (u) => {
    ctx.gl.uniform1i(u("u_view"), view);
    ctx.gl.uniform1i(u("u_multiply"), multiply ? 1 : 0);
  }, [matte]);
  ctx.pool.release(matte.target);
  return out;
}

const uniform3 = (ctx: RenderContext, location: WebGLUniformLocation | null, v: number[]) => ctx.gl.uniform3f(location, v[0], v[1], v[2]);

// Linear Color Key (keyingMath.linearKey, linearKeyAlpha).
registerStock("ADBE Linear Color Key2", (input, p, ctx) => {
  const key = p.rgb(3, [0, 0, 1]);
  const match = Math.round(p.num(4, MatchColors.RGB));
  const tolerance = p.num(5, 0) / 100;
  const softness = p.num(6, 10) / 100;
  const t = tolerance * (LINEAR_TOLERANCE[match] ?? 1) + (match === MatchColors.HUE && softness <= 0 ? 1 / 255 : 0);
  return keyPass(
    ctx,
    input,
    `uniform vec3 u_key;
uniform float u_keyHue;
uniform int u_match;
uniform vec3 u_chroma;
uniform float u_tolerance2;
uniform float u_ramp;
uniform int u_keep;
float distance2(vec3 s) {
  if (u_match == 2) {
    float d = mod(abs(floor(rgb2hsl(s).x * 255.0 + 0.5) - u_keyHue), 255.0);
    d = min(d, 255.0 - d) * (2.0 / 255.0);
    return d * d;
  }
  vec3 d = s - u_key;
  if (u_match == 3) {
    vec3 pairs = vec3(d.r - d.g, d.r - d.b, d.g - d.b);
    return dot(u_chroma, pairs * pairs);
  }
  return dot(d, d) / 3.0;
}`,
    `  float e = distance2(clamp(s, 0.0, 1.0)) - u_tolerance2;
  m = u_ramp > 0.0 ? e / u_ramp : (e > 0.0 ? 1.0 : 0.0);
  restore = u_keep == 1;`,
    p.num(2, View.FINAL),
    (u) => {
      uniform3(ctx, u("u_key"), key);
      ctx.gl.uniform1f(u("u_keyHue"), Math.round(rgbToHsl(key)[0] * 255));
      ctx.gl.uniform1i(u("u_match"), match);
      uniform3(ctx, u("u_chroma"), CHROMA_WEIGHTS);
      ctx.gl.uniform1f(u("u_tolerance2"), t * t);
      ctx.gl.uniform1f(u("u_ramp"), softness > 0 ? (LINEAR_SOFTNESS[match] ?? 1) * softness : 0);
      ctx.gl.uniform1i(u("u_keep"), p.num(7, 1) === 2 ? 1 : 0);
    },
  );
});

// Color Key (keyingMath.colorKey).
registerStock("ADBE Color Key", (input, p, ctx) =>
  keyWithEdges(
    ctx,
    input,
    `uniform vec3 u_key;
uniform float u_tolerance;`,
    `  float spread = c.a < 1.0 ? 0.5 / c.a : 0.0;
  vec3 d = max(abs(s - u_key) * 255.0 - spread, 0.0);
  m = length(d) <= u_tolerance + 1e-3 ? 0.0 : 1.0;`,
    p.num(3, 0),
    p.num(4, 0),
    (u) => {
      uniform3(ctx, u("u_key"), p.rgb(1, [0, 0, 1]));
      ctx.gl.uniform1f(u("u_tolerance"), p.num(2, 0));
    },
  ),
);

// Luma Key (keyingMath.lumaKey).
registerStock("ADBE Luma Key", (input, p, ctx) =>
  keyWithEdges(
    ctx,
    input,
    `uniform int u_type;
uniform float u_threshold;
uniform float u_tolerance;`,
    `  float l = dot(floor(clamp(s, 0.0, 1.0) * 255.0 + 0.5), vec3(30.0, 59.0, 11.0));
  float d = abs(l - u_threshold);
  if (u_type == 1) m = l > u_threshold ? 0.0 : 1.0;
  else if (u_type == 2) m = l < u_threshold ? 0.0 : 1.0;
  else if (u_type == 3) m = d < u_tolerance ? 0.0 : 1.0;
  else m = d > u_tolerance ? 0.0 : 1.0;
  keyClear = true;`,
    p.num(4, 0),
    p.num(5, 0),
    (u) => {
      // keyingMath.keyLuma100: luma and its limits times 100, whole numbers that compare exactly.
      ctx.gl.uniform1i(u("u_type"), p.num(1, 2));
      ctx.gl.uniform1f(u("u_threshold"), Math.round(p.num(2, 0) * 100));
      ctx.gl.uniform1f(u("u_tolerance"), Math.round(p.num(3, 0) * 100));
    },
  ),
);

// Extract (keyingMath.extract).
registerStock("ADBE Extract", (input, p, ctx) =>
  keyPass(
    ctx,
    input,
    `uniform int u_channel;
uniform float u_black;
uniform float u_white;
uniform float u_blackSoftness;
uniform float u_whiteSoftness;
uniform int u_invert;`,
    `  vec3 s8 = floor(clamp(s, 0.0, 1.0) * 255.0 + 0.5);
  // keyingMath.luma8: Rec. 601 in 16-bit fixed point; every partial sum is a whole number below 2^24.
  float y = floor((dot(s8, vec3(19595.0, 38470.0, 7471.0)) + 32768.0) / 65536.0);
  float v = u_channel == 5 ? floor(c.a * 255.0 + 0.5) : u_channel == 1 ? y : s8[u_channel - 2];
  if (v > u_white) m = u_whiteSoftness > 0.0 ? clamp(1.0 - (v - u_white) / u_whiteSoftness, 0.0, 1.0) : 0.0;
  else if (v < u_black && v < u_white) m = u_blackSoftness > 0.0 ? clamp(1.0 - (u_black - v) / u_blackSoftness, 0.0, 1.0) : 0.0;
  if (u_invert == 1) m = 1.0 - m;`,
    View.FINAL,
    (u) => {
      ctx.gl.uniform1i(u("u_channel"), p.num(2, 1));
      ctx.gl.uniform1f(u("u_black"), p.num(3, 0));
      ctx.gl.uniform1f(u("u_white"), p.num(4, 255));
      ctx.gl.uniform1f(u("u_blackSoftness"), p.num(5, 0));
      ctx.gl.uniform1f(u("u_whiteSoftness"), p.num(6, 0));
      ctx.gl.uniform1i(u("u_invert"), p.bool(7, false) ? 1 : 0);
    },
  ),
);

// Color Range (keyingMath.colorRange).
registerStock("ADBE Color Range", (input, p, ctx) =>
  keyPass(
    ctx,
    input,
    `uniform int u_space;
uniform vec3 u_min;
uniform vec3 u_max;
uniform float u_fuzziness;
vec3 coordinates(vec3 s) {
  if (u_space == 3) return s * 255.0;
  float y = luma(s);
  if (u_space == 2) return vec3(y, (s.b - y) * 0.565 + 0.5, (s.r - y) * 0.713 + 0.5) * 255.0;
  vec3 lin = mix(s / 12.92, pow((s + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), s));
  vec3 xyz = vec3(dot(lin, vec3(0.4124, 0.3576, 0.1805)) / 0.95047, dot(lin, vec3(0.2126, 0.7152, 0.0722)), dot(lin, vec3(0.0193, 0.1192, 0.9505)) / 1.08883);
  vec3 f = mix(7.787 * xyz + 16.0 / 116.0, pow(xyz, vec3(1.0 / 3.0)), step(vec3(0.008856), xyz));
  return vec3((116.0 * f.y - 16.0) / 100.0 * 255.0, 500.0 * (f.x - f.y) + 128.0, 200.0 * (f.y - f.z) + 128.0);
}`,
    `  vec3 q = coordinates(clamp(s, 0.0, 1.0));
  vec3 d = max(u_min - q, q - u_max);
  vec3 eased;
  if (u_fuzziness > 0.0) {
    vec3 x = clamp(d / u_fuzziness, 0.0, 1.0);
    eased = mix(2.0 * x * x, 1.0 - 2.0 * (1.0 - x) * (1.0 - x), step(0.5, x));
  } else eased = step(vec3(1e-6), d);
  m = 1.0 - (1.0 - eased.x) * (1.0 - eased.y) * (1.0 - eased.z);`,
    View.FINAL,
    (u) => {
      ctx.gl.uniform1i(u("u_space"), p.num(3, 1));
      ctx.gl.uniform3f(u("u_min"), p.num(4, 127), p.num(6, 127), p.num(8, 127));
      ctx.gl.uniform3f(u("u_max"), p.num(5, 127), p.num(7, 127), p.num(9, 127));
      ctx.gl.uniform1f(u("u_fuzziness"), p.num(2, 20));
    },
  ),
);

// Difference Matte: the pixels whose colour matches the Difference Layer's source (centred on the layer, or stretched
// over it) within Matching Tolerance are keyed out, softened over Matching Softness (a ramp of the squared distance,
// as Linear Color Key's); both are blurred first by Blur Before Difference. It reads another layer, so it is drawn
// every frame.
registerStock(
  "ADBE Difference Matte2",
  (input, p, ctx, layer, time) => {
    const view = p.num(1, View.FINAL);
    if (view === View.SOURCE) return input;
    const index = Math.round(p.num(2, 0));
    const other = index > 0 ? compOf(ctx, layer)?.layers.find((l) => l.index === index && l !== layer) : undefined;
    let plate: LayerImage | null = other ? ctx.layerImage(other, time, false) : null;
    const k = input.scale ?? 1;
    const blur = p.num(6, 0);
    let source = input;
    if (blur > 0) {
      source = featherMatte(ctx, copyImage(ctx, input), blur * k);
      if (plate) plate = featherMatte(ctx, plate, blur * k);
    }
    const rect = layerRect(layer, input);
    let scale = [1, 1];
    let offset = [0, 0];
    if (plate && other) {
      const mk = plate.scale ?? 1;
      const mrect = layerRect(other, plate);
      if (p.num(3, 1) === 2) scale = [mrect.width / rect.width, mrect.height / rect.height];
      else scale = [mk / k, mk / k];
      offset = [mrect.x + mrect.width / 2 - (rect.x + rect.width / 2) * scale[0], mrect.y + mrect.height / 2 - (rect.y + rect.height / 2) * scale[1]];
    }
    const sources = plate ? [input, source, plate] : [input, source];
    const out = layerPass(
      ctx,
      imageRect(input),
      sources,
      `uniform int u_view;
uniform int u_hasPlate;
uniform float u_tolerance;
uniform float u_softness;
uniform vec2 u_scale;
uniform vec2 u_offset;`,
      `  vec4 c = at(0, p);
  vec4 b = at(1, p);
  vec4 o = u_hasPlate == 1 ? at(2, p * u_scale + u_offset) : vec4(0.0);
  vec3 d3 = (b.rgb - o.rgb) * 255.0;
  float e = dot(d3, d3) - u_tolerance * u_tolerance;
  float m = u_softness > 0.0 ? clamp(e / u_softness, 0.0, 1.0) : (e > 0.0 ? 1.0 : 0.0);
  float a = c.a * m;
  outColor = u_view == 3 ? vec4(vec3(a), 1.0) : vec4(straight(c) * a, a);`,
      (u) => {
        ctx.gl.uniform1i(u("u_view"), view);
        ctx.gl.uniform1i(u("u_hasPlate"), plate ? 1 : 0);
        // Fitted to keying_dmatte (scripts/check-keying-dmatte.ts): the premultiplied RGB distance in 8-bit steps
        // against the tolerance, its square ramped over the softness.
        ctx.gl.uniform1f(u("u_tolerance"), p.num(4, 15) * 4.37);
        ctx.gl.uniform1f(u("u_softness"), p.num(5, 0) * 1302.6);
        ctx.gl.uniform2f(u("u_scale"), scale[0], scale[1]);
        ctx.gl.uniform2f(u("u_offset"), offset[0], offset[1]);
      },
      input.scale,
    );
    if (plate) ctx.pool.release(plate.target);
    if (source !== input) ctx.pool.release(source.target);
    ctx.pool.release(input.target);
    return out;
  },
  { cacheable: false, scalable: true },
);

const LEVEL_FS = `${PASS_HEADER}
uniform float u_threshold;
uniform float u_width;
void main() {
  float a = texelFetch(u_source, ivec2(gl_FragCoord.xy), 0).a;
  float v = u_width > 0.0 ? clamp((a - u_threshold) / u_width + 0.5, 0.0, 1.0) : step(u_threshold, a);
  outColor = vec4(v);
}`;

// Matte Choker: per stage, the matte blurred by Geometric Softness, then cut at a level Choke sets (positive chokes,
// negative spreads) with a ramp as wide as Gray Level Softness; both stages repeated Iterations times.
registerStock("ADBE Matte Choker", (input, p, ctx) => {
  const k = input.scale ?? 1;
  const stages = [
    [p.num(1, 4), p.num(2, 75), p.num(3, 0.1)],
    [p.num(4, 0), p.num(5, 0), p.num(6, 1)],
  ];
  const iterations = Math.max(1, Math.min(100, Math.round(p.num(7, 1))));
  const reach = Math.ceil(iterations * (stages[0][0] + stages[1][0]) * k) + 1;
  const image = grown(ctx, input, reach);
  let matte = keyMatte(ctx, image, "", "", View.ALPHA);
  for (let i = 0; i < iterations; i++) {
    for (const [softness, choke, gray] of stages) {
      if (softness <= 0 && choke === 0) continue;
      if (softness > 0) matte = gaussian(ctx, matte, (softness * k) / 2, (softness * k) / 2, { repeatEdges: imageRect(matte) });
      matte = mapPass(ctx, matte, LEVEL_FS, (u) => {
        ctx.gl.uniform1f(u("u_threshold"), 0.5 + choke / 254);
        ctx.gl.uniform1f(u("u_width"), gray);
      });
    }
  }
  return withMatte(ctx, image, matte, View.FINAL);
});

// Spill Suppressor (keyingMath.spillSuppress).
registerStock("ADBE Spill Suppressor", (input, p, ctx) => {
  const key = p.rgb(1, [0, 0, 1]);
  const main = key[1] >= key[0] && key[1] >= key[2] ? 1 : key[2] >= key[0] ? 2 : 0;
  return keyPass(
    ctx,
    input,
    `uniform int u_main;
uniform float u_amount;`,
    `  vec3 o = s;
  o[u_main] = max(0.0, s[u_main] - u_amount * max(0.0, s[u_main] - s[(u_main + 2) % 3]));
  s = o;`,
    View.FINAL,
    (u) => {
      ctx.gl.uniform1i(u("u_main"), main);
      ctx.gl.uniform1f(u("u_amount"), p.num(3, 100) / 100);
    },
  );
});

// Advanced Spill Suppressor's Standard method (keyingMath.spillStandard); Suppression is parameter 1001. Its Key
// Color belongs to the Ultra settings.
registerStock("ADBE Spill2", (input, p, ctx) => {
  if (p.num(1, 1) !== 1) {
    ctx.warn("Advanced Spill Suppressor's Ultra method is not rendered yet");
    return input;
  }
  return keyPass(
    ctx,
    input,
    "uniform float u_amount;",
    "  s.g -= u_amount * max(0.0, s.g - (s.r + s.b) * 0.5);",
    View.FINAL,
    (u) => ctx.gl.uniform1f(u("u_amount"), p.num(1001, 100) / 100),
  );
});
