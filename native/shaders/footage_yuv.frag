#version 450
// Interpret Footage for a Y'CbCr video picture (INTERPRET_FS in src/render/footage.ts, u_yuv): the decoder's 8-bit
// planes, uploaded back to back as an RGBA8 image 4096 texels wide (byte b at texel b / 4, channel b % 4), converted
// with After Effects' matrix and bilinear chroma sited at the centre of the luma pixels it covers, then the alpha
// settings and, at a reduced resolution, the average of the source pixels each output pixel covers. Rows top first.
layout(set = 0, binding = 0) uniform sampler2D u_bytes;
layout(push_constant) uniform Push {
  ivec2 outSize;
  int pad;
  /** 0 straight, 1 premultiplied, 2 ignore. */
  int mode;
  int hasAlpha;
  int invert;
  int taps;
  float scale;
  vec4 matte;
  /** The luma plane's size and the chroma planes'. */
  ivec2 size;
  ivec2 chromaSize;
  /** Byte offsets of Y, Cb and Cr, and 1 when Cb and Cr interleave in one plane (NV12). */
  ivec4 offsets;
  /** Row strides of Y and of the chroma plane(s) in bytes, and 1 for video range. */
  ivec4 strides;
  /** Kr and Kb of the matrix. */
  vec4 k;
} pc;
layout(location = 0) out vec4 outColor;

const int kRowTexels = 4096;

// 8-bit targets: values rounded half up here, as the browser's WebGL does (see premultiply.frag).
vec4 quantize(vec4 c) {
  precise vec4 scaled = clamp(c, 0.0, 1.0) * 255.0;
  precise vec4 rounded = floor(scaled + 0.5);
  return rounded / 255.0;
}

float byteAt(int b) {
  int t = b >> 2;
  vec4 v = texelFetch(u_bytes, ivec2(t % kRowTexels, t / kRowTexels), 0);
  int c = b & 3;
  return c == 0 ? v.r : c == 1 ? v.g : c == 2 ? v.b : v.a;
}

// Cb and Cr at chroma texel p: two planes, or one interleaved plane.
vec2 cbcr(ivec2 p) {
  if (pc.offsets.w != 0) {
    int at = pc.offsets.y + p.y * pc.strides.y + 2 * p.x;
    return vec2(byteAt(at), byteAt(at + 1));
  }
  int row = p.y * pc.strides.y + p.x;
  return vec2(byteAt(pc.offsets.y + row), byteAt(pc.offsets.z + row));
}

vec2 chroma(vec2 at) {
  vec2 base = floor(at);
  vec2 w = at - base;
  ivec2 lo = clamp(ivec2(base), ivec2(0), pc.chromaSize - 1);
  ivec2 hi = clamp(ivec2(base) + 1, ivec2(0), pc.chromaSize - 1);
  vec2 a = cbcr(lo);
  vec2 b = cbcr(ivec2(hi.x, lo.y));
  vec2 c = cbcr(ivec2(lo.x, hi.y));
  vec2 d = cbcr(hi);
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

vec3 toRgb(float y, float cb, float cr, vec2 k) {
  float kr = k.x;
  float kb = k.y;
  float kg = 1.0 - kr - kb;
  return vec3(y + 2.0 * (1.0 - kr) * cr, y - (2.0 * kb * (1.0 - kb) * cb + 2.0 * kr * (1.0 - kr) * cr) / kg, y + 2.0 * (1.0 - kb) * cb);
}

vec4 interpreted(ivec2 at) {
  vec2 ratio = vec2(pc.size) / vec2(pc.chromaSize);
  vec2 site = (vec2(at) + 0.5) / ratio - 0.5;
  float y = byteAt(pc.offsets.x + at.y * pc.strides.x + at.x);
  vec2 c2 = chroma(site);
  float cb = c2.x;
  float cr = c2.y;
  if (pc.strides.z != 0) {
    y = (y * 255.0 - 16.0) / 219.0;
    cb = (cb * 255.0 - 128.0) / 224.0;
    cr = (cr * 255.0 - 128.0) / 224.0;
  } else {
    cb -= 128.0 / 255.0;
    cr -= 128.0 / 255.0;
  }
  vec4 c = vec4(clamp(toRgb(y, cb, cr, pc.k.xy), 0.0, 1.0), 1.0);
  float a = 1.0;
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
  vec2 q = vec2(p) + 0.5;
  float n = float(pc.taps);
  vec4 sum = vec4(0.0);
  for (int j = 0; j < 8; j++) {
    if (j >= pc.taps) break;
    for (int i = 0; i < 8; i++) {
      if (i >= pc.taps) break;
      vec2 c = (q + (vec2(float(i), float(j)) + 0.5) / n - 0.5) / pc.scale;
      if (c.x >= 0.0 && c.y >= 0.0 && c.x < float(pc.size.x) && c.y < float(pc.size.y)) sum += interpreted(ivec2(c));
    }
  }
  outColor = quantize(sum / (n * n));
}
