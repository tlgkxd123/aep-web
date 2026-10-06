// GLSL for layer placement, mask application and layer compositing.
// All textures hold premultiplied RGBA.

/** Places a layer-space texture into a comp-sized target through a 4x4 transform. */
export const LAYER_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
uniform vec2 u_layerSize;   // layer pixels covered by the quad (with 1px padding)
uniform vec2 u_origin;      // layer-space position of the quad's (0,0) corner
uniform mat4 u_toView;      // layer space -> view space (2D: comp pixels, 3D: camera space)
uniform int u_perspective;  // 1 when u_toView maps to camera space
uniform float u_zoom;
uniform vec2 u_compSize;
out vec2 v_uv;
void main() {
  vec2 layerPoint = u_origin + a_corner * u_layerSize;
  vec4 p = u_toView * vec4(layerPoint, 0.0, 1.0);
  // Targets store row 0 at the bottom of the image; layer y grows downward.
  v_uv = vec2(a_corner.x, 1.0 - a_corner.y);
  if (u_perspective == 1) {
    // Screen x = cx + x * zoom / z; written in clip space with w = z for perspective-correct sampling.
    vec2 center = u_compSize * 0.5;
    float x = (center.x * p.z + p.x * u_zoom) / u_compSize.x * 2.0 - p.z;
    float y = p.z - (center.y * p.z + p.y * u_zoom) / u_compSize.y * 2.0;
    gl_Position = vec4(x, y, 0.0, p.z);
  } else {
    gl_Position = vec4(p.x / u_compSize.x * 2.0 - 1.0, 1.0 - p.y / u_compSize.y * 2.0, 0.0, 1.0);
  }
}`;

export const LAYER_FS = `#version 300 es
precision highp float;
uniform sampler2D u_source;
in vec2 v_uv;
out vec4 outColor;
void main() { outColor = texture(u_source, v_uv); }`;

/** Full-target pass with uv in [0,1]. */
export const FULLSCREEN_VS = `#version 300 es
layout(location = 0) in vec2 a_corner;
out vec2 v_uv;
void main() {
  v_uv = a_corner;
  gl_Position = vec4(a_corner * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Multiplies a layer texture by mask coverage (in the alpha channel of u_mask). */
export const MASK_FS = `#version 300 es
precision highp float;
uniform sampler2D u_source;
uniform sampler2D u_mask;
out vec4 outColor;
// Coverage is quantized to 8 bits, as AE's 8-bpc mask is.
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = texelFetch(u_source, p, 0) * (floor(texelFetch(u_mask, p, 0).r * 255.0 + 0.5) / 255.0);
}`;

/** Fills the target with a constant premultiplied color. */
export const FILL_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }`;

export const BlendMode = {
  NORMAL: 5212, DISSOLVE: 5213, DANCING_DISSOLVE: 5214, DARKEN: 5215, MULTIPLY: 5216, LINEAR_BURN: 5217,
  COLOR_BURN: 5218, CLASSIC_COLOR_BURN: 5219, ADD: 5220, LIGHTEN: 5221, SCREEN: 5222, LINEAR_DODGE: 5223,
  COLOR_DODGE: 5224, CLASSIC_COLOR_DODGE: 5225, OVERLAY: 5226, SOFT_LIGHT: 5227, HARD_LIGHT: 5228,
  LINEAR_LIGHT: 5229, VIVID_LIGHT: 5230, PIN_LIGHT: 5231, HARD_MIX: 5232, DIFFERENCE: 5233,
  CLASSIC_DIFFERENCE: 5234, EXCLUSION: 5235, HUE: 5236, SATURATION: 5237, COLOR: 5238, LUMINOSITY: 5239,
  STENCIL_ALPHA: 5240, STENCIL_LUMA: 5241, SILHOUETTE_ALPHA: 5242, SILHOUETTE_LUMA: 5243, ALPHA_ADD: 5244,
  LUMINESCENT_PREMUL: 5245, LIGHTER_COLOR: 5246, DARKER_COLOR: 5247, SUBTRACT: 5248, DIVIDE: 5249,
} as const;

export const MatteMode = { NONE: 0, ALPHA: 1, ALPHA_INVERTED: 2, LUMA: 3, LUMA_INVERTED: 4 } as const;

/**
 * Composites a comp-space layer image (u_source) onto the backdrop (u_backdrop),
 * after applying an optional track matte (u_matte) and the layer opacity.
 */
export const COMPOSITE_FS = `#version 300 es
precision highp float;
uniform sampler2D u_backdrop;
uniform sampler2D u_source;
uniform sampler2D u_matte;
uniform int u_matteMode;
uniform float u_matteOpacity;
uniform int u_mode;
uniform float u_opacity;
in vec2 v_uv;
out vec4 outColor;

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
  if (u_mode == ${BlendMode.MULTIPLY}) return b * s;
  if (u_mode == ${BlendMode.SCREEN}) return b + s - b * s;
  if (u_mode == ${BlendMode.OVERLAY}) return vec3(hardLight(s.r, b.r), hardLight(s.g, b.g), hardLight(s.b, b.b));
  if (u_mode == ${BlendMode.DARKEN}) return min(b, s);
  if (u_mode == ${BlendMode.LIGHTEN}) return max(b, s);
  if (u_mode == ${BlendMode.LINEAR_DODGE}) return min(b + s, vec3(1.0));
  if (u_mode == ${BlendMode.SUBTRACT}) return max(b - s, vec3(0.0));
  if (u_mode == ${BlendMode.DIVIDE}) return vec3(s.r <= 0.0 ? 1.0 : min(1.0, b.r / s.r), s.g <= 0.0 ? 1.0 : min(1.0, b.g / s.g), s.b <= 0.0 ? 1.0 : min(1.0, b.b / s.b));
  if (u_mode == ${BlendMode.DIFFERENCE} || u_mode == ${BlendMode.CLASSIC_DIFFERENCE}) return abs(b - s);
  if (u_mode == ${BlendMode.EXCLUSION}) return b + s - 2.0 * b * s;
  if (u_mode == ${BlendMode.COLOR_DODGE} || u_mode == ${BlendMode.CLASSIC_COLOR_DODGE}) return vec3(colorDodge(b.r, s.r), colorDodge(b.g, s.g), colorDodge(b.b, s.b));
  if (u_mode == ${BlendMode.COLOR_BURN} || u_mode == ${BlendMode.CLASSIC_COLOR_BURN}) return vec3(colorBurn(b.r, s.r), colorBurn(b.g, s.g), colorBurn(b.b, s.b));
  if (u_mode == ${BlendMode.LINEAR_BURN}) return max(b + s - 1.0, vec3(0.0));
  if (u_mode == ${BlendMode.SOFT_LIGHT}) return vec3(softLight(b.r, s.r), softLight(b.g, s.g), softLight(b.b, s.b));
  if (u_mode == ${BlendMode.HARD_LIGHT}) return vec3(hardLight(b.r, s.r), hardLight(b.g, s.g), hardLight(b.b, s.b));
  if (u_mode == ${BlendMode.LINEAR_LIGHT}) return clamp(b + 2.0 * s - 1.0, 0.0, 1.0);
  if (u_mode == ${BlendMode.VIVID_LIGHT}) return vec3(vividLight(b.r, s.r), vividLight(b.g, s.g), vividLight(b.b, s.b));
  if (u_mode == ${BlendMode.PIN_LIGHT}) return mix(min(b, 2.0 * s), max(b, 2.0 * s - 1.0), step(0.5, s));
  if (u_mode == ${BlendMode.HARD_MIX}) return step(1.0, b + s);
  if (u_mode == ${BlendMode.HUE}) return setLum(setSat(s, sat(b)), lum(b));
  if (u_mode == ${BlendMode.SATURATION}) return setLum(setSat(b, sat(s)), lum(b));
  if (u_mode == ${BlendMode.COLOR}) return setLum(s, lum(b));
  if (u_mode == ${BlendMode.LUMINOSITY}) return setLum(b, lum(s));
  if (u_mode == ${BlendMode.LIGHTER_COLOR}) return lum(s) > lum(b) ? s : b;
  if (u_mode == ${BlendMode.DARKER_COLOR}) return lum(s) < lum(b) ? s : b;
  return s;
}

