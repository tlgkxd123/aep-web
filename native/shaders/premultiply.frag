#version 450
// Straight-alpha pixels uploaded as they are, into a padded premultiplied image.
layout(set = 0, binding = 0) uniform sampler2D u_source;
layout(push_constant) uniform Push {
  int pad;
} pc;
layout(location = 0) out vec4 outColor;
// 8-bit targets: values rounded half up here, as the browser's WebGL does, rather than by the device's own rule for ties.
// precise keeps the product rounded to float before the rounding (a fused multiply-add would not).
vec4 quantize(vec4 c) {
  precise vec4 scaled = clamp(c, 0.0, 1.0) * 255.0;
  precise vec4 rounded = floor(scaled + 0.5);
  return rounded / 255.0;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) - pc.pad;
  ivec2 size = textureSize(u_source, 0);
  if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, size))) {
    outColor = vec4(0.0);
    return;
  }
  vec4 c = texelFetch(u_source, p, 0);
  outColor = quantize(vec4(c.rgb * c.a, c.a));
}
