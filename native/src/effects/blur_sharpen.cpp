/**
 * Blur & Sharpen effects of src/render/effects/blurSharpen.ts: Gaussian Blur (and the legacy Gaussian Blur and Fast
 * Blur), Directional Blur, Radial Blur, Sharpen and Unsharp Mask, on premultiplied pixels.
 */
#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

#include "effects.h"
#include "gaussian.h"
#include "stock.h"

namespace aevk {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = kPi / 180;

/** Gaussian Blur: Blurriness as a standard deviation, on the axes Blur Dimensions picks, Repeat Edge Pixels within the layer. */
FxImage gaussianBlur(FxImage input, FxContext& ctx, const EffectLayer& layer, double blurriness, double dimensions, bool repeatEdges) {
  const double sigma = blurrinessSigma(blurriness) * input.scale;
  const FxRect rect = layerRect(layer, input);
  return gaussian(ctx, input, blurHorizontal(dimensions) ? sigma : 0, blurVertical(dimensions) ? sigma : 0, repeatEdges ? &rect : nullptr);
}

FxImage gaussianBlur2(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  return gaussianBlur(input, ctx, layer, p.num(1, 0), p.num(2, 1), p.flag(3, false));
}

FxImage gaussianBlurLegacy(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  return gaussianBlur(input, ctx, layer, p.num(1, 0), p.num(2, 1), false);
}

/** Directional Blur: a box of Blur Length pixels in all along Direction (0 = vertical). */
FxImage directionalBlur(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double length = std::max(0.0, p.num(2, 0)) * input.scale;
  if (length < 0.5) return input;
  const std::array<double, 2> d = directionVector(p.num(1, 0));
  const double half = length / 2;
  FxImage image = grown(ctx, input, std::ceil(half));
  const int32_t taps = std::min(257, int32_t(std::ceil(length)) + 1);
  return mapPass(ctx, image, fx::directional_blur, [&](FxUniforms& u) {
    u.f("u_half", float(d[0] * half), float(-d[1] * half));
    u.i("u_taps", taps);
  });
}

/** The most taps Radial Blur averages per pixel (RADIAL_TAPS). */
constexpr int32_t kRadialTaps = 256;

/** What Radial Blur's sweep of `rect` about `center` reaches (radialBlurBounds in stockMath.ts). */
FxRect radialBlurBounds(const FxRect& rect, const std::array<double, 2>& center, bool zoom, double span) {
  double x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.width, y1 = rect.y + rect.height;
  const auto add = [&](double x, double y) {
    x0 = std::min(x0, x);
    y0 = std::min(y0, y);
    x1 = std::max(x1, x);
    y1 = std::max(y1, y);
  };
  const double corners[4][2] = {{rect.x, rect.y}, {rect.x + rect.width, rect.y}, {rect.x, rect.y + rect.height}, {rect.x + rect.width, rect.y + rect.height}};
  for (const auto& c : corners) {
    const double vx = c[0] - center[0], vy = c[1] - center[1];
    if (zoom) {
      const double f = 1 / std::max(0.05, 1 - span / 2);
      add(center[0] + vx * f, center[1] + vy * f);
      continue;
    }
    // The arc between two samples bulges past their chord by at most r(1 - cos(step / 2)).
    const int steps = 32;
    const double step = span / steps;
    const double bulge = 1 / std::cos(std::min(step / 2, 1.5));
    for (int i = 0; i <= steps; i++) {
      const double t = (double(i) / steps - 0.5) * span;
      const double cs = std::cos(t) * bulge, sn = std::sin(t) * bulge;
      add(center[0] + cs * vx - sn * vy, center[1] + sn * vx + cs * vy);
    }
  }
  return {x0, y0, x1 - x0, y1 - y0};
}

/** Radial Blur's Type popup. */
enum RadialType { kSpin = 1, kZoom = 2 };

/** Radial Blur: each pixel averages the layer along its arc about Center (Spin) or its ray from Center (Zoom). */
FxImage radialBlur(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double amount = std::max(0.0, p.num(1, 10));
  if (amount < 1e-3) return input;
  const double k = input.scale;
  const bool zoom = p.choice(3, kSpin) == kZoom;
  const std::array<double, 2> middle = layerCenter(layer, input);
  const std::vector<double> c = p.vec(2, {middle[0], middle[1]});
  const std::array<double, 2> center = {(c.size() > 0 ? c[0] : 0) * k, (c.size() > 1 ? c[1] : 0) * k};
  const double span = zoom ? std::min(1.0, amount / 100) : amount * kDeg;
  const FxRect rect = clampRect(radialBlurBounds(imageRect(input), center, zoom, span));
  double reach = 0;
  const double corners[4][2] = {{rect.x, rect.y}, {rect.x + rect.width, rect.y}, {rect.x, rect.y + rect.height}, {rect.x + rect.width, rect.y + rect.height}};
  for (const auto& q : corners) reach = std::max(reach, std::hypot(q[0] - center[0], q[1] - center[1]));
  const int32_t taps = std::min(kRadialTaps, std::max(2, int32_t(std::ceil(span * reach)) + 1));
  const FxImage out = layerPass(ctx, rect, {input}, fx::radial_blur, [&](FxUniforms& u) {
    u.f("u_center", float(center[0]), float(center[1]));
    u.f("u_span", float(span));
    u.i("u_zoom", zoom ? 1 : 0);
    u.i("u_taps", taps);
  }, input.scale);
  ctx.release(input.target);
  return out;
}

FxImage sharpen(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double amount = std::max(0.0, p.num(1, 0)) / 100;
  if (!amount) return input;
  return mapPass(ctx, input, fx::sharpen, [&](FxUniforms& u) { u.f("u_amount", float(amount)); });
}

/** Unsharp Mask: the difference from a Gaussian of standard deviation Radius, scaled by Amount, where it exceeds Threshold. */
FxImage unsharpMask(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double amount = std::max(0.0, p.num(1, 50)) / 100;
  const double radius = std::max(0.0, p.num(2, 1)) * input.scale;
  if (!amount || radius < 0.1) return input;
  const FxRect rect = imageRect(input);
  const FxImage blurred = gaussian(ctx, copyImage(ctx, input), radius, radius, &rect);
  const FxImage out = mapPass(ctx, input, fx::unsharp, [&](FxUniforms& u) {
    u.f("u_amount", float(amount));
    u.f("u_threshold", float(std::max(0.0, p.num(3, 0))));
  }, {blurred});
  ctx.release(blurred.target);
  return out;
}

}  // namespace

FxRenderer gaussianBlurRenderer() { return gaussianBlur2; }
FxRenderer gaussianBlurLegacyRenderer() { return gaussianBlurLegacy; }
FxRenderer directionalBlurRenderer() { return directionalBlur; }
FxRenderer radialBlurRenderer() { return radialBlur; }
FxRenderer sharpenRenderer() { return sharpen; }
FxRenderer unsharpMaskRenderer() { return unsharpMask; }

}  // namespace aevk
