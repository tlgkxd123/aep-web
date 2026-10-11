#pragma once

#include <array>
#include <cstdint>
#include <vector>

namespace aevk {

/** A straight edge, x0 y0 x1 y1, in image pixels (y down). */
struct Edge {
  float x0, y0, x1, y1;
};

struct Outline {
  std::vector<Edge> edges;
  /** The first `stroked` edges follow the path; the rest close an open path for filling only. */
  uint32_t stroked = 0;
  /** Bounds of the edges, in image pixels. */
  float minX = 0, minY = 0, maxX = 0, maxY = 0;
};

/**
 * A mask path (per vertex x, y, in tangent, out tangent, in layer pixels) flattened into edges of the image, whose
 * pixel p is at offset + scale * p: cubic segments are split until they stay within `tolerance` image pixels.
 */
Outline flattenPath(const std::vector<float>& vertices, bool closed, float scale, float offsetX, float offsetY, float tolerance = 0.05f);

/** x' = a x + c y + e, y' = b x + d y + f (canvas order). */
using Affine = std::array<double, 6>;

enum class LineCap : uint32_t { Butt = 1, Round = 2, Square = 3 };
enum class LineJoin : uint32_t { Miter = 1, Round = 2, Bevel = 3 };

struct ShapePathRef {
  const std::vector<float>* vertices;
  bool closed;
};

/**
 * Edges filling paths (shape vertices in paint space) mapped through `toImage`, open paths closed: their nonzero
 * winding, or even-odd by the coverage pass, is the fill.
 */
Outline fillOutline(const std::vector<ShapePathRef>& paths, const Affine& toImage, float tolerance = 0.05f);

/**
 * Edges of the area a pen of `width` (in paint space) covers along the paths, with canvas caps and joins, mapped
 * through `toImage`. Every polygon winds the same way, so overlaps add up rather than cancel.
 */
Outline strokeOutline(const std::vector<ShapePathRef>& paths, const Affine& toImage, double width, LineCap cap, LineJoin join, double miterLimit,
                      float tolerance = 0.05f);

}  // namespace aevk
