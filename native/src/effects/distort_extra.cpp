/**
 * Distort effects of src/render/effects/distortExtra.ts, fitted to After Effects renders of the distort2 fixtures:
 * Spherize, Ripple, Magnify, CC Lens, CC Slant, CC Tiler, CC Split, CC Split 2, CC Bender, Bezier Warp and CC Power
 * Pin. Most of these place their points with pixel centres on whole numbers, so a point parameter (x, y) is the layer
 * point (x + 0.5, y + 0.5); Magnify and CC Tiler take it as it is.
 */
#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

#include "effects.h"
#include "stock.h"

namespace aevk {
namespace {

constexpr double kPi = 3.14159265358979323846;

using Point = std::array<double, 2>;

/** A point parameter in image pixels, at the image's scale; `shift` 0.5 for effects placing points on pixel centres (point). */
Point point(const FxParams& p, uint32_t index, const EffectLayer& layer, const FxImage& input, double shift = 0.5) {
  const double k = input.scale;
  const FxRect box = layerRect(layer, input);
  const std::vector<double> v = p.vec(index, {box.x / k + box.width / k / 2, box.y / k + box.height / k / 2});
  return {v[0] * k + shift, (v.size() > 1 ? v[1] : 0) * k + shift};
}

FxRect discRect(const Point& c, double r) { return {c[0] - r, c[1] - r, 2 * r, 2 * r}; }

/** An empty image, for effects whose parameters leave nothing to draw; releases `input` (nothing). */
FxImage nothing(FxImage input, FxContext& ctx) {
  const FxRect r = imageRect(input);
  return blankImage(ctx, input, {r.x, r.y, 1, 1});
}

/** The box of points. */
FxRect boundsOf(const Point* points, size_t count) {
  double x0 = points[0][0], x1 = x0, y0 = points[0][1], y1 = y0;
  for (size_t i = 1; i < count; i++) {
    x0 = std::min(x0, points[i][0]);
    x1 = std::max(x1, points[i][0]);
    y0 = std::min(y0, points[i][1]);
    y1 = std::max(y1, points[i][1]);
  }
  return {x0, y0, x1 - x0, y1 - y0};
}

/** The layer's time at the frame (layerTimeAt in evaluate.ts). */
double layerTime(const EffectLayer& layer) {
  const double stretch = layer.stretch;
  const double offset = stretch >= 0 ? layer.startTime : layer.startTime - std::abs(stretch) / 3000;
  return (layer.time - offset) / stretch;
}

/**
 * Spherize: the disc of Radius about Center of Sphere magnified as if wrapped on a sphere; the layer grows to the
 * disc.
 */
FxImage spherize(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double radius = std::max(0.0, p.num(1, 0)) * input.scale;
  if (radius < 0.5) return input;
  const Point c = point(p, 2, layer, input);
  const FxRect rect = clampRect(unionRect(imageRect(input), discRect(c, radius)));
  return warpPass(ctx, input, rect, fx::spherize, [&](FxUniforms& u) {
    u.f("u_center", float(c[0]), float(c[1]));
    u.f("u_radius", float(radius));
  });
}

/**
 * Ripple: rings about Ripple Center move the layer by Wave Height / 4 times cos(pi d / Wave Width + Phase - 2 pi Speed
 * t), fading to nothing at Radius percent of the layer's diagonal; the layer grows by the largest move.
 */
FxImage ripple(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const FxRect box = layerRect(layer, input);
  const double reach = std::max(0.0, p.num(1, 0)) / 100 * std::hypot(box.width, box.height);
  const double amplitude = p.num(6, 20) / 4 * k;
  if (reach < 0.5 || std::abs(amplitude) < 1e-3) return input;
  const Point c = point(p, 2, layer, input);
  const bool symmetric = p.choice(3, 1) == 2;
  const double width = std::max(1.0, p.num(5, 20)) * k;
  const double phase = p.num(7, 0) * kPi / 180 - 2 * kPi * p.num(4, 1) * layerTime(layer);
  const FxRect rect = clampRect(growRect(imageRect(input), std::abs(amplitude), std::abs(amplitude)));
  return warpPass(ctx, input, rect, fx::ripple, [&](FxUniforms& u) {
    u.f("u_center", float(c[0]), float(c[1]));
    u.f("u_reach", float(reach));
    u.f("u_amplitude", float(amplitude));
    u.f("u_width", float(width));
    u.f("u_phase", float(phase));
    u.i("u_symmetric", symmetric ? 1 : 0);
  });
}

/**
 * Magnify: the layer magnified about Center inside a circle (or square) of Size, over the layer at Opacity, its edge
 * eased over Feather + 0.75 pixels; Blending None replaces the layer there, Normal lays the magnified layer over it.
 */
FxImage magnify(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const Point c = point(p, 1, layer, input, 0);
  const double magnification = std::max(1e-3, p.num(3, 150) / 100);
  const int32_t link = p.choice(11, 1);
  const double size = std::max(0.0, p.num(2, 100)) * k * (link >= 2 ? magnification : 1);
  const double feather = std::max(0.0, p.num(4, 0)) * k * (link == 3 ? magnification : 1);
  const int32_t blend = p.choice(12, 2);
  if (blend > 2) ctx.warn("Magnify: blending modes other than None and Normal are drawn as Normal");
  if (p.choice(8, 1) != 1) ctx.warn("Magnify: Soft and Scatter scaling are drawn as Standard");
  const double ease = feather + 0.75;
  const FxRect rect = p.flag(9, false) ? clampRect(unionRect(imageRect(input), discRect(c, size + ease))) : imageRect(input);
  const bool square = p.choice(10, 1) == 2;
  const double opacity = std::clamp(p.num(5, 100) / 100, 0.0, 1.0);
  FxImage out = layerPass(ctx, rect, {input}, fx::magnify, [&](FxUniforms& u) {
    u.f("u_center", float(c[0]), float(c[1]));
    u.f("u_inverse", float(1 / magnification));
    u.f("u_extent", float(size));
    u.f("u_ease", float(ease));
    u.i("u_square", square ? 1 : 0);
    u.f("u_opacity", float(opacity));
    u.i("u_replace", blend == 1 ? 1 : 0);
  }, input.scale);
  ctx.release(input.target);
  return out;
}

/**
 * CC Lens: a disc of radius Size percent of half the layer's diagonal about Center, its points pulled in by
 * Convergence; its edge fades over sqrt(2) pixels and nothing is drawn outside it.
 */
FxImage ccLens(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const FxRect box = layerRect(layer, input);
  const double radius = std::max(0.0, p.num(2, 50)) / 100 * (std::hypot(box.width, box.height) / 2);
  if (radius < 0.5) return nothing(input, ctx);
  const Point c = point(p, 1, layer, input);
  const double convergence = p.num(3, 100) / 100;
  return warpPass(ctx, input, clampRect(discRect(c, radius)), fx::cc_lens, [&](FxUniforms& u) {
    u.f("u_center", float(c[0]), float(c[1]));
    u.f("u_radius", float(radius));
    u.f("u_convergence", float(convergence));
  });
}

/**
 * CC Slant: the layer slanted by Slant / 100 pixels across per pixel above Floor and scaled vertically about it by
 * Height percent; without Stretching the slanted sides keep their length. Set Color fills it with Color.
 */
FxImage ccSlant(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double slant = p.num(1, 0) / 100;
  const bool stretch = p.flag(2, true);
  const double height = p.num(3, 100) / 100 * (stretch ? 1 : 1 / std::hypot(1, slant));
  if (std::abs(height) < 1e-4) return nothing(input, ctx);
  const double floor = point(p, 4, layer, input)[1];
  const FxRect r = imageRect(input);
  Point corners[4] = {{r.x, r.y}, {r.x + r.width, r.y}, {r.x, r.y + r.height}, {r.x + r.width, r.y + r.height}};
  for (Point& q : corners) q = {q[0] + slant * (floor - q[1]), floor + (q[1] - floor) * height};
  const FxRect rect = clampRect(boundsOf(corners, 4));
  const bool fill = p.flag(5, false);
  const std::array<float, 3> color = fill ? p.rgb(6, {0, 0, 0}) : std::array<float, 3>{0, 0, 0};
  FxImage out = layerPass(ctx, rect, {input}, fx::cc_slant, [&](FxUniforms& u) {
    u.f("u_slant", float(slant));
    u.f("u_height", float(height));
    u.f("u_floor", float(floor));
    u.f("u_color", color[0], color[1], color[2], fill ? 1.0f : 0.0f);
  }, input.scale);
  ctx.release(input.target);
  return out;
}

/**
 * CC Tiler: the layer reduced to a tile of round(Scale x its size) pixels, placed as the layer scaled about Center
 * would be and repeated over the layer's box every tile size less one pixel; Blend w. Original mixes the layer back.
 */
FxImage ccTiler(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const FxRect box = layerRect(layer, input);
  const double scale = std::clamp(p.num(1, 1), 0.0, 1.0);
  const double tw = std::round(box.width * scale), th = std::round(box.height * scale);
  if (tw < 2 || th < 2) return nothing(input, ctx);
  const Point c = point(p, 2, layer, input, 0);
  const auto average = [&](const FxImage& source, const FxRect& rect, int axis, double step, double from) {
    return layerPass(ctx, rect, {source}, fx::cc_tiler_average, [&](FxUniforms& u) {
      u.f("u_axis", float(1 - axis), float(axis));
      u.f("u_step", float(step));
      u.f("u_from", float(from));
    });
  };
  FxImage rows = average(input, {0, box.y, tw, box.height}, 0, box.width / tw, box.x);
  FxImage tile = average(rows, {0, 0, tw, th}, 1, box.height / th, box.y);
  ctx.release(rows.target);
  const double blend = std::clamp(p.num(3, 0), 0.0, 1.0);
  FxImage out = layerPass(ctx, box, {tile, input}, fx::cc_tiler, [&](FxUniforms& u) {
    u.f("u_origin0", float(c[0] * (1 - scale)), float(c[1] * (1 - scale)));
    u.f("u_period", float(tw - 1), float(th - 1));
    u.f("u_blend", float(blend));
  }, input.scale);
  ctx.release(tile.target);
  ctx.release(input.target);
  return out;
}

/** CC Split's pull towards the line at its middle, as a fraction of the distance from Point A to Point B (splitPull). */
double splitPull(double split) { return 0.006 * std::max(0.0, split); }
/** How far from the line CC Split's pull reaches, as a fraction of the distance from Point A to Point B (SPLIT_REACH). */
constexpr double kSplitReach = 0.86;

/**
 * CC Split, CC Split 2: the layer torn open along the segment from Point A to Point B; CC Split 2 pulls the side to
 * the right of A to B by Split 1 and the other by Split 2.
 */
FxImage split(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx, bool two) {
  const FxParams p(effect);
  const Point a = point(p, 1, layer, input), b = point(p, 2, layer, input);
  const double length = std::hypot(b[0] - a[0], b[1] - a[1]);
  const double right = splitPull(p.num(3, 0)) * length;
  const double left = two ? splitPull(p.num(4, 0)) * length : right;
  if (length < 1e-3 || (right < 1e-3 && left < 1e-3)) return input;
  return warpPass(ctx, input, imageRect(input), fx::cc_split, [&](FxUniforms& u) {
    u.f("u_a", float(a[0]), float(a[1]));
    u.f("u_axis", float((b[0] - a[0]) / length), float((b[1] - a[1]) / length));
    u.f("u_length", float(length));
    u.f("u_pulls", float(right), float(left));
    u.f("u_reach", float(kSplitReach * length));
  });
}

FxImage ccSplit(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) { return split(input, effect, layer, ctx, false); }
FxImage ccSplit2(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) { return split(input, effect, layer, ctx, true); }

/** CC Bender's Style popup. */
enum BenderStyle : int32_t { kBenderBend = 1, kBenderMarilyn = 2, kBenderSharp = 3, kBenderBoxer = 4 };

/** CC Bender: the layer sheared across the line from Base to Top by the style's profile of Amount. */
FxImage ccBender(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const Point top = point(p, 4, layer, input), base = point(p, 5, layer, input);
  const double length = std::hypot(top[0] - base[0], top[1] - base[1]);
  const FxRect r = imageRect(input);
  const FxRect box = layerRect(layer, input);
  const double amount = p.num(1, 0) / 200 * (p.flag(3, false) ? length : std::hypot(box.width, box.height) / 2);
  if (length < 1e-3 || std::abs(amount) < 1e-3) return input;
  const int32_t style = p.choice(2, kBenderBend);
  const Point axis = {(top[0] - base[0]) / length, (top[1] - base[1]) / length};
  double reach = 1;
  const Point corners[4] = {{r.x, r.y}, {r.x + r.width, r.y}, {r.x, r.y + r.height}, {r.x + r.width, r.y + r.height}};
  for (const Point& q : corners) reach = std::max(reach, ((q[0] - base[0]) * axis[0] + (q[1] - base[1]) * axis[1]) / length);
  const double grow = std::abs(amount) * (style == kBenderBend ? 2 * reach - 1 : 1);
  FxImage out = layerPass(ctx, clampRect(growRect(r, grow, grow)), {input}, fx::cc_bender, [&](FxUniforms& u) {
    u.f("u_base", float(base[0]), float(base[1]));
    u.f("u_axis", float(axis[0]), float(axis[1]));
    u.f("u_length", float(length));
    u.f("u_amount", float(amount));
    u.i("u_style", style);
  }, input.scale);
  ctx.release(input.target);
  return out;
}

/** The most cells a side Bezier Warp's mesh has (BEZIER_MAX_CELLS). */
constexpr int32_t kBezierMaxCells = 10;

/**
 * Bezier Warp's mesh (bezierMesh): the bicubic patch whose boundary is the four cubic curves of `pts` (vertices and
 * tangents clockwise from the top left), its inner control points completing each corner's parallelogram, at the
 * (cells + 1)^2 nodes of a cells x cells grid, row by row.
 */
std::vector<Point> bezierMesh(const std::array<Point, 12>& pts, int32_t cells) {
  const auto& [tl, t1, t2, tr, r1, r2, br, b1, b2, bl, l1, l2] = pts;
  const auto corner = [](const Point& a, const Point& b, const Point& c) { return Point{a[0] + b[0] - c[0], a[1] + b[1] - c[1]}; };
  const Point net[4][4] = {{tl, t1, t2, tr}, {l2, corner(t1, l2, tl), corner(t2, r1, tr), r1}, {l1, corner(b2, l1, bl), corner(b1, r2, br), r2}, {bl, b2, b1, br}};
  const auto bern = [](double t) { return std::array<double, 4>{std::pow(1 - t, 3), 3 * (1 - t) * (1 - t) * t, 3 * (1 - t) * t * t, t * t * t}; };
  std::vector<Point> nodes;
  nodes.reserve(size_t(cells + 1) * size_t(cells + 1));
  for (int32_t j = 0; j <= cells; j++) {
    const std::array<double, 4> bv = bern(double(j) / cells);
    for (int32_t i = 0; i <= cells; i++) {
      const std::array<double, 4> bu = bern(double(i) / cells);
      Point q = {0, 0};
      for (int r = 0; r < 4; r++) {
        for (int c = 0; c < 4; c++) {
          q[0] += net[r][c][0] * bv[r] * bu[c];
          q[1] += net[r][c][1] * bv[r] * bu[c];
        }
      }
      nodes.push_back(q);
    }
  }
  return nodes;
}

/** Bezier Warp: the layer's box drawn on bezierMesh with Quality cells a side, each cell bilinear. */
FxImage bezierWarp(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const FxRect box = layerRect(layer, input);
  const double x0 = box.x / k, y0 = box.y / k, w = box.width / k, h = box.height / k;
  static const double kDefaults[12][2] = {{0, 0}, {1.0 / 3, 0}, {2.0 / 3, 0}, {1, 0}, {1, 1.0 / 3}, {1, 2.0 / 3},
                                          {1, 1}, {2.0 / 3, 1}, {1.0 / 3, 1}, {0, 1}, {0, 2.0 / 3}, {0, 1.0 / 3}};
  std::array<Point, 12> pts;
  for (uint32_t i = 0; i < 12; i++) {
    const std::vector<double> q = p.vec(i + 1, {x0 + kDefaults[i][0] * w, y0 + kDefaults[i][1] * h});
    pts[i] = {q[0] * k, (q.size() > 1 ? q[1] : 0) * k};
  }
  const int32_t cells = int32_t(std::round(std::clamp(p.num(14, 8), 1.0, double(kBezierMaxCells))));
  const std::vector<Point> nodes = bezierMesh(pts, cells);
  const FxRect bounds = boundsOf(nodes.data(), nodes.size());
  const FxRect out = clampRect(growRect(bounds, 2, 2));
  std::vector<float> flat;
  flat.reserve(nodes.size() * 2);
  for (const Point& n : nodes) {
    flat.push_back(float(n[0]));
    flat.push_back(float(n[1]));
  }
  return warpPass(ctx, input, out, fx::bezier_warp, [&](FxUniforms& u) {
    u.fv("u_nodes", flat.data(), uint32_t(nodes.size()), 2);
    u.i("u_cells", cells);
    u.f("u_box", float(box.x), float(box.y), float(box.width), float(box.height));
  });
}

/**
 * The point at unit-square coordinates (u, v) of the map taking the unit square's corners (0,0), (1,0), (0,1), (1,1)
 * to the pins, bilinear or projective (expandedPins in distortExtra.ts).
 */
std::array<double, 2> pinnedPoint(const std::array<std::array<double, 2>, 4>& pins, double u, double v, bool bilinear) {
  if (bilinear) {
    std::array<double, 2> q;
    for (int c = 0; c < 2; c++) q[c] = pins[0][c] * (1 - u) * (1 - v) + pins[1][c] * u * (1 - v) + pins[2][c] * (1 - u) * v + pins[3][c] * u * v;
    return q;
  }
  /** squareToQuad and project in stockMath.ts. */
  const double x0 = pins[0][0], y0 = pins[0][1], x1 = pins[1][0], y1 = pins[1][1];
  const double x2 = pins[2][0], y2 = pins[2][1], x3 = pins[3][0], y3 = pins[3][1];
  const double dx1 = x1 - x3, dy1 = y1 - y3, dx2 = x2 - x3, dy2 = y2 - y3;
  const double sx = x0 - x1 - x2 + x3, sy = y0 - y1 - y2 + y3;
  double g = 0, h = 0;
  if (std::abs(sx) > 1e-12 || std::abs(sy) > 1e-12) {
    const double det = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / det;
    h = (dx1 * sy - sx * dy1) / det;
  }
  const double w = g * u + h * v + 1;
  return {((x1 - x0 + g * x1) * u + (x2 - x0 + h * x2) * v + x0) / w, ((y1 - y0 + g * y1) * u + (y2 - y0 + h * y2) * v + y0) / w};
}

/**
 * CC Power Pin: the layer's box mapped projectively (bilinearly at Perspective 0) onto the four pins, each edge of the
 * quad first carried on past its pins by its Expansion percentage of the map; the output covers that quad.
 */
FxImage ccPowerPin(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const FxRect box = layerRect(layer, input);
  const double x0 = box.x / k, y0 = box.y / k, x1 = (box.x + box.width) / k, y1 = (box.y + box.height) / k;
  const Point defaults[4] = {{x0, y0}, {x1, y0}, {x0, y1}, {x1, y1}};
  std::array<std::array<double, 2>, 4> placed;
  for (uint32_t i = 0; i < 4; i++) {
    const std::vector<double> v = p.vec(i + 2, {defaults[i][0], defaults[i][1]});
    placed[i] = {v[0] * k, (v.size() > 1 ? v[1] : 0) * k};
  }
  const double perspective = std::clamp(p.num(6, 1), 0.0, 1.0);
  if (perspective > 0 && perspective < 1) ctx.warn("CC Power Pin: Perspective between 0 and 100% is drawn as full perspective");
  const double top = p.num(9, 0) / 100, left = p.num(10, 0) / 100, right = p.num(11, 0) / 100, bottom = p.num(12, 0) / 100;
  /** Expansion moves each edge of the quad out by its percentage of the pinned map, and the whole layer fills it (measured against After Effects). */
  const double at[4][2] = {{-left, -top}, {1 + right, -top}, {-left, 1 + bottom}, {1 + right, 1 + bottom}};
  std::array<std::array<double, 2>, 4> pins;
  for (int i = 0; i < 4; i++) pins[i] = pinnedPoint(placed, at[i][0], at[i][1], perspective == 0);
  std::array<double, 9> m;
  const bool inverse = cornerPinInverse(pins, m);
  const FxRect out = clampRect(boundsOf(pins.data(), 4));
  if (!inverse || out.width < 1 || out.height < 1) return nothing(input, ctx);
  float flat[8];
  for (int i = 0; i < 4; i++) {
    flat[2 * i] = float(pins[i][0]);
    flat[2 * i + 1] = float(pins[i][1]);
  }
  FxImage result = layerPass(ctx, out, {input}, fx::cc_power_pin, [&](FxUniforms& u) {
    // Row-major to GLSL's column-major.
    const float columns[9] = {float(m[0]), float(m[3]), float(m[6]), float(m[1]), float(m[4]), float(m[7]), float(m[2]), float(m[5]), float(m[8])};
    u.matrix("u_inverse", columns);
    u.f("u_rect", float(box.x), float(box.y), float(box.width), float(box.height));
    u.fv("u_pins", flat, 4, 2);
    u.i("u_bilinear", perspective == 0 ? 1 : 0);
  }, input.scale);
  ctx.release(input.target);
  return result;
}

}  // namespace

FxRenderer spherizeRenderer() { return spherize; }
FxRenderer rippleRenderer() { return ripple; }
FxRenderer magnifyRenderer() { return magnify; }
FxRenderer ccLensRenderer() { return ccLens; }
FxRenderer ccSlantRenderer() { return ccSlant; }
FxRenderer ccTilerRenderer() { return ccTiler; }
FxRenderer ccSplitRenderer() { return ccSplit; }
FxRenderer ccSplit2Renderer() { return ccSplit2; }
FxRenderer ccBenderRenderer() { return ccBender; }
FxRenderer bezierWarpRenderer() { return bezierWarp; }
FxRenderer ccPowerPinRenderer() { return ccPowerPin; }

}  // namespace aevk
