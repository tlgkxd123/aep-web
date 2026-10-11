#version 450
// One fill or stroke of a shape layer laid over the paints below it (source-over, premultiplied), as the canvas in
// src/render/shapes.ts paints: a solid color or a gradient ramp, times the paint's coverage of each pixel.
layout(set = 0, binding = 0) uniform sampler2D u_backdrop;
layout(set = 0, binding = 3) uniform sampler2D u_coverage;
layout(std430, set = 0, binding = 4) readonly buffer Ramp { vec4 ramp[]; };
layout(push_constant) uniform Push {
  vec4 color;     // straight RGBA, for solid paints
  vec4 toPaintX;  // image pixels to paint space: x = dot(xy, p) + z
  vec4 toPaintY;  //                              y = dot(xy, p) + z
  vec4 startEnd;  // gradient start (a radial one's center) and end, paint space
  vec2 focus;     // radial highlight, paint space
  int kind;       // 0 solid, 1 linear, 2 radial
  uint rampFirst; // first ramp stop in the buffer
  uint rampLast;  // index of the last stop, relative to the first
} pc;
layout(location = 0) out vec4 outColor;

// 8-bit targets: values rounded half up here, as the browser's WebGL does, rather than by the device's own rule for ties.
// precise keeps the product rounded to float before the rounding (a fused multiply-add would not).
vec4 quantize(vec4 c) {
  precise vec4 scaled = clamp(c, 0.0, 1.0) * 255.0;
  precise vec4 rounded = floor(scaled + 0.5);
  return rounded / 255.0;
}

float gradientAt(vec2 p) {
  vec2 start = pc.startEnd.xy;
  vec2 end = pc.startEnd.zw;
  if (pc.kind == 1) {
    vec2 d = end - start;
    return dot(p - start, d) / max(dot(d, d), 1e-12);
  }
  // Canvas's radial gradient from a point at the highlight to the circle through the end: the largest t whose circle,
  // centered between the highlight and the center and t times the radius, passes through p.
  float r = length(end - start);
  vec2 d = start - pc.focus;
  vec2 q = p - pc.focus;
  float a = dot(d, d) - r * r;
  float b = dot(q, d);
  float c = dot(q, q);
  if (abs(a) < 1e-9) return b != 0.0 ? c / (2.0 * b) : 0.0;
  return (b - sqrt(max(b * b - a * c, 0.0))) / a;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 dst = texelFetch(u_backdrop, p, 0);
  float coverage = texelFetch(u_coverage, p, 0).r;
  vec4 color = pc.color;
  if (pc.kind != 0) {
    // After Effects samples gradients at pixel corners.
    vec2 corner = gl_FragCoord.xy - 0.5;
    vec2 at = vec2(dot(pc.toPaintX.xy, corner) + pc.toPaintX.z, dot(pc.toPaintY.xy, corner) + pc.toPaintY.z);
    float x = clamp(gradientAt(at), 0.0, 1.0) * float(pc.rampLast);
    uint i = min(uint(floor(x)), pc.rampLast - 1u);
    color = mix(ramp[pc.rampFirst + i], ramp[pc.rampFirst + i + 1u], x - float(i));
  }
  vec4 src = vec4(color.rgb * color.a, color.a) * coverage;
  outColor = quantize(src + dst * (1.0 - src.a));
}
