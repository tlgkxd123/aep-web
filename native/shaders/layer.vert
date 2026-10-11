#version 450
// Places a layer-space image into a comp-sized target through a 4x4 transform (LAYER_VS in src/render/shaders.ts).
// Images are stored top row first, so texture v follows layer y.
layout(push_constant) uniform Push {
  mat4 toView;    // layer space -> view space (2D: target pixels, 3D: camera space)
  vec2 layerSize; // layer pixels covered by the quad (with the border)
  vec2 origin;    // layer-space position of the quad's (0,0) corner
  vec2 viewSize;  // target pixels
  float zoom;     // camera zoom in target pixels; 0 for a 2D layer
} pc;
layout(location = 0) out vec2 v_uv;

void main() {
  vec2 corner = vec2(float(gl_VertexIndex & 1), float(gl_VertexIndex >> 1));
  vec4 p = pc.toView * vec4(pc.origin + corner * pc.layerSize, 0.0, 1.0);
  v_uv = corner;
  if (pc.zoom > 0.0) {
    // Screen x = cx + x * zoom / z, written in clip space with w = z for perspective-correct sampling.
    vec2 center = pc.viewSize * 0.5;
    float x = (center.x * p.z + p.x * pc.zoom) / pc.viewSize.x * 2.0 - p.z;
    float y = (center.y * p.z + p.y * pc.zoom) / pc.viewSize.y * 2.0 - p.z;
    gl_Position = vec4(x, y, 0.0, p.z);
  } else {
    gl_Position = vec4(p.x / pc.viewSize.x * 2.0 - 1.0, p.y / pc.viewSize.y * 2.0 - 1.0, 0.0, 1.0);
  }
}
