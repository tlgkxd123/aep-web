/**
 * Stock Distort and Stylize effects of src/render/effects/distort.ts that resample the layer: Transform, Offset,
 * Corner Pin and Motion Tile. Points are layer pixels, times the image's scale at a reduced resolution.
 */
#include <algorithm>
#include <array>
#include <cmath>
#include <optional>
#include <vector>

#include "effects.h"
#include "stock.h"

namespace aevk {
namespace {

constexpr double kDeg = 3.14159265358979323846 / 180;

/** 2D affine [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (Affine in stockMath.ts). */
using Affine = std::array<double, 6>;
/** 3x3 matrix, row-major (Mat3 in stockMath.ts). */
using Mat3 = std::array<double, 9>;

Affine mul(const Affine& m, const Affine& n) {
  return {m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
          m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]};
}
Affine translate(double x, double y) { return {1, 0, 0, 1, x, y}; }
Affine scaling(double x, double y) { return {x, 0, 0, y, 0, 0}; }
Affine rotate(double rad) { return {std::cos(rad), std::sin(rad), -std::sin(rad), std::cos(rad), 0, 0}; }

std::optional<Affine> invert(const Affine& m) {
  const double det = m[0] * m[3] - m[1] * m[2];
  if (std::abs(det) < 1e-12) return std::nullopt;
  const auto [a, b, c, d, e, f] = m;
  return Affine{d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det};
}

/** Transform's matrix (geometryMatrix in stockMath.ts). */
Affine geometryMatrix(const std::vector<double>& anchor, const std::vector<double>& position, double scaleX, double scaleY, double skew,
                      double skewAxis, double rotation) {
  const double s = skew * kDeg, axis = skewAxis * kDeg;
  const Affine skewM = s != 0 ? mul(rotate(-axis), mul(Affine{1, 0, std::tan(-s), 1, 0, 0}, rotate(axis))) : Affine{1, 0, 0, 1, 0, 0};
  return mul(translate(position[0], position[1]),
             mul(rotate(rotation * kDeg), mul(skewM, mul(scaling(scaleX / 100, scaleY / 100), translate(-anchor[0], -anchor[1])))));
}

/** The layer's centre in layer pixels: half its size, or the middle of its box (center in distort.ts). */
std::vector<double> center(const FxRect& r, double k, const EffectLayer& layer) {
  if (layer.width > 0 && layer.height > 0) return {layer.width / 2.0, layer.height / 2.0};
  return {(r.x + r.width / 2) / k, (r.y + r.height / 2) / k};
}

/** Transform: the layer image through anchor, position, scale, skew and rotation, at Opacity, within the layer's box. */
FxImage transform(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const FxRect rect = layerRect(layer, input);
  const std::vector<double> c = center(rect, k, layer);
  std::vector<double> anchor = p.vec(1, c), position = p.vec(2, c);
  anchor.resize(2, 0);
  position.resize(2, 0);
  const bool uniform = p.flag(11, true);
  const double scaleHeight = p.num(3, 100);
  const double scaleWidth = uniform ? scaleHeight : p.num(4, 100);
  Affine m = geometryMatrix(anchor, position, scaleWidth, scaleHeight, p.num(5, 0), p.num(6, 0), p.num(7, 0));
  m[4] *= k;
  m[5] *= k;
  const std::optional<Affine> inverse = invert(m);
  const double opacity = std::clamp(p.num(8, 100) / 100, 0.0, 1.0);
  if (!p.flag(9, true) && p.num(10, 0) > 0) ctx.warn("Transform: motion blur is not rendered");
  if (!inverse) return blankImage(ctx, input, rect);
  const Affine& v = *inverse;
  return warpPass(ctx, input, unionRect(rect, imageRect(input)), fx::geometry, [&](FxUniforms& u) {
    u.f("u_m0", float(v[0]), float(v[2]), float(v[4]));
    u.f("u_m1", float(v[1]), float(v[3]), float(v[5]));
    u.f("u_opacity", float(opacity));
  });
}

/** Offset: the layer shifted so its centre lands on Shift Center To, wrapping around its box. */
FxImage offset(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const FxRect rect = layerRect(layer, input);
  const std::vector<double> c = center(rect, k, layer);
  std::vector<double> shift = p.vec(1, c);
  shift.resize(2, 0);
  const double blend = std::clamp(p.num(2, 0) / 100, 0.0, 1.0);
  FxImage out = layerPass(ctx, rect, {input}, fx::offset, [&](FxUniforms& u) {
    u.f("u_rect", float(rect.x), float(rect.y), float(rect.width), float(rect.height));
    u.f("u_shift", float((shift[0] - c[0]) * k), float((shift[1] - c[1]) * k));
    u.f("u_blend", float(blend));
  }, input.scale);
  ctx.release(input.target);
  return out;
}

/** Corner Pin: the layer's box mapped projectively onto the four pins; the output covers the pinned quad. */
FxImage cornerPin(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const FxRect rect = layerRect(layer, input);
  const double x0 = rect.x / k, y0 = rect.y / k, x1 = (rect.x + rect.width) / k, y1 = (rect.y + rect.height) / k;
  std::array<std::array<double, 2>, 4> pins;
  const std::array<std::array<double, 2>, 4> defaults = {{{x0, y0}, {x1, y0}, {x0, y1}, {x1, y1}}};
  for (uint32_t i = 0; i < 4; i++) {
    std::vector<double> v = p.vec(i + 1, {defaults[i][0], defaults[i][1]});
    v.resize(2, 0);
    pins[i] = {v[0] * k, v[1] * k};
  }
  Mat3 m;
  const bool inverse = cornerPinInverse(pins, m);
  double minX = pins[0][0], maxX = minX, minY = pins[0][1], maxY = minY;
  for (const auto& pin : pins) {
    minX = std::min(minX, pin[0]);
    maxX = std::max(maxX, pin[0]);
    minY = std::min(minY, pin[1]);
    maxY = std::max(maxY, pin[1]);
  }
  const FxRect out = clampRect({minX, minY, maxX - minX, maxY - minY});
  if (!inverse || out.width < 1 || out.height < 1) return blankImage(ctx, input, {rect.x, rect.y, 1, 1});
  return warpPass(ctx, input, out, fx::corner_pin, [&](FxUniforms& u) {
    // Row-major to GLSL's column-major.
    const float columns[9] = {float(m[0]), float(m[3]), float(m[6]), float(m[1]), float(m[4]), float(m[7]), float(m[2]), float(m[5]), float(m[8])};
    u.matrix("u_inverse", columns);
    u.f("u_rect", float(rect.x), float(rect.y), float(rect.width), float(rect.height));
  });
}

/**
 * Motion Tile: the layer shrunk to Tile Width x Tile Height and repeated around Tile Center over an output of Output
 * Width x Output Height of the layer's box; alternate columns (or rows, with Horizontal Phase Shift) shift by Phase,
 * and alternate tiles are mirrored with Mirror Edges.
 */
FxImage motionTile(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const FxRect rect = layerRect(layer, input);
  std::vector<double> c = p.vec(1, center(rect, k, layer));
  c.resize(2, 0);
  const double cx = c[0] * k, cy = c[1] * k;
  const double tileW = std::max(1e-3, p.num(2, 100) / 100) * rect.width, tileH = std::max(1e-3, p.num(3, 100) / 100) * rect.height;
  const double ow = std::max(0.0, p.num(4, 100) / 100), oh = std::max(0.0, p.num(5, 100) / 100);
  const double midX = rect.x + rect.width / 2, midY = rect.y + rect.height / 2;
  const FxRect out = clampRect({midX - rect.width * ow / 2, midY - rect.height * oh / 2, rect.width * ow, rect.height * oh});
  if (out.width < 1 || out.height < 1) return blankImage(ctx, input, {rect.x, rect.y, 1, 1});
  const double phase = p.num(7, 0) / 360;
  const bool horizontal = p.flag(8, false), mirror = p.flag(6, false);
  return warpPass(ctx, input, out, fx::motion_tile, [&](FxUniforms& u) {
    u.f("u_center", float(cx), float(cy));
    u.f("u_tile", float(tileW), float(tileH));
    u.f("u_rect", float(rect.x), float(rect.y), float(rect.width), float(rect.height));
    u.f("u_phase", float(phase));
    u.i("u_horizontal", horizontal ? 1 : 0);
    u.i("u_mirror", mirror ? 1 : 0);
  });
}

}  // namespace

FxRenderer transformRenderer() { return transform; }
FxRenderer offsetRenderer() { return offset; }
FxRenderer cornerPinRenderer() { return cornerPin; }
FxRenderer motionTileRenderer() { return motionTile; }

}  // namespace aevk
