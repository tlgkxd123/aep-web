#include "geometry.h"

#include <algorithm>
#include <cmath>

namespace aevk {
namespace {

constexpr int kMaxSegments = 1024;
constexpr double kPi = 3.14159265358979323846;

struct Point {
  double x, y;
};

Point apply(const Affine& m, Point p) { return {m[0] * p.x + m[2] * p.y + m[4], m[1] * p.x + m[3] * p.y + m[5]}; }

/**
 * Points along a path (per vertex x, y, in tangent, out tangent; tangents relative) mapped through `m`, cubic
 * segments split until they stay within `tolerance` of their chords in mapped units. A closed path ends where it began.
 */
std::vector<Point> flatten(const std::vector<float>& vertices, bool closed, const Affine& m, double tolerance) {
  std::vector<Point> points;
  const size_t n = vertices.size() / 6;
  if (n == 0) return points;
  auto vertex = [&](size_t i) { return Point{vertices[i * 6], vertices[i * 6 + 1]}; };
  points.push_back(apply(m, vertex(0)));
  const size_t segments = closed ? n : n - 1;
  for (size_t i = 0; i < segments; i++) {
    const size_t j = (i + 1) % n;
    const Point v0 = vertex(i), v3 = vertex(j);
    const Point p0 = apply(m, v0);
    const Point p1 = apply(m, {v0.x + vertices[i * 6 + 4], v0.y + vertices[i * 6 + 5]});
    const Point p2 = apply(m, {v3.x + vertices[j * 6 + 2], v3.y + vertices[j * 6 + 3]});
    const Point p3 = apply(m, v3);
    // Wang's bound on the subdivisions keeping a cubic within the tolerance of its chords.
    const double ddx = std::max(std::abs(p0.x - 2 * p1.x + p2.x), std::abs(p1.x - 2 * p2.x + p3.x));
    const double ddy = std::max(std::abs(p0.y - 2 * p1.y + p2.y), std::abs(p1.y - 2 * p2.y + p3.y));
    const double dd = std::hypot(ddx, ddy);
    const bool straight = p1.x == p0.x && p1.y == p0.y && p2.x == p3.x && p2.y == p3.y;
    const int steps = straight || dd < 1e-9 ? 1 : std::clamp(int(std::ceil(std::sqrt(0.75 * dd / tolerance))), 1, kMaxSegments);
    for (int s = 1; s <= steps; s++) {
      const double t = double(s) / steps;
      const double u = 1 - t;
      const double a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      points.push_back({a * p0.x + b * p1.x + c * p2.x + d * p3.x, a * p0.y + b * p1.y + c * p2.y + d * p3.y});
    }
  }
  return points;
}

void include(Outline& out, Point p) {
  out.minX = std::min(out.minX, float(p.x));
  out.maxX = std::max(out.maxX, float(p.x));
  out.minY = std::min(out.minY, float(p.y));
  out.maxY = std::max(out.maxY, float(p.y));
}

/** Adds a closed polygon, its edges winding the positive way (in image pixels). */
void addPolygon(Outline& out, std::vector<Point>& polygon, const Affine& m) {
  if (polygon.size() < 3) return;
  double area = 0;
  for (Point& p : polygon) p = apply(m, p);
  for (size_t i = 0; i < polygon.size(); i++) {
    const Point& a = polygon[i];
    const Point& b = polygon[(i + 1) % polygon.size()];
    area += a.x * b.y - b.x * a.y;
  }
  if (area == 0) return;
  if (area < 0) std::reverse(polygon.begin(), polygon.end());
  const bool first = out.edges.empty();
  for (size_t i = 0; i < polygon.size(); i++) {
    const Point& a = polygon[i];
    const Point& b = polygon[(i + 1) % polygon.size()];
    if (first && i == 0) {
      out.minX = out.maxX = float(a.x);
      out.minY = out.maxY = float(a.y);
    }
    include(out, a);
    out.edges.push_back({float(a.x), float(a.y), float(b.x), float(b.y)});
  }
}

/** Points on the arc around `c` of radius `r` from angle a0 sweeping `sweep` radians, ends included. */
void arc(std::vector<Point>& out, Point c, double r, double a0, double sweep, double step) {
  const int n = std::max(1, int(std::ceil(std::abs(sweep) / step)));
  for (int i = 0; i <= n; i++) {
    const double a = a0 + sweep * i / n;
    out.push_back({c.x + r * std::cos(a), c.y + r * std::sin(a)});
  }
}

}  // namespace

Outline flattenPath(const std::vector<float>& vertices, bool closed, float scale, float offsetX, float offsetY, float tolerance) {
  Outline out;
  const std::vector<Point> points = flatten(vertices, closed, {scale, 0, 0, scale, offsetX, offsetY}, tolerance);
  if (points.empty()) return out;
  for (size_t i = 0; i + 1 < points.size(); i++) out.edges.push_back({float(points[i].x), float(points[i].y), float(points[i + 1].x), float(points[i + 1].y)});
  out.stroked = uint32_t(out.edges.size());
  // Filling closes an open path.
  const Point first = points.front(), last = points.back();
  if (first.x != last.x || first.y != last.y) out.edges.push_back({float(last.x), float(last.y), float(first.x), float(first.y)});
  out.minX = out.maxX = float(first.x);
  out.minY = out.maxY = float(first.y);
  for (const Point& p : points) include(out, p);
  return out;
}

Outline fillOutline(const std::vector<ShapePathRef>& paths, const Affine& toImage, float tolerance) {
  Outline out;
  bool first = true;
  for (const ShapePathRef& path : paths) {
    const std::vector<Point> points = flatten(*path.vertices, path.closed, toImage, tolerance);
    if (points.size() < 2) continue;
    for (size_t i = 0; i < points.size(); i++) {
      const Point& a = points[i];
      const Point& b = points[(i + 1) % points.size()];
      if (first) {
        out.minX = out.maxX = float(a.x);
        out.minY = out.maxY = float(a.y);
        first = false;
      }
      include(out, a);
      if (a.x != b.x || a.y != b.y) out.edges.push_back({float(a.x), float(a.y), float(b.x), float(b.y)});
    }
  }
  out.stroked = uint32_t(out.edges.size());
  return out;
}

Outline strokeOutline(const std::vector<ShapePathRef>& paths, const Affine& toImage, double width, LineCap cap, LineJoin join, double miterLimit,
                      float tolerance) {
  Outline out;
  const double hw = width / 2;
  if (!(hw > 0)) return out;
  // The pen is round in paint space; flatten there, finely enough for the largest stretch of the map.
  const double stretch = std::max(std::hypot(toImage[0], toImage[1]), std::hypot(toImage[2], toImage[3]));
  if (!(stretch > 0)) return out;
  const double tol = tolerance / stretch;
  const double step = hw > tol ? 2 * std::acos(1 - tol / hw) : kPi / 2;
  const Affine identity{1, 0, 0, 1, 0, 0};
  std::vector<Point> polygon;
  for (const ShapePathRef& path : paths) {
    std::vector<Point> raw = flatten(*path.vertices, path.closed, identity, tol);
    std::vector<Point> pts;
    for (const Point& p : raw)
      if (pts.empty() || std::hypot(p.x - pts.back().x, p.y - pts.back().y) > 1e-9) pts.push_back(p);
    const bool closed = path.closed && pts.size() > 2;
    if (closed && std::hypot(pts.front().x - pts.back().x, pts.front().y - pts.back().y) <= 1e-9) pts.pop_back();
    const size_t n = pts.size();
    if (n == 1) {
      // A zero-length path shows only its caps.
      if (cap == LineCap::Round) {
        polygon.clear();
        arc(polygon, pts[0], hw, 0, 2 * kPi, step);
        polygon.pop_back();
        addPolygon(out, polygon, toImage);
      } else if (cap == LineCap::Square) {
        polygon = {{pts[0].x - hw, pts[0].y - hw}, {pts[0].x + hw, pts[0].y - hw}, {pts[0].x + hw, pts[0].y + hw}, {pts[0].x - hw, pts[0].y + hw}};
        addPolygon(out, polygon, toImage);
      }
      continue;
    }
    if (n < 2) continue;
    const size_t segments = closed ? n : n - 1;
    auto direction = [&](size_t i) {
      const Point& a = pts[i];
      const Point& b = pts[(i + 1) % n];
      const double len = std::hypot(b.x - a.x, b.y - a.y);
      return Point{(b.x - a.x) / len, (b.y - a.y) / len};
    };
    for (size_t i = 0; i < segments; i++) {
      const Point a = pts[i], b = pts[(i + 1) % n];
      const Point d = direction(i);
      const Point nrm{-d.y * hw, d.x * hw};
      polygon = {{a.x + nrm.x, a.y + nrm.y}, {b.x + nrm.x, b.y + nrm.y}, {b.x - nrm.x, b.y - nrm.y}, {a.x - nrm.x, a.y - nrm.y}};
      addPolygon(out, polygon, toImage);
    }
    // Joins fill the gap on the outer side of each turn.
    const size_t firstJoin = closed ? 0 : 1;
    const size_t lastJoin = closed ? n : n - 1;
    for (size_t i = firstJoin; i < lastJoin; i++) {
      const Point d0 = direction((i + segments - 1) % segments);
      const Point d1 = direction(i % segments);
      const double cross = d0.x * d1.y - d0.y * d1.x;
      const double dot = d0.x * d1.x + d0.y * d1.y;
      if (std::abs(cross) < 1e-12 && dot > 0) continue;
      const Point v = pts[i];
      const double side = cross > 0 ? -1 : 1;
      const Point n0{-d0.y * side, d0.x * side};
      const Point n1{-d1.y * side, d1.x * side};
      const Point p0{v.x + n0.x * hw, v.y + n0.y * hw};
      const Point p1{v.x + n1.x * hw, v.y + n1.y * hw};
      const double turn = std::atan2(std::abs(cross), dot);
      polygon = {v, p0};
      if (join == LineJoin::Round) {
        const double a0 = std::atan2(n0.y, n0.x);
        double sweep = std::atan2(n1.y, n1.x) - a0;
        while (sweep > kPi) sweep -= 2 * kPi;
        while (sweep < -kPi) sweep += 2 * kPi;
        arc(polygon, v, hw, a0, sweep, step);
        polygon.erase(polygon.begin() + 1);
      } else if (join == LineJoin::Miter && std::cos(turn / 2) > 1e-9 && 1 / std::cos(turn / 2) <= miterLimit) {
        const Point mid{n0.x + n1.x, n0.y + n1.y};
        const double len = std::hypot(mid.x, mid.y);
        const double reach = hw / std::cos(turn / 2);
        polygon.push_back({v.x + mid.x / len * reach, v.y + mid.y / len * reach});
        polygon.push_back(p1);
      } else {
        polygon.push_back(p1);
      }
      addPolygon(out, polygon, toImage);
    }
    if (closed || cap == LineCap::Butt) continue;
    for (int end = 0; end < 2; end++) {
      const Point v = end ? pts[n - 1] : pts[0];
      Point d = direction(end ? segments - 1 : 0);
      if (!end) d = {-d.x, -d.y};
      const Point nrm{-d.y * hw, d.x * hw};
      if (cap == LineCap::Square) {
        polygon = {{v.x + nrm.x, v.y + nrm.y}, {v.x + nrm.x + d.x * hw, v.y + nrm.y + d.y * hw}, {v.x - nrm.x + d.x * hw, v.y - nrm.y + d.y * hw},
                   {v.x - nrm.x, v.y - nrm.y}};
      } else {
        polygon.clear();
        // Half a disc, from one side of the pen around the end to the other.
        const double a0 = std::atan2(nrm.y, nrm.x);
        const double sweep = (d.x * nrm.y - d.y * nrm.x) > 0 ? kPi : -kPi;
        arc(polygon, v, hw, a0, -sweep, step);
      }
      addPolygon(out, polygon, toImage);
    }
  }
  out.stroked = uint32_t(out.edges.size());
  return out;
}

}  // namespace aevk
