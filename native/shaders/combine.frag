#version 450
// Combines one mask's coverage with the stack of the masks above it (COMBINE_FS in src/render/masks.ts).
layout(set = 0, binding = 0) uniform sampler2D u_coverage;
layout(set = 0, binding = 1) uniform sampler2D u_accumulated;
layout(push_constant) uniform Push {
  int mode;
  int first;
  int inverted;
  float start;
  float opacity;
} pc;
layout(location = 0) out vec4 outColor;

const int ADD = 6813, SUBTRACT = 6814, INTERSECT = 6815, LIGHTEN = 6816, DARKEN = 6817, DIFFERENCE = 6818;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float c = texelFetch(u_coverage, p, 0).r;
  if (pc.inverted == 1) c = 1.0 - c;
  c *= pc.opacity;
  float a = pc.first == 1 ? pc.start : texelFetch(u_accumulated, p, 0).r;
  float r = a;
  if (pc.mode == ADD) r = a + c - a * c;
  else if (pc.mode == SUBTRACT) r = a * (1.0 - c);
  else if (pc.mode == INTERSECT) r = a * c;
  else if (pc.mode == LIGHTEN) r = max(a, c);
  else if (pc.mode == DARKEN) r = min(a, c);
  else if (pc.mode == DIFFERENCE) r = abs(a - c);
  outColor = vec4(r, 0.0, 0.0, 1.0);
}
