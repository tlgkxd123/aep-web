#version 450
// Multiplies a layer image by its mask coverage, quantized to 8 bits as AE's 8-bpc mask is (MASK_FS).
layout(set = 0, binding = 0) uniform sampler2D u_source;
layout(set = 0, binding = 1) uniform sampler2D u_mask;
layout(location = 0) out vec4 outColor;
// 8-bit targets: values rounded half up here, as the browser's WebGL does, rather than by the device's own rule for ties.
// precise keeps the product rounded to float before the rounding (a fused multiply-add would not).
vec4 quantize(vec4 c) {
  precise vec4 scaled = clamp(c, 0.0, 1.0) * 255.0;
  precise vec4 rounded = floor(scaled + 0.5);
  return rounded / 255.0;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = quantize(texelFetch(u_source, p, 0) * (floor(texelFetch(u_mask, p, 0).r * 255.0 + 0.5) / 255.0));
}
