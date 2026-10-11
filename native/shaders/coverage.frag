#version 450
// One mask path's (or shape fill's) coverage of each pixel: the exact area of the pixel inside the flattened path
// (nonzero winding, one winding level, or even-odd), grown by Mask Expansion with round joins. Edges are in image
// pixels, y down.
layout(std430, set = 0, binding = 4) readonly buffer Edges { vec4 edges[]; };
layout(push_constant) uniform Push {
  uint first;      // first edge of this path in the buffer
  uint count;      // edges of the filled outline
  uint stroked;    // the first `stroked` of them are the path itself (an open path's closing edge only fills)
  float expansion; // stroke half width in image pixels; 0 for none
  uint evenOdd;    // 1: winding levels alternate in and out
  uint bandRows;   // > 0: the edges are binned into bands of this many rows, after a table of (start, count) per band
  float bandTop;   // first row of the first band
  uint bands;
} pc;
layout(location = 0) out vec4 outColor;

// Mean of clamp(u, 0, 1) for u running linearly from a to b.
float clampedMean(float a, float b) {
  float lo = min(a, b);
  float hi = max(a, b);
  float len = hi - lo;
  if (len < 1e-6) return clamp(0.5 * (a + b), 0.0, 1.0);
  float above = clamp(hi - 1.0, 0.0, len);
  float m0 = clamp(lo, 0.0, 1.0);
  float m1 = clamp(hi, 0.0, 1.0);
  return (above + (m1 - m0) * 0.5 * (m0 + m1)) / len;
}

float segmentDistance(vec2 p, vec2 a, vec2 b) {
  vec2 ab = b - a;
  float t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-12), 0.0, 1.0);
  return length(p - (a + ab * t));
}

void main() {
  vec2 cell = floor(gl_FragCoord.xy);
  vec2 center = cell + 0.5;
  float area = 0.0;
  float nearest = 1e30;
  uint start = pc.first;
  uint count = pc.count;
  if (pc.bandRows > 0u) {
    // Edges outside the pixel's band add nothing to its area.
    uint band = uint(clamp(floor((cell.y - pc.bandTop) / float(pc.bandRows)), 0.0, float(pc.bands - 1u)));
    vec4 entry = edges[pc.first + band];
    start = pc.first + floatBitsToUint(entry.x);
    count = floatBitsToUint(entry.y);
  }
  for (uint i = 0u; i < count; i++) {
    vec4 e = edges[start + i];
    if (pc.expansion > 0.0 && i < pc.stroked) nearest = min(nearest, segmentDistance(center, e.xy, e.zw));
    if (e.y == e.w) continue;
    float dir = e.w > e.y ? 1.0 : -1.0;
    vec2 a = e.w > e.y ? e.xy : e.zw;
    vec2 b = e.w > e.y ? e.zw : e.xy;
    float top = max(a.y, cell.y);
    float bottom = min(b.y, cell.y + 1.0);
    if (top >= bottom) continue;
    float slope = (b.x - a.x) / (b.y - a.y);
    float xTop = a.x + (top - a.y) * slope - cell.x;
    float xBottom = a.x + (bottom - a.y) * slope - cell.x;
    // The part of the pixel's row span to the right of the edge, where the edge winds.
    area += dir * (bottom - top) * (1.0 - clampedMean(xTop, xBottom));
  }
  float c = min(1.0, abs(area));
  if (pc.evenOdd == 1u) {
    float level = mod(abs(area), 2.0);
    c = level <= 1.0 ? level : 2.0 - level;
  }
  if (pc.expansion > 0.0) c = max(c, clamp(pc.expansion - nearest + 0.5, 0.0, 1.0));
  outColor = vec4(c, 0.0, 0.0, 1.0);
}
