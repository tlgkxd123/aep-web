/**
 * Distort effects of src/render/effects/displace.ts that move the layer's pixels by a field: Wave Warp, Bulge, Twirl
 * and Optics Compensation. Each output pixel shows the input at the point the field gives (bilinear; transparent
 * outside the layer). Points are layer pixels, times the image's scale at a reduced resolution.
 */
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <vector>

#include "effects.h"
#include "stock.h"

namespace aevk {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = kPi / 180;

using Point = std::array<double, 2>;

/** A point parameter in image pixels, defaulting to the layer's centre. */
Point centerPoint(const FxParams& p, uint32_t index, const EffectLayer& layer, const FxImage& input) {
  const Point c = layerCenter(layer, input);
  const std::vector<double> v = p.vec(index, {c[0], c[1]});
  return {v[0] * input.scale, (v.size() > 1 ? v[1] : 0) * input.scale};
}

/** Wave Warp's Wave Type choices. */
enum WaveType : int32_t { kWaveSine = 1 };

/** Wave Warp's Pinning choices. */
enum WavePin : int32_t { kPinNone = 1 };

/**
 * Wave Warp: the layer moved across Direction (degrees, clockwise from up; the waves travel along it) by Wave Height
 * times a wave of Wave Width pixels, travelling Wave Speed cycles a second from Phase (degrees). Pinning holds the
 * chosen edges (or the centre), easing over one Wave Width. The layer grows by the wave height.
 */
FxImage waveWarp(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const double height = p.num(2, 10) * k;
  if (std::abs(height) < 1e-3) return input;
  const double width = std::max(1.0, p.num(3, 40)) * k;
  const std::array<double, 2> travel = directionVector(p.num(4, 90));
  const Point normal = {-travel[1], travel[0]};
  const double shift = p.num(5, 1) * layerTimeAt(layer) - p.num(7, 0) / 360;
  const FxRect box = layerRect(layer, input);
  const FxRect rect = clampRect(growRect(imageRect(input), std::abs(normal[0] * height), std::abs(normal[1] * height)));
  return warpPass(ctx, input, rect, fx::wave_warp, [&](FxUniforms& u) {
    u.i("u_type", p.choice(1, kWaveSine));
    u.f("u_height", float(height));
    u.f("u_width", float(width));
    u.f("u_travel", float(travel[0]), float(travel[1]));
    u.f("u_normal", float(normal[0]), float(normal[1]));
    u.f("u_shift", float(shift));
    u.i("u_pin", p.choice(6, kPinNone));
    u.f("u_box", float(box.x), float(box.y), float(box.width), float(box.height));
  });
}

/**
 * Bulge: the ellipse of Horizontal and Vertical Radius about Bulge Center magnified (positive Bulge Height) or pinched
 * (negative) on bulgeShape (stockMath.ts); Pin All Edges holds the layer's edges. Taper Radius is not drawn.
 */
FxImage bulge(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double bulgeHeight = p.num(4, 1);
  /** bulgeShape in stockMath.ts. */
  const double h = std::min(std::abs(bulgeHeight), 4.0) / 4;
  if (h < 1e-6) return input;
  const double r = (1 + h) / (2 * std::sqrt(h));
  const double invR = 1 / r, arcScale = 1 / std::asin(std::min(1.0, 1 / r)), exponent = 1.3 * h * h * h;
  const double k = input.scale;
  const double rx = std::max(1e-3, p.num(1, 50)) * k, ry = std::max(1e-3, p.num(2, 50)) * k;
  const Point c = centerPoint(p, 3, layer, input);
  if (p.num(5, 0) > 0) ctx.warn("Bulge: Taper Radius is ignored");
  const FxRect box = layerRect(layer, input);
  return warpPass(ctx, input, imageRect(input), fx::bulge, [&](FxUniforms& u) {
    u.f("u_center", float(c[0]), float(c[1]));
    u.f("u_radius", float(rx), float(ry));
    u.f("u_invR", float(invR));
    u.f("u_arcScale", float(arcScale));
    u.f("u_exponent", float(exponent));
    u.f("u_sign", bulgeHeight > 0 ? 1.0f : bulgeHeight < 0 ? -1.0f : 0.0f);
    u.i("u_pin", p.flag(7, false) ? 1 : 0);
    u.f("u_box", float(box.x), float(box.y), float(box.width), float(box.height));
    u.f("u_reach", float(std::max(1.0, 0.25 * std::min(rx, ry))));
  });
}

/**
 * Twirl: the layer turned about Twirl Center by Angle (degrees, clockwise) at the centre, easing to nothing at Twirl
 * Radius, a percentage of the layer's larger side (twirlTurn in stockMath.ts).
 */
FxImage twirl(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double angle = p.num(1, 0);
  const FxRect box = layerRect(layer, input);
  const double radius = std::max(0.0, p.num(2, 30)) / 100 * std::max(box.width, box.height);
  if (std::abs(angle) < 1e-6 || radius < 1e-3) return input;
  const Point c = centerPoint(p, 3, layer, input);
  return warpPass(ctx, input, imageRect(input), fx::twirl, [&](FxUniforms& u) {
    u.f("u_center", float(c[0]), float(c[1]));
    u.f("u_radius", float(radius));
    u.f("u_angle", float(angle * kDeg));
  });
}

/** Optics Compensation's FOV Orientation choices. */
enum OpticsOrientation : int32_t { kOpticsHorizontal = 1, kOpticsVertical = 2, kOpticsDiagonal = 3 };

/** The size each Resize choice allows, as a multiple of the layer's (OPTICS_RESIZE). */
constexpr double kOpticsResize[] = {0, 1, 2, 4, 8};

/** The radius from View Center of the input point shown at radius r (opticsSourceRadius in stockMath.ts). */
double opticsSourceRadius(double r, const Point& focals, bool reverse) {
  if (reverse) return focals[1] * std::atan(r / focals[0]);
  const double angle = r / focals[1];
  return angle < kPi / 2 ? focals[0] * std::tan(angle) : std::numeric_limits<double>::infinity();
}

/**
 * What a reversed, resized Optics Compensation covers: the layer's edges carried out by the lens, within `factor`
 * times the layer's size about its middle (opticsBounds in stockMath.ts).
 */
FxRect opticsBounds(const FxRect& rect, const Point& center, const Point& focals, bool reverse, double factor) {
  double x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.width, y1 = rect.y + rect.height;
  const int steps = 16;
  for (int i = 0; i <= steps; i++) {
    const double t = double(i) / steps;
    const Point edge[4] = {{rect.x + t * rect.width, rect.y},
                           {rect.x + t * rect.width, rect.y + rect.height},
                           {rect.x, rect.y + t * rect.height},
                           {rect.x + rect.width, rect.y + t * rect.height}};
    for (const Point& e : edge) {
      const double vx = e[0] - center[0], vy = e[1] - center[1];
      const double r = std::hypot(vx, vy);
      /** opticsTargetRadius: the inverse lens. */
      const double s = r > 0 ? std::min(1e7, opticsSourceRadius(r, focals, !reverse)) / r : 1;
      const double x = center[0] + vx * s, y = center[1] + vy * s;
      x0 = std::min(x0, x);
      y0 = std::min(y0, y);
      x1 = std::max(x1, x);
      y1 = std::max(y1, y);
    }
  }
  const double w = rect.width * factor, h = rect.height * factor;
  const double mx = rect.x + rect.width / 2, my = rect.y + rect.height / 2;
  const double bx = std::max(x0, mx - w / 2), by = std::max(y0, my - h / 2);
  return {bx, by, std::min(x1, mx + w / 2) - bx, std::min(y1, my + h / 2) - by};
}

/**
 * Optics Compensation: the layer seen through a fisheye lens of Field Of View across its width, height or diagonal
 * (FOV Orientation) about View Center, or with Reverse Lens Distortion the fisheye removed. Resize grows the reversed
 * layer to show what moves past its edges. Optimal Pixels is not drawn.
 */
FxImage opticsCompensation(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double fov = p.num(1, 0);
  if (fov < 1e-3) return input;
  const double k = input.scale;
  const FxRect box = layerRect(layer, input);
  const bool reverse = p.flag(2, false);
  const int32_t orientation = p.choice(3, kOpticsHorizontal);
  const double half = orientation == kOpticsVertical   ? box.height / 2
                      : orientation == kOpticsDiagonal ? std::hypot(box.width, box.height) / 2
                                                       : box.width / 2;
  /** opticsFocals in stockMath.ts: rectilinear and fisheye focal lengths. */
  const double halfAngle = std::min(std::max(fov, 1e-3), 179.0) * kDeg / 2;
  const double extent = std::max(1.0, half);
  const Point focals = {extent / std::tan(halfAngle), extent / halfAngle};
  const std::vector<double> v = p.vec(4, {layerCenter(layer, input)[0], layerCenter(layer, input)[1]});
  const Point center = {v[0] * k, (v.size() > 1 ? v[1] : 0) * k};
  if (p.flag(5, false)) ctx.warn("Optics Compensation: Optimal Pixels is ignored");
  const int32_t resize = p.choice(6, 1);
  const double factor = resize >= 0 && resize < 5 ? kOpticsResize[resize] : 1;
  const FxRect rect = reverse && factor > 1 ? clampRect(opticsBounds(imageRect(input), center, focals, reverse, factor)) : imageRect(input);
  return warpPass(ctx, input, rect, fx::optics_compensation, [&](FxUniforms& u) {
    u.f("u_center", float(center[0]), float(center[1]));
    u.f("u_focals", float(focals[0]), float(focals[1]));
    u.i("u_reverse", reverse ? 1 : 0);
  });
}

}  // namespace

FxRenderer waveWarpRenderer() { return waveWarp; }
FxRenderer bulgeRenderer() { return bulge; }
FxRenderer twirlRenderer() { return twirl; }
FxRenderer opticsCompensationRenderer() { return opticsCompensation; }

}  // namespace aevk
