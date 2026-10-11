#version 450
layout(set = 0, binding = 0) uniform sampler2D u_source;
layout(location = 0) in vec2 v_uv;
layout(location = 0) out vec4 outColor;
// 8-bit targets: values rounded half up here, as the browser's WebGL does, rather than by the device's own rule for ties.
// precise keeps the product rounded to float before the rounding (a fused multiply-add would not).
vec4 quantize(vec4 c) {
  precise vec4 scaled = clamp(c, 0.0, 1.0) * 255.0;
  precise vec4 rounded = floor(scaled + 0.5);
  return rounded / 255.0;
}
void main() { outColor = quantize(texture(u_source, v_uv)); }
