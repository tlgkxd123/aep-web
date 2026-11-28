#version 450
// Interpret Footage on the way into a layer image (INTERPRET_FS in src/render/footage.ts, for RGBA frames): the alpha
// settings, and at a reduced resolution the average of the source pixels each output pixel covers. Rows are top
// first on both sides here, so no flip.
layout(set = 0, binding = 0) uniform sampler2D u_rgba;
layout(push_constant) uniform Push {
  ivec2 outSize;
  int pad;
  /** 0 straight, 1 premultiplied, 2 ignore. */
  int mode;
  int hasAlpha;
  int invert;
  /** Taps per axis averaged per pixel (1 at full resolution). */
  int taps;
  float scale;
  vec4 matte;
} pc;
layout(location = 0) out vec4 outColor;

// 8-bit targets: values rounded half up here, as the browser's WebGL does (see premultiply.frag).
vec4 quantize(vec4 c) {
  precise vec4 scaled = clamp(c, 0.0, 1.0) * 255.0;
  precise vec4 rounded = floor(scaled + 0.5);
  return rounded / 255.0;
}

vec4 interpreted(ivec2 at) {
  vec4 c = texelFetch(u_rgba, at, 0);
  float a = pc.hasAlpha != 0 ? c.a : 1.0;
  if (pc.invert != 0) a = 1.0 - a;
  if (pc.mode == 2) return vec4(c.rgb, 1.0);
  if (pc.mode == 1) return vec4(clamp(c.rgb - pc.matte.rgb * (1.0 - a), 0.0, a), a);
  return vec4(c.rgb * a, a);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) - pc.pad;
  if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, pc.outSize))) {
    outColor = vec4(0.0);
    return;
  }
  if (pc.taps <= 1) {
    outColor = quantize(interpreted(p));
    return;
  }
  ivec2 size = textureSize(u_rgba, 0);
  vec2 q = vec2(p) + 0.5;
  float n = float(pc.taps);
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 8; j++) {
    if (j >= pc.taps) break;
    for (int i = 0; i < 8; i++) {
      if (i >= pc.taps) break;
      vec2 c = (q + (vec2(float(i), float(j)) + 0.5) / n - 0.5) / pc.scale;
      if (c.x >= 0.0 && c.y >= 0.0 && c.x < float(size.x) && c.y < float(size.y)) sum += interpreted(ivec2(c));
    }
  }
  outColor = quantize(sum / (n * n));
}
