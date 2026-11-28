/**
 * CC Vignette (vignette.ts) and Minimax (minimax.ts). Neither is scalable: both read whole-pixel distances, so they
 * run on the layer at full resolution.
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

/**
 * CC Vignette: the layer darkened toward its edges by Amount, falling off over Angle of View about Center, with Pin
 * Highlights holding back its brightest pixels. An untouched Center is stored as a percentage of the layer.
 */
FxImage vignette(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double amount = p.num(1, 50) / 100;
  const double angle = p.num(2, 45);
  std::vector<double> center = p.vec(3, {input.width / 2.0, input.height / 2.0});
  if (center.size() < 2) center.resize(2, 0);
  if (std::abs(center[0]) > input.width * 10.0 || std::abs(center[1]) > input.height * 10.0) {
    center[0] /= 100;
    center[1] /= 100;
  }
  const double pin = p.num(5, 0) / 100;
  if (amount == 0) return input;
  return mapPass(ctx, input, fx::cs_vignette, [&](FxUniforms& u) {
    u.f("u_center", float(center[0] - input.originX), float(center[1] - input.originY));
    u.f("u_amount", float(amount));
    u.f("u_tanHalf", float(std::tan(angle / 2 * kPi / 180)));
    u.f("u_pin", float(std::pow(std::max(0.0, pin), 0.72)));
  });
}

/** Minimax's Channel choices: the channels each one filters. */
constexpr std::array<float, 4> kMinimaxChannels[] = {
  {1, 1, 1, 0}, {1, 1, 1, 0}, {1, 1, 1, 1}, {1, 0, 0, 0}, {0, 1, 0, 0}, {0, 0, 1, 0}, {0, 0, 0, 1},
};

/** Minimax's Direction choices. */
enum MinimaxDirection : int32_t { kMinimaxHorizontal = 2, kMinimaxVertical = 3 };

/** One minimum or maximum of `radius` pixels, horizontally, vertically or both, over the channels in `mask`. */
FxImage minimaxFilter(FxContext& ctx, FxImage image, bool max, int32_t radius, int32_t direction, const std::array<float, 4>& mask, bool keepEdges) {
  std::vector<std::array<float, 2>> dirs;
  if (direction != kMinimaxVertical) dirs.push_back({1, 0});
  if (direction != kMinimaxHorizontal) dirs.push_back({0, 1});
  for (const auto& dir : dirs) {
    image = mapPass(ctx, image, fx::minimax, [&](FxUniforms& u) {
      u.f("u_dir", dir[0], dir[1]);
      u.i("u_radius", radius);
      u.i("u_max", max ? 1 : 0);
      u.f("u_mask", mask[0], mask[1], mask[2], mask[3]);
      u.i("u_keepEdges", keepEdges ? 1 : 0);
    });
  }
  return image;
}

/**
 * Minimax: each pixel replaced by the minimum or maximum of its neighbours within Radius (a fractional radius covers
 * the next whole pixel), in the order Operation gives, on unpremultiplied colour. Don't Shrink Edges keeps the edge
 * pixels' own values in the window.
 */
FxImage minimax(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double operation = p.num(1, 2);
  const int32_t radius = int32_t(std::min(256.0, std::ceil(p.num(2, 0) - 1e-6)));
  if (radius < 1) return input;
  const int32_t channel = int32_t(p.num(3, 1));
  const std::array<float, 4>& mask = kMinimaxChannels[channel >= 1 && channel <= 6 ? channel : 1];
  const int32_t direction = int32_t(p.num(4, 1));
  const bool keepEdges = p.num(5, 0) != 0;
  std::vector<bool> order;
  if (operation == 1) order = {false};
  else if (operation == 2) order = {true};
  else if (operation == 3) order = {false, true};
  else order = {true, false};
  FxImage image = mapPass(ctx, input, fx::minimax_unpremultiply);
  /** A maximum spreads colour (and alpha, when filtered) past the layer edge, where a following minimum still sees it. */
  if (std::find(order.begin(), order.end(), true) != order.end()) image = grown(ctx, image, radius);
  for (bool max : order) image = minimaxFilter(ctx, image, max, radius, direction, mask, keepEdges);
  return mapPass(ctx, image, fx::minimax_premultiply);
}

}  // namespace

FxRenderer vignetteRenderer() { return vignette; }
FxRenderer minimaxRenderer() { return minimax; }

}  // namespace aevk
