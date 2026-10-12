#version 450
// A rendered frame without its border, as straight 8-bit RGBA for reading back (Renderer.readPixels' convention): each
// color is c * 255 / a rounded half up, worked out in integers so no device's float rounding can move it.
layout(set = 0, binding = 0) uniform sampler2D u_frame;
layout(push_constant) uniform Push {
  int pad;
} pc;
layout(location = 0) out uvec4 outColor;
void main() {
  uvec4 c = uvec4(texelFetch(u_frame, ivec2(gl_FragCoord.xy) + pc.pad, 0) * 255.0 + 0.5);
  uvec3 rgb = c.a == 0u ? uvec3(0u) : min(uvec3(255u), (c.rgb * 510u + c.a) / (2u * c.a));
  outColor = uvec4(rgb, c.a);
}
