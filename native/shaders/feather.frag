#version 450
// AE's mask feather (FEATHER_FS in src/render/masks.ts): a Gaussian with sigma = feather / 2.4, truncated at the
// feather radius, applied separably with edge pixels repeated.
layout(set = 0, binding = 0) uniform sampler2D u_coverage;
layout(push_constant) uniform Push {
  ivec2 step;
  int radius;
  float sigma;
  float norm; // 1 / the sum of the kernel's weights
} pc;
layout(location = 0) out vec4 outColor;

void main() {
  ivec2 size = textureSize(u_coverage, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  float acc = 0.0;
  for (int k = -pc.radius; k <= pc.radius; k++) {
    ivec2 q = clamp(p + pc.step * k, ivec2(0), size - 1);
    float w = exp(-float(k * k) / (2.0 * pc.sigma * pc.sigma)) * pc.norm;
    acc += texelFetch(u_coverage, q, 0).r * w;
  }
  outColor = vec4(acc, 0.0, 0.0, 1.0);
}