void main() {
  vec4 dst = texture(u_backdrop, v_uv);
  vec4 src = texture(u_source, v_uv);
  if (u_matteMode != ${MatteMode.NONE}) {
    vec4 m = texture(u_matte, v_uv) * u_matteOpacity;
    float a = (u_matteMode == ${MatteMode.LUMA} || u_matteMode == ${MatteMode.LUMA_INVERTED})
      ? dot(m.rgb, vec3(0.299, 0.587, 0.114)) : m.a;
    if (u_matteMode == ${MatteMode.ALPHA_INVERTED} || u_matteMode == ${MatteMode.LUMA_INVERTED}) a = 1.0 - a;
    src *= a;
  }
  src *= u_opacity;
  if (u_mode == ${BlendMode.STENCIL_ALPHA}) { outColor = dst * src.a; return; }
  if (u_mode == ${BlendMode.SILHOUETTE_ALPHA}) { outColor = dst * (1.0 - src.a); return; }
  if (u_mode == ${BlendMode.STENCIL_LUMA}) { outColor = dst * dot(src.rgb, vec3(0.299, 0.587, 0.114)); return; }
  if (u_mode == ${BlendMode.SILHOUETTE_LUMA}) { outColor = dst * (1.0 - dot(src.rgb, vec3(0.299, 0.587, 0.114))); return; }
  if (u_mode == ${BlendMode.ALPHA_ADD}) { outColor = vec4(src.rgb + dst.rgb * (1.0 - src.a), min(1.0, src.a + dst.a)); return; }
  // AE's Add sums premultiplied color (Linear Dodge, by contrast, follows the separable blend formula).
  if (u_mode == ${BlendMode.ADD}) { outColor = vec4(min(dst.rgb + src.rgb, vec3(1.0)), src.a + dst.a * (1.0 - src.a)); return; }
  if (u_mode == ${BlendMode.NORMAL} || u_mode == ${BlendMode.DISSOLVE} || u_mode == ${BlendMode.DANCING_DISSOLVE}) {
    outColor = src + dst * (1.0 - src.a);
    return;
  }
  vec3 b = dst.a > 0.0 ? dst.rgb / dst.a : vec3(0.0);
  vec3 s = src.a > 0.0 ? src.rgb / src.a : vec3(0.0);
  vec3 mixed = (1.0 - dst.a) * src.rgb + (1.0 - src.a) * dst.rgb + src.a * dst.a * clamp(blendColor(b, s), 0.0, 1.0);
  outColor = vec4(mixed, src.a + dst.a * (1.0 - src.a));
}`;
