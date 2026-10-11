#version 450
// Composites a comp-space layer image (u_source) onto the backdrop, after an optional track matte and the layer
// opacity (COMPOSITE_FS in src/render/shaders.ts). All images hold premultiplied RGBA of the same size.
layout(set = 0, binding = 0) uniform sampler2D u_backdrop;
layout(set = 0, binding = 1) uniform sampler2D u_source;
layout(set = 0, binding = 2) uniform sampler2D u_matte;
// Adjustment layers: u_source is the backdrop with the layer's effects, applied where u_coverage's alpha is.
layout(set = 0, binding = 3) uniform sampler2D u_coverage;
layout(push_constant) uniform Push {
  int matteMode;
  float matteOpacity;
  int mode;
  float opacity;
  int adjust;
} pc;
layout(location = 0) out vec4 outColor;
// 8-bit targets: values rounded half up here, as the browser's WebGL does, rather than by the device's own rule for ties.
// precise keeps the product rounded to float before the rounding (a fused multiply-add would not).
vec4 quantize(vec4 c) {
  precise vec4 scaled = clamp(c, 0.0, 1.0) * 255.0;
  precise vec4 rounded = floor(scaled + 0.5);
  return rounded / 255.0;
}

const int NORMAL = 5212, DISSOLVE = 5213, DANCING_DISSOLVE = 5214, DARKEN = 5215, MULTIPLY = 5216, LINEAR_BURN = 5217,
  COLOR_BURN = 5218, CLASSIC_COLOR_BURN = 5219, ADD = 5220, LIGHTEN = 5221, SCREEN = 5222, LINEAR_DODGE = 5223,
  COLOR_DODGE = 5224, CLASSIC_COLOR_DODGE = 5225, OVERLAY = 5226, SOFT_LIGHT = 5227, HARD_LIGHT = 5228,
  LINEAR_LIGHT = 5229, VIVID_LIGHT = 5230, PIN_LIGHT = 5231, HARD_MIX = 5232, DIFFERENCE = 5233,
  CLASSIC_DIFFERENCE = 5234, EXCLUSION = 5235, HUE = 5236, SATURATION = 5237, COLOR = 5238, LUMINOSITY = 5239,
  STENCIL_ALPHA = 5240, STENCIL_LUMA = 5241, SILHOUETTE_ALPHA = 5242, SILHOUETTE_LUMA = 5243, ALPHA_ADD = 5244,
  LIGHTER_COLOR = 5246, DARKER_COLOR = 5247, SUBTRACT = 5248, DIVIDE = 5249;
const int MATTE_NONE = 0, MATTE_ALPHA_INVERTED = 2, MATTE_LUMA = 3, MATTE_LUMA_INVERTED = 4;

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

