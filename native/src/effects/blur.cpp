/**
 * Channel Blur (ADBE Channel Blur) and CC Cross Blur (CS CrossBlur), ported from src/render/effects/blurNoise.ts: box
 * passes with a fractional outer tap standing in for each Blurriness, alpha first and each colour channel from the
 * straight colour premultiplied by the blurred alpha.
 */
#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

#include "box_blur.h"
#include "effects.h"
#include "stock.h"

namespace aevk {
namespace {

/**
 * Channel Blur's blur of one Blurriness b (channelBoxBlur): one box pass of radius b/2 up to 1, two of 0.37b up to 2,
 * three of 0.37b from 2.5, and between 2 and 2.5 the two-pass and three-pass results mixed linearly. `options` gives
 * the axes and edges; releases `source`.
 */
FxImage channelBoxBlur(FxContext& ctx, FxImage source, double blurriness, double scale, BoxBlurOptions options) {
  const double b = std::max(0.0, blurriness);
  if (b <= 1) {
    options.radius = (b / 2) * scale;
    options.iterations = 1;
    return boxBlur(ctx, source, options);
  }
  options.radius = 0.37 * b * scale;
  if (b <= 2 || b >= 2.5) {
    options.iterations = b <= 2 ? 2 : 3;
    return boxBlur(ctx, source, options);
  }
  const float sourceScale = source.scale;
  options.iterations = 2;
  const FxImage two = boxBlur(ctx, source, options);
  options.iterations = 1;
  const FxImage three = boxBlur(ctx, copyImage(ctx, two), options);
  const FxImage out = layerPass(ctx, unionRect(imageRect(two), imageRect(three)), {two, three}, fx::channel_blur_mix,
                                [&](FxUniforms& u) { u.f("u_t", float((b - 2) / 0.5)); }, sourceScale);
  ctx.release(two.target);
  ctx.release(three.target);
  return out;
}

/**
 * Channel Blur: alpha blurred first, then the input's straight colour (transparent pixels black) premultiplied by that
 * blurred alpha and each colour channel blurred from there, each by its channel's Blurriness.
 */
FxImage channelBlur(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  std::array<double, 4> amounts;
  for (uint32_t i = 0; i < 4; i++) amounts[i] = std::max(0.0, p.num(i + 1, 0));
  if (std::all_of(amounts.begin(), amounts.end(), [](double a) { return a <= 0; })) return input;
  const double k = input.scale;
  const int32_t dimensions = p.choice(6, 1);
  BoxBlurOptions options;
  options.horizontal = dimensions != 3;
  options.vertical = dimensions != 2;
  options.repeatEdges = p.flag(5, false);
  if (options.repeatEdges) options.hasBounds = effectBounds(layer, input, options.bounds);
  const FxImage alpha = channelBoxBlur(ctx, copyImage(ctx, input), amounts[3], k, options);
  const FxImage colour = layerPass(ctx, imageRect(input), {input, alpha}, fx::channel_blur_colour, {}, input.scale);
  ctx.release(input.target);
  // Each distinct colour Blurriness blurred once; the compose pass reads each channel from its own.
  std::vector<double> distinct;
  std::vector<FxImage> blurred;
  std::array<size_t, 3> pick{};
  for (size_t c = 0; c < 3; c++) {
    const auto at = std::find(distinct.begin(), distinct.end(), amounts[c]);
    if (at != distinct.end()) {
      pick[c] = size_t(at - distinct.begin());
      continue;
    }
    pick[c] = distinct.size();
    distinct.push_back(amounts[c]);
    blurred.push_back(channelBoxBlur(ctx, copyImage(ctx, colour), amounts[c], k, options));
  }
  ctx.release(colour.target);
  const FxImage out = layerPass(ctx, imageRect(alpha), {blurred[pick[0]], blurred[pick[1]], blurred[pick[2]], alpha}, fx::channel_blur_compose, {},
                                input.scale);
  for (const FxImage& image : blurred) ctx.release(image.target);
  ctx.release(alpha.target);
  return out;
}

enum CrossMode { kCrossBlend = 1 };

/**
 * CC Cross Blur: the layer blurred along x as Channel Blur blurs by Radius X and along y by Radius Y, the two combined
 * by Transfer Mode (CROSS_BLUR_BODY).
 */
FxImage crossBlur(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const double rx = std::max(0.0, p.num(1, 0));
  const double ry = std::max(0.0, p.num(2, 0));
  if (rx <= 0 && ry <= 0) return input;
  BoxBlurOptions options;
  options.repeatEdges = p.flag(4, false);
  if (options.repeatEdges) {
    const FxRect r = layerRect(layer, input);
    options.hasBounds = true;
    options.bounds = {r.x, r.y, r.width, r.height};
  }
  const auto box = [&](double radius, bool horizontal) {
    BoxBlurOptions o = options;
    o.horizontal = horizontal;
    o.vertical = !horizontal;
    return channelBoxBlur(ctx, copyImage(ctx, input), radius, k, o);
  };
  const FxImage x = box(rx, true);
  const FxImage y = box(ry, false);
  ctx.release(input.target);
  const int32_t mode = p.choice(3, kCrossBlend);
  const FxImage out = layerPass(ctx, unionRect(imageRect(x), imageRect(y)), {x, y}, fx::cross_blur, [&](FxUniforms& u) { u.i("u_mode", mode); },
                                input.scale);
  ctx.release(x.target);
  ctx.release(y.target);
  return out;
}

}  // namespace

FxRenderer channelBlurRenderer() { return channelBlur; }
FxRenderer crossBlurRenderer() { return crossBlur; }

}  // namespace aevk
