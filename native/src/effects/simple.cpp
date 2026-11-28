/**
 * One-pass effects, ported with the same shaders: Fill (matte.ts), Polar Coordinates (polar.ts), Mirror and Gradient
 * Ramp (mirrorRamp.ts).
 */
#include <algorithm>
#include <cmath>

#include "effects.h"
#include "stock.h"

namespace aevk {
namespace {

/** Fill: the layer's colour replaced by Color at Opacity, keeping its alpha; mask fills are drawn as whole-layer fills. */
FxImage fill(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double opacity = std::min(1.0, std::max(0.0, p.num(5, 1)));
  const bool masked = p.num(1, 0) != 0 || p.flag(7, false);
  const bool inverted = p.flag(6, false);
  if (masked) ctx.warn("Fill: filling within a mask is drawn as filling the whole layer");
  if (inverted || opacity <= 0) {
    if (inverted && masked) ctx.warn("Fill: an inverted mask fill is not drawn");
    return input;
  }
  return mapPass(ctx, input, fx::fill, [&](FxUniforms& u) {
    const std::array<float, 3> color = p.rgb(2, {1, 0, 0});
    u.fv("u_color", color.data(), 1, 3);
    u.f("u_opacity", float(opacity));
  });
}

/** Polar Coordinates, fitted to After Effects renders (polar.ts). */
FxImage polar(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const double amount = std::min(1.0, std::max(0.0, fxNumber(effect, 1, 0)));
  const bool toRect = fxNumber(effect, 2, 1) == 2;
  if (amount == 0) return input;
  Target* out = ctx.acquire(input.width + 2 * ctx.pad, input.height + 2 * ctx.pad);
  ctx.pass(fx::polar, *out, {input.target}, [&](FxUniforms& u) {
    u.i("u_source", 0);
    u.f("u_size", float(input.width), float(input.height));
    u.f("u_pad", float(ctx.pad));
    u.f("u_amount", float(amount));
    u.i("u_toRect", toRect ? 1 : 0);
  });
  ctx.release(input.target);
  input.target = out;
  return input;
}

/** Mirror: the side the line's normal points into shows the other side reflected. */
FxImage mirror(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const double k = input.scale;
  const std::vector<double> c = fxVector(effect, 1, layerMiddle(layer));
  const double angle = fxNumber(effect, 2, 0) * M_PI / 180;
  return mapPass(ctx, input, fx::mirror, [&](FxUniforms& u) {
    u.f("u_origin", input.originX, input.originY);
    u.f("u_center", float((c[0] + 0.5) * k), float(((c.size() > 1 ? c[1] : 0) + 0.5) * k));
    u.f("u_normal", float(std::cos(angle)), float(std::sin(angle)));
  });
}

/** Gradient Ramp: the layer's colour becomes the ramp from Start Color to End Color, keeping its alpha. */
FxImage ramp(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const double k = input.scale;
  const std::vector<double> start = fxVector(effect, 1, {0, 0});
  const std::vector<double> startColor = fxVector(effect, 2, {0, 0, 0, 1});
  const std::vector<double> end = fxVector(effect, 3, {0, layer.height});
  const std::vector<double> endColor = fxVector(effect, 4, {1, 1, 1, 1});
  const bool radial = fxNumber(effect, 5, 1) == 2;
  if (fxNumber(effect, 6, 0) > 0) ctx.warn("Gradient Ramp: Ramp Scatter is not rendered");
  const double blend = std::min(1.0, std::max(0.0, fxNumber(effect, 7, 0) / 100));
  const auto at = [](const std::vector<double>& v, size_t i) { return float(i < v.size() ? v[i] : 0); };
  return mapPass(ctx, input, fx::ramp, [&](FxUniforms& u) {
    u.f("u_origin", input.originX, input.originY);
    u.f("u_start", float(at(start, 0) * k), float(at(start, 1) * k));
    u.f("u_end", float(at(end, 0) * k), float(at(end, 1) * k));
    u.f("u_startColor", at(startColor, 0), at(startColor, 1), at(startColor, 2));
    u.f("u_endColor", at(endColor, 0), at(endColor, 1), at(endColor, 2));
    u.i("u_radial", radial ? 1 : 0);
    u.f("u_blend", float(blend));
  });
}

}  // namespace

FxRenderer fillRenderer() { return fill; }
FxRenderer polarRenderer() { return polar; }
FxRenderer mirrorRenderer() { return mirror; }
FxRenderer rampRenderer() { return ramp; }

}  // namespace aevk