// Blend of straight backdrop color b and straight source color s.
vec3 blendColor(vec3 b, vec3 s) {
  int m = pc.mode;
  if (m == MULTIPLY) return b * s;
  if (m == SCREEN) return b + s - b * s;
  if (m == OVERLAY) return vec3(hardLight(s.r, b.r), hardLight(s.g, b.g), hardLight(s.b, b.b));
  if (m == DARKEN) return min(b, s);
  if (m == LIGHTEN) return max(b, s);
  if (m == LINEAR_DODGE) return min(b + s, vec3(1.0));
  if (m == SUBTRACT) return max(b - s, vec3(0.0));
  if (m == DIVIDE) return vec3(s.r <= 0.0 ? 1.0 : min(1.0, b.r / s.r), s.g <= 0.0 ? 1.0 : min(1.0, b.g / s.g), s.b <= 0.0 ? 1.0 : min(1.0, b.b / s.b));
  if (m == DIFFERENCE || m == CLASSIC_DIFFERENCE) return abs(b - s);
  if (m == EXCLUSION) return b + s - 2.0 * b * s;
  if (m == COLOR_DODGE || m == CLASSIC_COLOR_DODGE) return vec3(colorDodge(b.r, s.r), colorDodge(b.g, s.g), colorDodge(b.b, s.b));
  if (m == COLOR_BURN || m == CLASSIC_COLOR_BURN) return vec3(colorBurn(b.r, s.r), colorBurn(b.g, s.g), colorBurn(b.b, s.b));
  if (m == LINEAR_BURN) return max(b + s - 1.0, vec3(0.0));
  if (m == SOFT_LIGHT) return vec3(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b));
  if (m == HARD_LIGHT) return vec3(hardLight(b.r, s.r), hardLight(b.g, s.g), hardLight(b.b, s.b));
  if (m == LINEAR_LIGHT) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
  if (m == VIVID_LIGHT) return vec3(vividLight(b.r, s.r), vividLight(b.g, s.g), vividLight(b.b, s.b));
  if (m == PIN_LIGHT) return mix(min(b, 2.0 * s), max(b, 2.0 * s - 1.0), step(0.5, s));
  if (m == HARD_MIX) return step(1.0, b + s);
  if (m == HUE) return setLum(setSat(s, sat(b)), lum(b));
  if (m == SATURATION) return setLum(setSat(b, sat(s)), lum(b));
  if (m == COLOR) return setLum(s, lum(b));
  if (m == LUMINOSITY) return setLum(b, lum(s));
  if (m == LIGHTER_COLOR) return lum(s) > lum(b) ? s : b;
  if (m == DARKER_COLOR) return lum(s) < lum(b) ? s : b;
  return s;
}

vec4 composite() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 dst = texelFetch(u_backdrop, p, 0);
  vec4 src = texelFetch(u_source, p, 0);
  float k = pc.opacity;
  if (pc.matteMode != MATTE_NONE) {
    vec4 m = texelFetch(u_matte, p, 0) * pc.matteOpacity;
    float a = (pc.matteMode == MATTE_LUMA || pc.matteMode == MATTE_LUMA_INVERTED) ? dot(m.rgb, vec3(0.299, 0.587, 0.114)) : m.a;
    if (pc.matteMode == MATTE_ALPHA_INVERTED || pc.matteMode == MATTE_LUMA_INVERTED) a = 1.0 - a;
    k *= a;
  }
  if (pc.adjust == 1) {
    k *= texelFetch(u_coverage, p, 0).a;
    // The effected backdrop replaces the backdrop in proportion, rather than being laid over it.
    if (pc.mode == NORMAL || pc.mode == DISSOLVE || pc.mode == DANCING_DISSOLVE) {
      return mix(dst, src, k);
    }
  }
  src *= k;
  if (pc.mode == STENCIL_ALPHA) { return dst * src.a; }
  if (pc.mode == SILHOUETTE_ALPHA) { return dst * (1.0 - src.a); }
  if (pc.mode == STENCIL_LUMA) { return dst * dot(src.rgb, vec3(0.299, 0.587, 0.114)); }
  if (pc.mode == SILHOUETTE_LUMA) { return dst * (1.0 - dot(src.rgb, vec3(0.299, 0.587, 0.114))); }
  if (pc.mode == ALPHA_ADD) { return vec4(src.rgb + dst.rgb * (1.0 - src.a), min(1.0, src.a + dst.a)); }
  // AE's Add sums premultiplied color (Linear Dodge, by contrast, follows the separable blend formula).
  if (pc.mode == ADD) { return vec4(min(dst.rgb + src.rgb, vec3(1.0)), src.a + dst.a * (1.0 - src.a)); }
  if (pc.mode == NORMAL || pc.mode == DISSOLVE || pc.mode == DANCING_DISSOLVE) {
    return src + dst * (1.0 - src.a);
  }
  vec3 b = dst.a > 0.0 ? dst.rgb / dst.a : vec3(0.0);
  vec3 s = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  vec3 mixed = (1.0 - dst.a) * src.rgb + (1.0 - src.a) * dst.rgb + src.a * dst.a * clamp(blendColor(b, s), 0.0, 1.0);
  return vec4(mixed, src.a + dst.a * (1.0 - src.a));
}

void main() { outColor = quantize(composite()); }
