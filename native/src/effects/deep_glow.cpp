/**
 * Deep Glow 2 (PEDG2, Plugin Everything), ported from src/render/effects/deepGlow.ts with the same shaders: a sum of
 * Gaussian octaves of the source's linear light, each blurred on the 2x pyramid level where its sigma spans 3-6
 * texels, screened (or added) over the source in gamma space.
 */
#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

#include "effects.h"

namespace aevk {
namespace {

/** Fitted kernel and transfer constants (DEEP_GLOW). */
constexpr double kSigmaDivisor = 8.118;
constexpr double kSigmaFloor = 2.147;
constexpr double kMinSigma = 0.858;
constexpr double kOctaveWeight = 1.132;
constexpr float kGammaIn = 2.2f;
constexpr float kGammaOut = 2.2f;

/** Parameter indices (P in deepGlow.ts). */
enum Param : uint32_t {
  kGlowMode = 103,
  kBlendMode = 24,
  kRadius = 17,
  kExposure = 18,
  kThresholdMode = 95,
  kThreshold = 20,
  kThresholdSmooth = 21,
  kSaturationBias = 96,
  kAspectRatio = 31,
  kEnableAngle = 32,
  kAspectAngle = 33,
  kPixelAberration = 36,
  kAberrationChannels = 37,
  kPixelOffset = 38,
  kGlowAberration = 1036,
  kMultiplyRed = 97,
  kMultiplyGreen = 98,
  kMultiplyBlue = 99,
  kTintMode = 43,
  kTintBlend = 67,
  kTintColor = 42,
  kTintStrength = 44,
  kGlowIterations = 51,
  kView = 53,
};

enum Blend { kScreen = 1 };
enum Tint { kTintOff = 1, kTintDuo = 4 };
enum View { kFinal = 1, kGlowInput = 2 };

struct Octave {
  /** Gaussian sigma along the glow's major (u) and minor (v) axes, in layer pixels. */
  double su, sv, weight;
};

struct Plane {
  Target* target;
  uint32_t width, height;
};

/** The glow's Gaussian octaves for a radius (glowOctaves); `aspect` stretches u against v. */
std::vector<Octave> glowOctaves(double radius, double iterations, double aspect) {
  std::vector<Octave> out;
  if (radius <= 0) return out;
  const double count = std::min(iterations, std::log2(radius / kSigmaDivisor / kMinSigma) + 1);
  for (int i = 0; i < std::ceil(count); i++) {
    const double s = radius * std::pow(2.0, -i) / kSigmaDivisor;
    const double weight = kOctaveWeight * std::min(1.0, count - i);
    if (weight <= 0) continue;
    out.push_back({std::hypot(s * aspect, kSigmaFloor), std::hypot(s, kSigmaFloor), weight});
  }
  return out;
}

/** The pyramid level whose texel spacing keeps the octave's smaller sigma at 3 texels or more. */
int levelFor(const Octave& octave) { return std::max(0, int(std::floor(std::log2(std::min(octave.su, octave.sv) / 3)))); }

/** Blur of pyramid level `plane` (scale 2^level) by an octave rotated by `angle` (radians, layer space). */
Plane blurOctave(FxContext& ctx, const Plane& plane, int level, const Octave& octave, double angle) {
  const double scale = std::pow(2.0, level);
  /** The box reduction and bilinear upsampling already spread a level by about half a texel. */
  const auto sigma = [&](double s) { return std::sqrt(std::max(0.01, (s / scale) * (s / scale) - 0.25)); };
  /** Layer space has y down, the planes have GL rows (y up). */
  const float u[2] = {float(std::cos(angle)), float(-std::sin(angle))};
  const float v[2] = {float(std::sin(angle)), float(std::cos(angle))};
  const struct {
    const float* dir;
    double s;
  } passes[2] = {{u, sigma(octave.su)}, {v, sigma(octave.sv)}};
  Target* current = plane.target;
  for (const auto& pass : passes) {
    Target* out = ctx.acquire(plane.width, plane.height, FxFormat::Half);
    ctx.pass(fx::glow_blur, *out, {current}, [&](FxUniforms& un) {
      un.i("u_src", 0);
      un.f("u_size", float(plane.width), float(plane.height));
      un.f("u_dir", pass.dir[0], pass.dir[1]);
      un.f("u_sigma", float(pass.s));
      un.i("u_reach", int32_t(std::min(96.0, std::ceil(3 * pass.s))));
    });
    if (current != plane.target) ctx.release(current);
    current = out;
  }
  return {current, plane.width, plane.height};
}

/** Pixel Aberration: each channel's glow offset, the same for every octave (texels, GL rows). */
using Shifts = std::array<std::array<float, 2>, 3>;

/** Accumulated linear glow over `input` (a glow-input plane), per octave list; releases nothing. */
Target* glowPlane(FxContext& ctx, const Plane& input, const std::vector<Octave>& octaves, double angle, const Shifts& shifts) {
  std::vector<Plane> pyramid{input};
  int need = 0;
  for (const Octave& o : octaves) need = std::max(need, levelFor(o));
  for (int l = 1; l <= need; l++) {
    const Plane prev = pyramid[size_t(l - 1)];
    const uint32_t width = (prev.width + 1) / 2;
    const uint32_t height = (prev.height + 1) / 2;
    Target* target = ctx.acquire(width, height, FxFormat::Half);
    ctx.pass(fx::glow_down, *target, {prev.target}, [&](FxUniforms& u) {
      u.i("u_src", 0);
      u.i("u_srcSize", int32_t(prev.width), int32_t(prev.height));
    });
    pyramid.push_back({target, width, height});
  }
  Target* acc = ctx.acquire(input.width, input.height, FxFormat::Float);
  bool first = true;
  for (const Octave& octave : octaves) {
    const int level = levelFor(octave);
    const Plane blurred = blurOctave(ctx, pyramid[size_t(level)], level, octave, angle);
    Target* next = ctx.acquire(input.width, input.height, FxFormat::Float);
    ctx.pass(fx::glow_accumulate, *next, {acc, blurred.target}, [&](FxUniforms& u) {
      u.i("u_acc", 0);
      u.i("u_level", 1);
      u.f("u_levelSize", float(blurred.width), float(blurred.height));
      u.f("u_scale", float(std::pow(2.0, level)));
      u.f("u_weight", float(octave.weight));
      u.i("u_first", first ? 1 : 0);
      u.f("u_shiftR", shifts[0][0], shifts[0][1]);
      u.f("u_shiftG", shifts[1][0], shifts[1][1]);
      u.f("u_shiftB", shifts[2][0], shifts[2][1]);
    });
    ctx.release(acc);
    ctx.release(blurred.target);
    acc = next;
    first = false;
  }
  for (size_t l = 1; l < pyramid.size(); l++) ctx.release(pyramid[l].target);
  return acc;
}

FxImage deepGlow(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const auto num = [&](uint32_t index, double fallback) { return fxNumber(effect, index, fallback); };
  if (num(kGlowMode, 1) != 1) ctx.warn("Deep Glow 2 \"Lens Iris\" mode is drawn as Exponential");
  const double radius = std::max(0.0, num(kRadius, 150));
  const double exposure = std::max(0.0, num(kExposure, 1));
  const double aspect = std::max(0.01, num(kAspectRatio, 1));
  const double angle = num(kEnableAngle, 0) != 0 ? num(kAspectAngle, 0) * M_PI / 180 : 0;
  double iterations = std::floor(num(kGlowIterations, 8) + 0.5);
  if (iterations == 0 || std::isnan(iterations)) iterations = 8;
  const double view = num(kView, kFinal);
  const bool glowView = view == kGlowInput;
  /** At a reduced resolution the octaves keep their count and weights, and only their widths shrink. */
  const double k = input.scale;
  double multipliers[3] = {1, 1, 1};
  if (num(kGlowAberration, 0) != 0) {
    const uint32_t params[3] = {kMultiplyRed, kMultiplyGreen, kMultiplyBlue};
    for (int c = 0; c < 3; c++) multipliers[c] = std::max(0.0, num(params[c], 100)) / 100;
  }
  std::vector<Octave> octaves[3];
  double widest = 0;
  for (int c = 0; c < 3; c++) {
    octaves[c] = glowOctaves(radius * multipliers[c], iterations, aspect);
    for (Octave& o : octaves[c]) {
      if (k != 1) {
        o.su *= k;
        o.sv *= k;
      }
      widest = std::max({widest, o.su, o.sv});
    }
  }
  const int32_t reach = glowView ? 0 : int32_t(std::ceil(3 * widest)) + 1;

  Shifts shifts{};
  if (num(kPixelAberration, 0) != 0 && !glowView) {
    const float offset = float(num(kPixelOffset, 0) * k);
    const double channels = num(kAberrationChannels, 2);
    const int pairs[4][2] = {{0, 2}, {0, 1}, {0, 2}, {1, 2}};
    const int which = channels == 1 || channels == 2 || channels == 3 ? int(channels) : 0;
    /** Texels in GL rows: a positive offset moves the first channel's glow up-left on screen. */
    shifts[size_t(pairs[which][0])] = {offset, -offset};
    shifts[size_t(pairs[which][1])] = {-offset, offset};
  }
  float largest = 0;
  for (const auto& s : shifts) largest = std::max({largest, std::fabs(s[0]), std::fabs(s[1])});
  const int32_t grow = reach + int32_t(std::ceil(largest));
  const uint32_t width = input.width + 2 * uint32_t(grow);
  const uint32_t height = input.height + 2 * uint32_t(grow);

  const Plane glowInput{ctx.acquire(width, height, FxFormat::Half), width, height};
  ctx.pass(fx::glow_input, *glowInput.target, {input.target}, [&](FxUniforms& u) {
    u.i("u_source", 0);
    u.i("u_offset", -grow, -grow);
    u.i("u_size", int32_t(input.width), int32_t(input.height));
    u.i("u_pad", ctx.pad);
    u.f("u_gamma", kGammaIn);
    u.i("u_thresholdMode", glInt(num(kThresholdMode, 1)));
    u.f("u_threshold", float(std::max(0.0, num(kThreshold, 0)) / 100));
    u.f("u_smooth", float(std::max(0.0, num(kThresholdSmooth, 0)) / 100));
    u.f("u_satBias", float(num(kSaturationBias, 0) / 100));
  });

  Target* glows[3] = {};
  for (int c = 0; c < 3; c++) {
    if (glowView) {
      glows[c] = glowInput.target;
      continue;
    }
    int same = -1;
    for (int i = 0; i < c && same < 0; i++)
      if (multipliers[i] == multipliers[c]) same = i;
    glows[c] = same >= 0 ? glows[same] : glowPlane(ctx, glowInput, octaves[c], angle, shifts);
  }
  float gain[3] = {1, 1, 1};
  if (!glowView) gain[0] = gain[1] = gain[2] = float(exposure);
  const double tintMode = num(kTintMode, kTintOff);
  if (!glowView && tintMode != kTintOff) {
    /** Monocolor Multiply measured on deepglow_tint_mono: the linear glow times the tint colour, per channel. */
    const std::vector<double> color = fxVector(effect, kTintColor, {1, 1, 1, 1});
    const double strength = std::max(0.0, num(kTintStrength, 100)) / 100;
    for (size_t c = 0; c < 3; c++) gain[c] = float(gain[c] * (1 - strength + strength * (c < color.size() ? color[c] : 1)));
    if (tintMode == kTintDuo) ctx.warn("Deep Glow 2 Duocolor tint is drawn with the inner colour only");
    if (num(kTintBlend, 1) != 1) ctx.warn("Deep Glow 2 tint blend modes other than Multiply are drawn as Multiply");
  }
  Target* out = ctx.acquire(width + 2 * ctx.pad, height + 2 * ctx.pad);
  ctx.pass(fx::glow_composite, *out, {input.target, glows[0], glows[1], glows[2]}, [&](FxUniforms& u) {
    u.i("u_source", 0);
    u.i("u_glowR", 1);
    u.i("u_glowG", 2);
    u.i("u_glowB", 3);
    u.i("u_offset", -grow, -grow);
    u.i("u_size", int32_t(input.width), int32_t(input.height));
    u.i("u_outSize", int32_t(width), int32_t(height));
    u.i("u_pad", ctx.pad);
    u.f("u_gain", gain[0], gain[1], gain[2]);
    u.f("u_gamma", kGammaOut);
    u.i("u_blend", glInt(num(kBlendMode, kScreen)));
    u.i("u_view", glInt(view));
  });
  for (int c = 0; c < 3; c++) {
    bool seen = glows[c] == glowInput.target;
    for (int i = 0; i < c; i++) seen = seen || glows[i] == glows[c];
    if (!seen) ctx.release(glows[c]);
  }
  ctx.release(glowInput.target);
  ctx.release(input.target);
  FxImage result;
  result.target = out;
  result.width = width;
  result.height = height;
  result.originX = input.originX - float(grow);
  result.originY = input.originY - float(grow);
  return result;
}

}  // namespace

FxRenderer deepGlowRenderer() { return deepGlow; }

}  // namespace aevk
