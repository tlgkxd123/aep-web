/**
 * Blur & Sharpen and Noise & Grain effects of src/render/effects/blurNoise.ts: Camera Lens Blur, Median, Dust &
 * Scratches, Bilateral Blur, Smart Blur, CC Radial Fast Blur, CC Radial Blur, Noise HLS and Noise HLS Auto, on
 * premultiplied pixels, sharing the TypeScript shaders.
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

/** The largest window radius (image pixels) the edge-preserving blurs sample in full (MAX_WINDOW). */
constexpr int32_t kMaxWindow = 64;

/** A point parameter in image pixels, defaulting to the layer's centre. */
std::array<double, 2> centerPoint(const FxParams& p, uint32_t index, const EffectLayer& layer, const FxImage& input) {
  const std::array<double, 2> c = layerCenter(layer, input);
  const std::vector<double> v = p.vec(index, {c[0], c[1]});
  return {v[0] * input.scale, (v.size() > 1 ? v[1] : 0) * input.scale};
}

/** A one-pass effect over the input's own area; releases `input`. */
FxImage samePass(FxContext& ctx, FxImage input, fx::Id shader, const FxSetter& set) {
  FxImage out = layerPass(ctx, imageRect(input), {input}, shader, set, input.scale);
  ctx.release(input.target);
  return out;
}

/**
 * Camera Lens Blur: each pixel averages the layer over the iris, a regular polygon of Shape's sides (Triangle to
 * Decagon) with a corner pointing down and Blur Radius to its corners, rounded toward a circle by Roundness, turned by
 * Rotation and widened by Aspect Ratio along x. Highlights brighter than Threshold are boosted by Gain; the blur map,
 * Diffraction Fringe and Saturation are not drawn. Repeat Edge Pixels clamps the samples to the layer.
 */
FxImage cameraLensBlur(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const double radius = std::max(0.0, p.num(1, 5)) * k;
  if (radius < 0.5) return input;
  if (std::round(p.num(10, 0)) > 0) ctx.warn("Camera Lens Blur: the blur map is not drawn");
  const bool repeat = p.flag(21, false);
  const FxRect box = layerRect(layer, input);
  const double aspect = std::max(0.01, p.num(5, 1));
  const int32_t window = std::min(kMaxWindow, int32_t(std::ceil(radius * std::max(1.0, aspect))) + 1);
  const FxRect rect = repeat ? box
                             : FxRect{input.originX - double(window), input.originY - double(window), double(input.width) + 2.0 * window,
                                      double(input.height) + 2.0 * window};
  /** Shape's popup: Triangle (3 sides) to Decagon (10). */
  const double sides = std::clamp(p.choice(3, 4) + 2, 3, 10);
  FxImage out = layerPass(ctx, rect, {input}, fx::camera_lens, [&](FxUniforms& u) {
    u.i("u_window", window);
    u.f("u_radius", float(radius));
    u.f("u_sides", float(sides));
    u.f("u_round", float(std::clamp(p.num(4, 0) / 100, 0.0, 1.0)));
    u.f("u_aspect", float(aspect));
    u.f("u_rotation", float(p.num(6, 0) * kPi / 180));
    u.i("u_linear", p.flag(22, false) ? 1 : 0);
    u.f("u_gain", float(std::max(0.0, p.num(17, 0)) / 100));
    u.f("u_threshold", float(std::clamp(p.num(18, 1), 0.0, 1.0)));
    u.i("u_repeat", repeat ? 1 : 0);
    if (repeat) u.f("u_rect", float(box.x), float(box.y), float(box.width), float(box.height));
  }, input.scale);
  ctx.release(input.target);
  return out;
}

/**
 * Each channel's median over the (2r+1)^2 square about each pixel, by a binary search of its 8 bits (median in
 * blurNoise.ts); alpha's only with `alpha`. With `threshold` (levels) a pixel keeps its value where it is within it of
 * the median. Releases `input`.
 */
FxImage median(FxContext& ctx, FxImage input, int32_t radius, bool alpha, double threshold = -1) {
  const auto common = [&](FxUniforms& u) {
    u.i("u_source", 0);
    u.i("u_state", 1);
    u.i("u_size", int32_t(input.width), int32_t(input.height));
    u.i("u_pad", ctx.pad);
    u.i("u_straight", 1);
  };
  Target* state = nullptr;
  for (int32_t bit = 128; bit >= 1; bit /= 2) {
    Target* next = ctx.acquire(input.width, input.height, FxFormat::Float);
    ctx.pass(fx::median_step, *next, {input.target, state ? state : input.target}, [&](FxUniforms& u) {
      common(u);
      u.i("u_radius", radius);
      u.f("u_bit", float(bit));
      u.i("u_first", state ? 0 : 1);
    });
    ctx.release(state);
    state = next;
  }
  FxImage out = input;
  out.target = ctx.acquire(ctx.width(input.target), ctx.height(input.target), FxFormat::Color, false);
  ctx.pass(fx::median_store, *out.target, {input.target, state}, [&](FxUniforms& u) {
    common(u);
    u.i("u_alpha", alpha ? 1 : 0);
    u.f("u_threshold", float(threshold));
  });
  ctx.release(state);
  ctx.release(input.target);
  return out;
}

