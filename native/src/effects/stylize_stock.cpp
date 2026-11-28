/**
 * Stock Perspective, Stylize and Noise effects of src/render/effects/stylize.ts: Drop Shadow, Glow, Mosaic and Noise.
 * Shadow softness and glow radius map to Gaussians as Gaussian Blur's Blurriness does.
 */
#include <algorithm>
#include <array>
#include <cmath>

#include "effects.h"
#include "gaussian.h"
#include "stock.h"

namespace aevk {
namespace {

/**
 * Drop Shadow: the layer's alpha in Shadow Color at Opacity (stored 0..255), moved Distance along Direction and
 * softened, behind the layer (or alone, with Shadow Only).
 */
FxImage dropShadow(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const std::array<float, 3> color = p.rgb(1, {0, 0, 0});
  const double opacity = std::clamp(p.num(2, 127.5) / 255, 0.0, 1.0);
  const std::array<double, 2> u = directionVector(p.num(3, 135));
  const double distance = std::max(0.0, p.num(4, 5)) * k;
  const double sigma = blurrinessSigma(p.num(5, 0)) * k;
  const bool shadowOnly = p.flag(6, false);
  const double dx = u[0] * distance, dy = u[1] * distance;
  const FxRect source = imageRect(input);
  FxRect moved = source;
  moved.x += std::floor(dx);
  moved.y += std::floor(dy);
  moved = growRect(moved, 1, 1);
  FxImage shadow = layerPass(ctx, moved, {input}, fx::drop_shadow, [&](FxUniforms& s) {
    s.f("u_offset", float(dx), float(dy));
    s.f("u_color", color[0], color[1], color[2]);
    s.f("u_opacity", float(opacity));
  });
  shadow = gaussian(ctx, shadow, sigma, sigma);
  const FxRect rect = shadowOnly ? imageRect(shadow) : unionRect(imageRect(shadow), source);
  FxImage out = layerPass(ctx, rect, {input, shadow}, fx::drop_shadow_composite, [&](FxUniforms& s) { s.i("u_only", shadowOnly ? 1 : 0); },
                          input.scale);
  ctx.release(shadow.target);
  ctx.release(input.target);
  return out;
}

/** Glow's Composite Original popup. */
enum GlowComposite : int32_t { kGlowOnTop = 1, kGlowBehind = 2, kGlowNone = 3 };

/** Whether Glow Operation `op` is one this look-alike blends with (None, Normal, Add, Multiply, Screen, Darken, Lighten, Difference). */
bool glowOperationSupported(int32_t op) {
  switch (op) {
    case 1: case 2: case 3: case 4: case 6: case 10: case 11: case 12: return true;
    default: return false;
  }
}

/**
 * Glow: the parts of the layer above Glow Threshold (in its brightest colour channel, or its alpha), blurred by Glow
 * Radius, times Glow Intensity, in their own colours or ramped from Color B to Color A, then blended with the layer
 * by Glow Operation (Behind), placed under it (On Top) or alone (None).
 */
FxImage glow(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const bool basedOnAlpha = p.num(1, 2) == 1;
  const double threshold = std::clamp(p.num(2, 153) / 255, 0.0, 1.0);
  const double sigma = blurrinessSigma(p.num(3, 10)) * k;
  const double intensity = std::max(0.0, p.num(4, 1));
  const int32_t composite = int32_t(p.num(5, kGlowBehind));
  int32_t operation = int32_t(p.num(6, 3));
  if (!glowOperationSupported(operation) || double(operation) != p.num(6, 3)) {
    ctx.warn("Glow: this Glow Operation is drawn as Add");
    operation = 3;
  }
  const double colors = p.num(7, 1);
  if (colors == 3) ctx.warn("Glow: Arbitrary Map colours are drawn as A & B Colors");
  const double dimensions = p.num(14, 1);
  const std::array<float, 3> colorA = p.rgb(12, {1, 1, 1});
  const std::array<float, 3> colorB = p.rgb(13, {0, 0, 0});
  FxImage bright = layerPass(ctx, imageRect(input), {input}, fx::stock_glow_bright, [&](FxUniforms& s) {
    s.f("u_threshold", float(threshold));
    s.i("u_alpha", basedOnAlpha ? 1 : 0);
  });
  FxImage glowImage = gaussian(ctx, bright, blurHorizontal(dimensions) ? sigma : 0, blurVertical(dimensions) ? sigma : 0);
  const FxRect rect = composite == kGlowNone ? imageRect(glowImage) : unionRect(imageRect(glowImage), imageRect(input));
  FxImage out = layerPass(ctx, rect, {input, glowImage}, fx::stock_glow_composite, [&](FxUniforms& s) {
    s.f("u_intensity", float(intensity));
    s.i("u_composite", composite);
    s.i("u_operation", operation);
    s.i("u_ab", colors != 1 ? 1 : 0);
    s.f("u_colorA", colorA[0], colorA[1], colorA[2]);
    s.f("u_colorB", colorB[0], colorB[1], colorB[2]);
  }, input.scale);
  ctx.release(glowImage.target);
  ctx.release(input.target);
  return out;
}

/** Samples per axis a Mosaic block averages at most (MOSAIC_SAMPLES). */
constexpr int32_t kMosaicSamples = 16;

/**
 * Mosaic: the layer's box split into Horizontal x Vertical Blocks, each filled with its average colour (or, with
 * Sharp Colors, the colour at its centre).
 */
FxImage mosaic(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const FxRect rect = layerRect(layer, input);
  const double bx = std::max(1.0, std::round(p.num(1, 10))), by = std::max(1.0, std::round(p.num(2, 10)));
  const double sx = rect.width / bx, sy = rect.height / by;
  const auto samples = [](double size) { return std::min(kMosaicSamples, std::max(1, int32_t(std::ceil(size)))); };
  const bool sharp = p.flag(3, false);
  FxImage out = layerPass(ctx, imageRect(input), {input}, fx::mosaic, [&](FxUniforms& s) {
    s.f("u_rect", float(rect.x), float(rect.y), float(rect.width), float(rect.height));
    s.f("u_block", float(sx), float(sy));
    s.i("u_samples", samples(sx), samples(sy));
    s.i("u_sharp", sharp ? 1 : 0);
  }, input.scale);
  ctx.release(input.target);
  return out;
}

/**
 * Noise: every pixel's straight colour moved by up to half Amount of Noise, the same in all channels unless Use Color
 * Noise; values past the range clip, or wrap around when Clipping is off. New noise every frame.
 */
FxImage noise(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double amount = std::clamp(p.num(1, 0) / 100, 0.0, 1.0);
  if (amount == 0) return input;
  /** JavaScript's % keeps the dividend's sign, as std::fmod does. */
  const double seed = std::fmod(std::round(layer.time * 1000), 9973.0) / 7.0;
  const bool color = p.flag(2, true), clip = p.flag(3, true);
  FxImage out = layerPass(ctx, imageRect(input), {input}, fx::noise, [&](FxUniforms& s) {
    s.f("u_amount", float(amount));
    s.f("u_seed", float(seed));
    s.i("u_color", color ? 1 : 0);
    s.i("u_clip", clip ? 1 : 0);
  }, input.scale);
  ctx.release(input.target);
  return out;
}

}  // namespace

FxRenderer dropShadowRenderer() { return dropShadow; }
FxRenderer glowRenderer() { return glow; }
FxRenderer mosaicRenderer() { return mosaic; }
FxRenderer noiseRenderer() { return noise; }

}  // namespace aevk
