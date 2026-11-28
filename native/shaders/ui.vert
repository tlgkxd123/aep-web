#version 450
// The app's interface (Dear ImGui's draw lists, native/ui): indexed triangles in window pixels, the vertices read from
// a storage buffer as ImDrawVert lays them out (position, uv, packed RGBA8), so the pipeline needs no vertex input.
layout(std430, set = 0, binding = 1) readonly buffer Vertices { float data[]; };
layout(push_constant) uniform Push {
  vec2 scale;     // window pixels -> clip space
  vec2 translate;
  vec4 uvRect;    // uv offset (xy) and scale (zw): a rendered frame's content without its border
  int premultiplied;
} pc;
layout(location = 0) out vec2 v_uv;
layout(location = 1) out vec4 v_color;

void main() {
  int i = gl_VertexIndex * 5;
  v_uv = pc.uvRect.xy + vec2(data[i + 2], data[i + 3]) * pc.uvRect.zw;
  v_color = unpackUnorm4x8(floatBitsToUint(data[i + 4]));
  gl_Position = vec4(vec2(data[i], data[i + 1]) * pc.scale + pc.translate, 0.0, 1.0);
}