/** Median: each channel's median within Radius, alpha's with Operate on Alpha Channel. */
FxImage medianEffect(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const int32_t radius = int32_t(std::round(std::max(0.0, p.num(1, 0)) * input.scale));
  return radius > 0 ? median(ctx, input, radius, p.flag(2, false)) : input;
}

/** Dust & Scratches: Median, keeping pixels within Threshold levels of it. */
FxImage dustScratches(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const int32_t radius = int32_t(std::round(std::max(0.0, p.num(1, 1)) * input.scale));
  return radius > 0 ? median(ctx, input, radius, p.flag(3, false), std::max(0.0, p.num(2, 0)) * 255) : input;
}

/**
 * Bilateral Blur: each pixel averages its neighbours within Radius in CIE Lab, weighted by a Gaussian of their
 * distance and by one of their Lab difference from it relative to Threshold; without Colorize on L alone.
 */
FxImage bilateral(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double radius = std::max(0.0, p.num(1, 25)) * input.scale;
  if (radius < 0.5) return input;
  const int32_t window = std::min(kMaxWindow, int32_t(std::ceil(radius)));
  return samePass(ctx, input, fx::bilateral, [&](FxUniforms& u) {
    u.i("u_window", window);
    u.f("u_sigma", float(radius / 2));
    u.f("u_threshold", float(std::max(0.0, p.num(2, 3))));
    u.i("u_colorize", p.flag(3, true) ? 1 : 0);
  });
}

/**
 * What Smart Blur's Threshold is multiplied by at a Radius (SMART_THRESHOLD_SCALE in blurNoise.ts), interpolated
 * between the measured radii.
 */
double smartThresholdScale(double radius) {
  static const double kTable[][2] = {{3, 1.02}, {4, 0.975}, {5, 0.925}, {6, 0.875}, {8, 0.825}, {10, 0.765}, {15, 0.575}};
  constexpr size_t n = sizeof kTable / sizeof kTable[0];
  if (radius <= kTable[0][0]) return kTable[0][1];
  for (size_t i = 1; i < n; i++) {
    if (radius <= kTable[i][0]) return kTable[i - 1][1] + (kTable[i][1] - kTable[i - 1][1]) * (radius - kTable[i - 1][0]) / (kTable[i][0] - kTable[i - 1][0]);
  }
  return kTable[n - 1][1];
}

/**
 * Smart Blur: each pixel averages the neighbours within Radius that differ from it by at most Threshold (levels of
 * 255, every channel), scaled down as Radius grows. Edge Only and Edge Overlay draw the edges.
 */
FxImage smartBlur(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const double radius = std::max(0.0, p.num(1, 3)) * k;
  const int32_t window = std::min(kMaxWindow, int32_t(std::round(radius)));
  if (window < 1) return input;
  const FxRect bounds = layerRect(layer, input);
  return samePass(ctx, input, fx::smart_blur, [&](FxUniforms& u) {
    u.i("u_window", window);
    u.f("u_radius", float(radius));
    u.f("u_threshold", float(std::max(0.0, p.num(2, 25)) * smartThresholdScale(radius / k)));
    u.i("u_mode", p.choice(3, 1));
    u.f("u_end", float(bounds.x + bounds.width), float(bounds.y + bounds.height));
  });
}

/** The radial blurs' sample paths and reductions (RadialPath, RadialReduce). */
enum RadialPath : int32_t { kZoom = 0, kSpin = 1 };
enum RadialReduce : int32_t { kMean = 0, kMax = 1, kMin = 2 };

/** The most samples the radial blurs take per pixel (RADIAL_TAPS). */
constexpr int32_t kRadialTaps = 256;

/** The farthest corner of an image from a point (reach). */
double reach(const FxImage& input, const std::array<double, 2>& c) {
  const FxRect r = imageRect(input);
  double best = 0;
  for (const double x : {r.x, r.x + r.width}) {
    for (const double y : {r.y, r.y + r.height}) best = std::max(best, std::hypot(x - c[0], y - c[1]));
  }
  return best;
}

