/**
 * Stylize effects, ported from src/render/effects/stylizeExtra.ts with the same shaders: Strobe Light.
 */
#include <algorithm>
#include <cmath>

#include "effects.h"
#include "stock.h"

namespace aevk {
namespace {

/** Strobe Light's Strobe popup and Strobe Operator's default. */
enum StrobeKind { kStrobeColor = 1, kStrobeTransparent = 2 };
constexpr int32_t kStrobeCopy = 1;

/** Steps per second Strobe Light rounds Strobe Duration and Period to: this decides the frames on the boundaries. */
constexpr double kStrobeTicks = 10000;

/** Whether Strobe Light strobes at layer time `t` (strobeOn). */
bool strobeOn(double t, double duration, double period) {
  const double p = std::floor(period * kStrobeTicks + 0.5);
  if (p <= 0) return false;
  return std::fmod(t * kStrobeTicks, p) < p - std::floor(duration * kStrobeTicks + 0.5);
}

/**
 * Strobe Light: during each strobe the layer's colour combined with Strobe Color by Strobe Operator (or the layer made
 * transparent), mixed with the layer by Blend With Original.
 */
FxImage strobe(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double t = layer.time - layer.startTime;
  if (p.num(5, 0) > 0) ctx.warn("Strobe Light: Random Strobe Probability is not rendered");
  if (!strobeOn(t, p.num(3, 0.5), p.num(4, 1))) return input;
  const float blend = float(std::min(1.0, std::max(0.0, p.num(2, 0) / 100)));
  return pixelPass(ctx, input, fx::strobe, [&](FxUniforms& u) {
    const std::array<float, 3> color = p.rgb(1, {1, 1, 1});
    u.fv("u_color", color.data(), 1, 3);
    u.i("u_kind", p.choice(6, kStrobeColor));
    u.i("u_op", p.choice(7, kStrobeCopy));
    u.f("u_blend", blend);
  });
}

}  // namespace

FxRenderer strobeRenderer() { return strobe; }

}  // namespace aevk
