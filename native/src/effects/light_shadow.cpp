/**
 * Radial Shadow and CC Spotlight, ported from src/render/effects/perspectiveTime.ts with the same shaders.
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

/** Radial Shadow's Softness per standard deviation of its blur (RADIAL_SOFTNESS). */
constexpr double kRadialSoftness = 2.4;

/** Radial Shadow's Render choice that tints the shadow with the layer. */
constexpr int32_t kRenderGlassEdge = 2;

/**
 * Radial Shadow: the layer's alpha cast from Light Source onto a plane behind it, scaled about the light by
 * 1 / (1 - Projection Distance / 100), in Shadow Color at Opacity, softened by Softness, under the layer (or alone).
 * Glass Edge tints the shadow with the layer's colour by Color Influence. Resize Layer lets the shadow grow the layer.
 */
FxImage radialShadow(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double scale = input.scale;
  const std::array<float, 3> color = p.rgb(1, {0, 0, 0});
  const double opacity = std::min(1.0, std::max(0.0, p.num(2, 0.5)));
  const std::vector<double> v = p.vec(3, layerMiddle(layer));
  const std::array<double, 2> light = {(v[0] + 0.5) * scale, ((v.size() > 1 ? v[1] : 0) + 0.5) * scale};
  const double distance = std::min(99.0, std::max(0.0, p.num(4, 10)));
  const double softness = std::max(0.0, p.num(5, 0)) * scale;
  const bool glass = p.choice(6, 1) == kRenderGlassEdge;
  const double influence = std::max(0.0, p.num(7, 1));
  const bool shadowOnly = p.flag(8, false);
  const bool resize = p.flag(9, true);
  const double k = 1 / (1 - distance / 100);
  const FxRect rect = imageRect(input);
  const FxRect cast = {light[0] + (rect.x - light[0]) * k, light[1] + (rect.y - light[1]) * k, rect.width * k, rect.height * k};
  const FxRect shadowRect = resize ? clampRect(unionRect(rect, cast)) : rect;
  FxImage shadow = layerPass(ctx, shadowRect, {input}, fx::radial_shadow, [&](FxUniforms& u) {
    u.f("u_light", float(light[0]), float(light[1]));
    u.f("u_k", float(k));
    u.f("u_color", color[0], color[1], color[2]);
    u.f("u_opacity", float(opacity));
    u.i("u_glass", glass ? 1 : 0);
    u.f("u_influence", float(influence));
  });
  if (softness > 0) shadow = gaussian(ctx, shadow, softness / kRadialSoftness, softness / kRadialSoftness);
  const FxRect outRect = resize ? unionRect(rect, imageRect(shadow)) : rect;
  FxImage out = layerPass(ctx, outRect, {input, shadow}, fx::shadow_under, [&](FxUniforms& u) { u.i("u_only", shadowOnly ? 1 : 0); });
  ctx.release(shadow.target);
  ctx.release(input.target);
  return out;
}

/** CC Spotlight's Render choices, Gel modes folded onto their light modes. */
constexpr int32_t kSpotlightModes[] = {1, 2, 3, 4, 1, 2, 3, 4};

/**
 * CC Spotlight: a spot at Height (percent of the layer's height) above From, aimed at To on the layer, lighting each
 * point by the cosine of its incidence times Intensity inside a cone of half-angle Cone Angle whose edge softens, in
 * cosine, over Edge Softness of the way to the axis. Light Only is the light itself, Light Add adds it to the layer,
 * Light Shadow darkens the layer outside the cone by Intensity. The Gel modes render as their light modes.
 */
FxImage spotlight(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double scale = input.scale;
  std::vector<double> from = p.vec(1, {layer.width / 4.0, layer.height / 4.0});
  std::vector<double> to = p.vec(2, layerMiddle(layer));
  from.resize(2, 0);
  to.resize(2, 0);
  const double height = p.num(3, 50) / 100 * layer.height;
  const double cone = std::min(180.0, std::max(0.0, p.num(4, 25))) * kPi / 180;
  const double softness = std::min(1.0, std::max(0.0, p.num(5, 0.3)));
  const std::array<float, 3> color = p.rgb(6, {1, 1, 1});
  const double intensity = std::max(0.0, p.num(7, 100)) / 100;
  const int32_t choice = p.choice(8, 1);
  const int32_t mode = choice >= 1 && choice <= 8 ? kSpotlightModes[choice - 1] : 1;
  FxImage out = layerPass(ctx, imageRect(input), {input}, fx::cc_spotlight, [&](FxUniforms& u) {
    u.f("u_from", float(from[0]), float(from[1]));
    u.f("u_to", float(to[0]), float(to[1]));
    u.f("u_height", float(height));
    u.f("u_cosCone", float(std::cos(cone)));
    u.f("u_soft", float(softness));
    u.f("u_color", color[0], color[1], color[2]);
    u.f("u_intensity", float(intensity));
    u.f("u_scale", float(scale));
    u.i("u_mode", mode);
  });
  ctx.release(input.target);
  return out;
}

}  // namespace

FxRenderer radialShadowRenderer() { return radialShadow; }
FxRenderer spotlightRenderer() { return spotlight; }

}  // namespace aevk