/** Each pixel's samples along the ray from (zoom) or arc about (spin) the centre (radialPass); releases `input`. */
FxImage radialPass(FxContext& ctx, FxImage input, const std::array<double, 2>& center, int32_t path, double from, double to, double taps, double fade,
                   int32_t reduce) {
  return samePass(ctx, input, fx::radial_pass, [&](FxUniforms& u) {
    u.f("u_center", float(center[0]), float(center[1]));
    u.i("u_path", path);
    u.f("u_range", float(from), float(to));
    u.i("u_taps", std::max(1, std::min(kRadialTaps, int32_t(std::round(taps)))));
    u.f("u_fade", float(fade));
    u.i("u_reduce", reduce);
  });
}

/**
 * CC Radial Fast Blur: each pixel averages (or with Brightest / Darkest takes the largest / smallest value of) the
 * layer along its ray toward Center, over Amount % of its distance.
 */
FxImage ccRadialFastBlur(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double amount = std::clamp(p.num(2, 50), 0.0, 100.0) / 100;
  if (amount == 0) return input;
  const std::array<double, 2> center = centerPoint(p, 1, layer, input);
  /** Zoom: Standard, Brightest, Darkest. */
  const int32_t zoom = p.choice(3, 1);
  return radialPass(ctx, input, center, kZoom, 0, -amount, std::ceil(amount * reach(input, center)) + 1, 1,
                    zoom == 2 ? kMax : zoom == 3 ? kMin : kMean);
}

/** CC Radial Blur's Type choices. */
enum RadialType : int32_t { kStraightZoom = 1, kFadingZoom = 2, kCenteredZoom = 3, kRotate = 4, kScratch = 5, kRotateFading = 6 };

/**
 * CC Radial Blur: Straight Zoom averages along the ray toward Center over Amount % of the distance, Fading Zoom
 * weighs the far samples less, Centered Zoom spreads both ways; Rotate turns through Amount degrees, Rotate Fading
 * fading, Scratch as Rotate. Quality sets the samples.
 */
FxImage ccRadialBlur(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double amount = p.num(2, 0);
  if (amount == 0) return input;
  const std::array<double, 2> center = centerPoint(p, 4, layer, input);
  const int32_t type = p.choice(1, kScratch);
  const double quality = std::clamp(p.num(3, 50), 10.0, 100.0) / 100;
  const bool spin = type == kRotate || type == kScratch || type == kRotateFading;
  const double span = spin ? amount * kPi / 180 : -amount / 100;
  const bool centered = type == kCenteredZoom;
  const bool fading = type == kFadingZoom || type == kRotateFading;
  return radialPass(ctx, input, center, spin ? kSpin : kZoom, centered ? -span / 2 : 0, centered ? span / 2 : span,
                    std::max(2.0, std::ceil(std::abs(span) * reach(input, center) * quality) + 1), fading ? 0 : 1, kMean);
}

/** Noise HLS and Noise HLS Auto: Hue, Lightness and Saturation each moved by noise of up to their amount (noiseHls). */
FxImage noiseHls(FxContext& ctx, FxImage input, const FxParams& p, double seed) {
  const double h = std::max(0.0, p.num(2, 0)) / 100, l = std::max(0.0, p.num(3, 0)) / 100, s = std::max(0.0, p.num(4, 0)) / 100;
  if (h == 0 && l == 0 && s == 0) return input;
  /** Noise: Uniform, Squared, Grain. */
  const int32_t type = p.choice(1, 1);
  const double k = input.scale;
  return samePass(ctx, input, fx::noise_hls, [&](FxUniforms& u) {
    u.f("u_amounts", float(h), float(l), float(s));
    u.f("u_seed", float(seed));
    u.f("u_cell", float(type == 3 ? std::max(1.0, p.num(5, 1)) * k : k));
    u.i("u_type", type);
  });
}

/** Noise HLS: Noise Phase (degrees) moves through the noise. */
FxImage noiseHlsEffect(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return noiseHls(ctx, input, p, p.num(6, 0) / 360 * 8);
}

/** Noise HLS Auto: moves through the noise at Noise Animation Speed (phases a second of comp time). */
FxImage noiseHlsAuto(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  return noiseHls(ctx, input, p, layer.time * std::max(0.0, p.num(6, 24)));
}

}  // namespace

FxRenderer cameraLensBlurRenderer() { return cameraLensBlur; }
FxRenderer medianRenderer() { return medianEffect; }
FxRenderer dustScratchesRenderer() { return dustScratches; }
FxRenderer bilateralRenderer() { return bilateral; }
FxRenderer smartBlurRenderer() { return smartBlur; }
FxRenderer ccRadialFastBlurRenderer() { return ccRadialFastBlur; }
FxRenderer ccRadialBlurRenderer() { return ccRadialBlur; }
FxRenderer noiseHlsRenderer() { return noiseHlsEffect; }
FxRenderer noiseHlsAutoRenderer() { return noiseHlsAuto; }

}  // namespace aevk
