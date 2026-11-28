/**
 * Colour corrections of src/render/effects/colorCorrection.ts and colorExtra.ts that change each pixel on its own (CS
 * Kernel aside, which reads the pixels around it): Tint, Tritone, Brightness & Contrast, Exposure, Hue/Saturation,
 * Vibrance, Color Balance (HLS), Channel Mixer, Black & White, Levels, Invert, Posterize, Shift Channels, Levels
 * (Individual Controls), CC Toner, CC Color Offset, Gamma/Pedestal/Gain, Color Balance, Color Neutralizer, Photo
 * Filter, Selective Color, Leave Color, Change Color, Change To Color and CC Kernel. The shaders are the TypeScript
 * ones; this file works out their uniforms as the TypeScript does.
 */
#include <algorithm>
#include <array>
#include <cmath>
#include <vector>

#include "effects.h"
#include "stock.h"

namespace aevk {
namespace {

double clamp01(double v) { return std::min(1.0, std::max(0.0, v)); }
double pct(double v) { return v / 100; }
int32_t roundInt(double v) { return int32_t(std::floor(v + 0.5)); }

/** Hue (turns), saturation and lightness of an RGB colour (rgbToHsl in colorExtraMath.ts). */
std::array<double, 3> rgbToHsl(double r, double g, double b) {
  const double mx = std::max({r, g, b}), mn = std::min({r, g, b});
  const double l = (mx + mn) / 2;
  const double d = mx - mn;
  if (d <= 1e-6) return {0, 0, l};
  const double s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const double h = mx == r ? (g - b) / d + (g < b ? 6 : 0) : mx == g ? (b - r) / d + 2 : (r - g) / d + 4;
  return {h / 6, s, l};
}

std::array<double, 3> rgbToHsl(const std::array<float, 3>& c) { return rgbToHsl(c[0], c[1], c[2]); }

void setRgb(FxUniforms& u, const char* name, const std::array<float, 3>& c) { u.f(name, c[0], c[1], c[2]); }

/** A colorPass or straightPass effect: the shader over the input, `set` filling its uniforms from the parameters. */
template <typename Set>
FxImage colorEffect(FxContext& ctx, FxImage input, fx::Id shader, const Set& set) {
  return mapPass(ctx, input, shader, [&](FxUniforms& u) { set(u); });
}

/** Tint: Map Black To and Map White To by luma, mixed in by Amount to Tint. */
FxImage tint(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return colorEffect(ctx, input, fx::tint, [&](FxUniforms& u) {
    setRgb(u, "u_black", p.rgb(1, {0, 0, 0}));
    setRgb(u, "u_white", p.rgb(2, {1, 1, 1}));
    u.f("u_amount", float(clamp01(pct(p.num(3, 100)))));
  });
}

FxImage tritone(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return colorEffect(ctx, input, fx::tritone, [&](FxUniforms& u) {
    setRgb(u, "u_high", p.rgb(1, {1, 1, 1}));
    setRgb(u, "u_mid", p.rgb(2, {0.5f, 0.4f, 0.3f}));
    setRgb(u, "u_shadow", p.rgb(3, {0, 0, 0}));
    u.f("u_blend", float(clamp01(pct(p.num(4, 0)))));
  });
}

/** Contrast in -100..100 as a slope around mid grey (contrastSlope). */
double contrastSlope(double c) { return c >= 0 ? 100 / std::max(1e-3, 100 - std::min(c, 99.9)) : (100 + std::max(c, -100.0)) / 100; }

FxImage brightnessContrast(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const bool legacy = effect.matchName == "ADBE Brightness & Contrast" || p.flag(3, false);
  return colorEffect(ctx, input, fx::brightness_contrast, [&](FxUniforms& u) {
    u.f("u_brightness", float(p.num(1, 0)));
    u.f("u_slope", float(contrastSlope(p.num(2, 0))));
    u.i("u_legacy", legacy ? 1 : 0);
  });
}

/** Exposure: the master values, or each channel's with Individual Channels. */
FxImage exposure(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const bool individual = p.num(1, 1) == 2;
  const auto channel = [&](uint32_t base) { return std::array<double, 3>{p.num(base, 0), p.num(base + 1, 0), p.num(base + 2, 1)}; };
  const std::array<std::array<double, 3>, 3> v =
      individual ? std::array<std::array<double, 3>, 3>{channel(8), channel(13), channel(18)} : std::array<std::array<double, 3>, 3>{channel(3), channel(3), channel(3)};
  return colorEffect(ctx, input, fx::exposure, [&](FxUniforms& u) {
    u.f("u_exposure", float(v[0][0]), float(v[1][0]), float(v[2][0]));
    u.f("u_offset", float(v[0][1]), float(v[1][1]), float(v[2][1]));
    u.f("u_gamma", float(v[0][2]), float(v[1][2]), float(v[2][2]));
    u.i("u_bypass", p.flag(22, false) ? 1 : 0);
  });
}

FxImage hueSaturation(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  if (p.num(2, 1) != 1) ctx.warn("Hue/Saturation: only the Master channel's values are rendered");
  return colorEffect(ctx, input, fx::hue_saturation, [&](FxUniforms& u) {
    u.f("u_hue", float(p.num(4, 0) / 360));
    u.f("u_saturation", float(pct(p.num(5, 0))));
    u.f("u_lightness", float(pct(p.num(6, 0))));
    u.i("u_colorize", p.flag(7, false) ? 1 : 0);
    const double hue = std::fmod(std::fmod(p.num(8, 0) / 360, 1.0) + 1, 1.0);
    u.f("u_colorizeHsl", float(hue), float(pct(p.num(9, 25))), float(pct(p.num(10, 0))));
  });
}

FxImage vibrance(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return colorEffect(ctx, input, fx::vibrance, [&](FxUniforms& u) {
    u.f("u_vibrance", float(std::min(1.0, std::max(-1.0, pct(p.num(1, 0))))));
    u.f("u_saturation", float(std::min(1.0, std::max(-1.0, pct(p.num(2, 0))))));
  });
}

FxImage colorBalanceHls(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return colorEffect(ctx, input, fx::color_balance_hls, [&](FxUniforms& u) {
    u.f("u_hue", float(p.num(1, 0) / 360));
    u.f("u_lightness", float(pct(p.num(2, 0))));
    u.f("u_saturation", float(pct(p.num(3, 0))));
  });
}

/** Channel Mixer: each output channel a percentage mix of red, green and blue plus a constant. */
FxImage channelMixer(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const auto row = [&](uint32_t base, int own) {
    std::array<float, 4> out{};
    for (int k = 0; k < 4; k++) out[size_t(k)] = float(pct(p.num(base + uint32_t(k), k == own ? 100 : 0)));
    return out;
  };
  const std::array<float, 4> r = row(1, 0), g = row(5, 1), b = row(9, 2);
  // Column-major: column j holds the weights of input channel j.
  const float mix[9] = {r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]};
  return colorEffect(ctx, input, fx::channel_mixer, [&](FxUniforms& u) {
    u.matrix("u_mix", mix);
    u.f("u_const", r[3], g[3], b[3]);
    u.i("u_mono", p.flag(13, false) ? 1 : 0);
  });
}

FxImage blackWhite(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double defaults[6] = {40, 60, 40, 60, 20, 80};
  float w[6];
  for (uint32_t i = 0; i < 6; i++) w[i] = float(pct(p.num(i + 1, defaults[i])));
  const std::array<double, 3> hsl = rgbToHsl(p.rgb(8, {0.87f, 0.8f, 0.65f}));
  return colorEffect(ctx, input, fx::black_white, [&](FxUniforms& u) {
    u.fv("u_w", w, 6);
    u.i("u_tint", p.flag(7, false) ? 1 : 0);
    u.f("u_tintHsl", float(hsl[0]), float(hsl[1]), float(hsl[2]));
  });
}

/** Levels values in 8-bit levels when any is above 1, as older projects store them (levelsFractions in stockMath.ts). */
std::array<double, 4> levelsFractions(std::array<double, 4> v) {
  if (std::any_of(v.begin(), v.end(), [](double x) { return x > 1.0001; }))
    for (double& x : v) x /= 255;
  return v;
}

/** Levels: the selected channel's values (the other channels' live in the histogram data, which is not read). */
FxImage easyLevels(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double channel = p.num(1, 1);
  const std::array<double, 4> v = levelsFractions({p.num(3, 0), p.num(4, 1), p.num(6, 0), p.num(7, 1)});
  const std::array<float, 4> mask = channel == 2 ? std::array<float, 4>{1, 0, 0, 0}
                                    : channel == 3 ? std::array<float, 4>{0, 1, 0, 0}
                                    : channel == 4 ? std::array<float, 4>{0, 0, 1, 0}
                                    : channel == 5 ? std::array<float, 4>{0, 0, 0, 1}
                                                   : std::array<float, 4>{1, 1, 1, 0};
  return mapPass(ctx, input, fx::levels, [&](FxUniforms& u) {
    u.f("u_mask", mask[0], mask[1], mask[2], mask[3]);
    u.f("u_inBlack", float(v[0]));
    u.f("u_inWhite", float(v[1]));
    u.f("u_gamma", float(p.num(5, 1)));
    u.f("u_outBlack", float(v[2]));
    u.f("u_outWhite", float(v[3]));
    u.i("u_clipBlack", p.flag(8, true) ? 1 : 0);
    u.i("u_clipWhite", p.flag(9, true) ? 1 : 0);
  });
}

FxImage invert(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const int32_t channel = roundInt(p.num(1, 1));
  const double blend = clamp01(pct(p.num(2, 0)));
  return mapPass(ctx, input, fx::invert, [&](FxUniforms& u) {
    u.i("u_channel", channel);
    u.f("u_blend", float(blend));
  });
}

FxImage posterize(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return colorEffect(ctx, input, fx::posterize, [&](FxUniforms& u) { u.f("u_levels", float(std::max(2, roundInt(p.num(1, 7))))); });
}

FxImage shiftChannels(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return mapPass(ctx, input, fx::shift_channels, [&](FxUniforms& u) {
    u.i("u_from", roundInt(p.num(1, 1)), roundInt(p.num(2, 2)), roundInt(p.num(3, 3)), roundInt(p.num(4, 4)));
  });
}

/** Levels (Individual Controls): the RGB, red, green, blue and alpha groups (proLevelsChannels in colorExtraMath.ts). */
FxImage proLevels(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  static const uint32_t kGroups[5] = {4, 11, 18, 25, 32};
  static const char* const kNames[5] = {"u_rgb", "u_r", "u_g", "u_b", "u_a"};
  float values[5][5];
  for (int i = 0; i < 5; i++) {
    const uint32_t b = kGroups[i];
    const double v[5] = {p.num(b, 0), p.num(b + 1, 1), p.num(b + 2, 1), p.num(b + 3, 0), p.num(b + 4, 1)};
    for (int k = 0; k < 5; k++) values[i][k] = float(v[k]);
  }
  return colorEffect(ctx, input, fx::pro_levels, [&](FxUniforms& u) {
    for (int i = 0; i < 5; i++) u.fv(kNames[i], values[i], 5);
  });
}

/** CC Toner's tones from dark to light for its Tones popup (tonerStops in colorExtraMath.ts). */
FxImage toner(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const std::array<float, 3> hi = p.rgb(1, {1, 1, 1});
  const std::array<float, 3> bright = p.rgb(6, {0.75f, 0.67f, 0.47f});
  const std::array<float, 3> mid = p.rgb(2, {0.5f, 0.39f, 0.27f});
  const std::array<float, 3> dark = p.rgb(7, {0.25f, 0.2f, 0.04f});
  const std::array<float, 3> shadow = p.rgb(3, {0, 0, 0});
  std::vector<std::array<float, 3>> stops;
  switch (p.choice(5, 2)) {
    case 1: stops = {shadow, hi}; break;
    case 3: stops = {shadow, dark, mid, bright, hi}; break;
    case 4: stops = {mid}; break;
    default: stops = {shadow, mid, hi}; break;
  }
  float flat[15] = {};
  for (size_t i = 0; i < stops.size(); i++)
    for (size_t k = 0; k < 3; k++) flat[i * 3 + k] = stops[i][k];
  return colorEffect(ctx, input, fx::toner, [&](FxUniforms& u) {
    u.fv("u_stops", flat, 5, 3);
    u.i("u_count", int32_t(stops.size()));
    u.f("u_blend", float(clamp01(p.num(4, 0))));
  });
}

FxImage colorOffset(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return colorEffect(ctx, input, fx::color_offset, [&](FxUniforms& u) {
    u.f("u_phase", float(p.num(1, 0) / 360), float(p.num(2, 0) / 360), float(p.num(3, 0) / 360));
    u.i("u_overflow", p.choice(4, 2));
  });
}

FxImage gammaPedestalGain(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  double v[3][3];
  const uint32_t bases[3] = {2, 5, 8};
  for (int c = 0; c < 3; c++) {
    const uint32_t n = bases[c];
    v[c][0] = std::max(1e-3, p.num(n, 1));
    v[c][1] = p.num(n + 1, 0);
    v[c][2] = p.num(n + 2, 1);
  }
  return colorEffect(ctx, input, fx::gamma_pedestal_gain, [&](FxUniforms& u) {
    u.f("u_stretch", float(p.num(1, 1)));
    u.f("u_gamma", float(v[0][0]), float(v[1][0]), float(v[2][0]));
    u.f("u_pedestal", float(v[0][1]), float(v[1][1]), float(v[2][1]));
    u.f("u_gain", float(v[0][2]), float(v[1][2]), float(v[2][2]));
  });
}

/**
 * Color Balance's nine balances (shadow, midtone and highlight RGB, -1..1); Preserve Luminosity shifts each range's
 * three (colorBalanceSliders in colorExtraMath.ts).
 */
std::array<double, 9> colorBalanceSliders(const FxParams& p) {
  std::array<double, 9> v{};
  for (uint32_t i = 0; i < 9; i++) v[i] = p.num(i + 1, 0) / 100;
  if (!p.flag(10, false)) return v;
  std::array<double, 9> out{};
  for (size_t i = 0; i < 9; i++) {
    const size_t start = i - i % 3;
    const double hi = std::max({v[start], v[start + 1], v[start + 2]});
    const double lo = std::min({v[start], v[start + 1], v[start + 2]});
    out[i] = v[i] - (i < 3 ? hi : i < 6 ? (hi + lo) / 2 : lo);
  }
  return out;
}

FxImage colorBalance(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const std::array<double, 9> v = colorBalanceSliders(p);
  return colorEffect(ctx, input, fx::color_balance, [&](FxUniforms& u) {
    u.f("u_shadow", float(v[0]), float(v[1]), float(v[2]));
    u.f("u_mid", float(v[3]), float(v[4]), float(v[5]));
    u.f("u_high", float(v[6]), float(v[7]), float(v[8]));
    u.i("u_preserve", p.flag(10, false) ? 1 : 0);
  });
}

/** Color Neutralizer's offsets per range, zero-sum within a range and scaled down by Blend w. Original (neutralizerOffsets). */
FxImage neutralizer(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double keep = 1 - clamp01(p.num(20, 0) / 100);
  float offsets[9];
  const uint32_t bases[3] = {3, 9, 15};
  for (int r = 0; r < 3; r++) {
    double v[3];
    for (uint32_t k = 0; k < 3; k++) v[k] = p.num(bases[r] + k, 0) / 200;
    const double mean = (v[0] + v[1] + v[2]) / 3;
    for (int k = 0; k < 3; k++) offsets[r * 3 + k] = float((v[k] - mean) * keep);
  }
  return colorEffect(ctx, input, fx::neutralizer, [&](FxUniforms& u) {
    u.fv("u_offsets", offsets, 3, 3);
    u.f("u_points", float(p.num(23, 0) / 100), float(p.num(24, 100) / 100));
  });
}

/** sRGB (linear) to XYZ adapted to D50, rows X, Y, Z. */
constexpr double kSrgbD50[3][3] = {{0.4361, 0.3851, 0.1431}, {0.2225, 0.7169, 0.0606}, {0.0139, 0.0971, 0.7141}};

std::array<std::array<double, 3>, 3> invert3(const double m[3][3]) {
  const double a = m[0][0], b = m[0][1], c = m[0][2], d = m[1][0], e = m[1][1], f = m[1][2], g = m[2][0], h = m[2][1], i = m[2][2];
  const double A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const double det = a * A + b * B + c * C;
  return {{{A / det, (c * h - b * i) / det, (b * f - c * e) / det},
           {B / det, (a * i - c * g) / det, (c * d - a * f) / det},
           {C / det, (b * g - a * h) / det, (a * e - b * d) / det}}};
}

double srgbToLinear(double v) { return v <= 0.04045 ? v / 12.92 : std::pow((v + 0.055) / 1.055, 2.4); }

/** An sRGB colour as a filter on XYZ relative to white (xyzFilter in colorExtraMath.ts). */
std::array<double, 3> xyzFilter(double r, double g, double b) {
  const double lin[3] = {srgbToLinear(clamp01(r)), srgbToLinear(clamp01(g)), srgbToLinear(clamp01(b))};
  std::array<double, 3> out{};
  for (int k = 0; k < 3; k++) {
    const double* row = kSrgbD50[k];
    out[size_t(k)] = (row[0] * lin[0] + row[1] * lin[1] + row[2] * lin[2]) / (row[0] + row[1] + row[2]);
  }
  return out;
}

/** Photo Filter's presets at full density, as XYZ relative to white (PHOTO_FILTER_PRESETS in colorExtraMath.ts). */
std::array<double, 3> photoFilterPreset(int32_t choice, const std::array<float, 3>& custom) {
  const auto c = [](double r, double g, double b) { return xyzFilter(r / 255, g / 255, b / 255); };
  switch (choice) {
    case 1: return {0.4743, 0.367, 0};
    case 2: return {0.546, 0.4277, 0.002};
    case 3: return c(235, 177, 19);
    case 4: return {0.1777, 0.1457, 1.4847};
    case 5: return {0.2723, 0.1683, 1.5757};
    case 6: return {0.1627, 0.2927, 1.9943};
    case 7: return c(234, 26, 26);
    case 8: return c(243, 132, 23);
    case 9: return c(249, 227, 28);
    case 10: return c(25, 201, 25);
    case 11: return c(29, 203, 234);
    case 12: return c(29, 53, 234);
    case 13: return c(155, 29, 234);
    case 14: return c(227, 24, 227);
    case 15: return c(172, 122, 51);
    case 16: return {0.533, 0.196, 0};
    case 17: return {0.0352, 0.0183, 0.5307};
    case 18: return {0.022, 0.149, 0.001};
    case 19: return {0.7144, 0.7001, 0.024};
    case 20: return {0.2714, 0.4077, 0.4414};
    default: return xyzFilter(custom[0], custom[1], custom[2]);
  }
}

/** Photo Filter: the filter, mixed with white by Density, multiplies XYZ relative to white (photoFilterMatrix). */
FxImage photoFilter(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const std::array<double, 3> full = photoFilterPreset(p.choice(1, 1), p.rgb(2, {0.93f, 0.54f, 0}));
  const double d = clamp01(p.num(3, 25) / 100);
  double s[3];
  for (int k = 0; k < 3; k++) s[k] = 1 - d + d * full[size_t(k)];
  const auto inverse = invert3(kSrgbD50);
  // Row-major m[i][j], uploaded column-major.
  float columns[9];
  for (int i = 0; i < 3; i++)
    for (int j = 0; j < 3; j++) {
      double sum = 0;
      for (int k = 0; k < 3; k++) sum += inverse[size_t(i)][size_t(k)] * s[k] * kSrgbD50[k][j];
      columns[j * 3 + i] = float(sum);
    }
  return colorEffect(ctx, input, fx::photo_filter, [&](FxUniforms& u) {
    u.matrix("u_filter", columns);
    u.i("u_preserve", p.flag(4, true) ? 1 : 0);
  });
}

FxImage selectiveColor(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  static const uint32_t kGroups[9] = {9, 15, 21, 27, 33, 39, 45, 51, 57};
  float adjust[36];
  for (int g = 0; g < 9; g++)
    for (uint32_t k = 0; k < 4; k++) adjust[g * 4 + int(k)] = float(p.num(kGroups[g] + k, 0) / 100);
  return colorEffect(ctx, input, fx::selective_color, [&](FxUniforms& u) {
    u.fv("u_adjust", adjust, 9, 4);
    u.i("u_relative", p.choice(1, 1) == 1 ? 1 : 0);
  });
}

/** The colour keys' softness scale per metric (KEY_SOFTNESS in colorExtraMath.ts: RGB, hue, chroma). */
double keySoftness(int32_t metric) { return metric == 2 ? 1.16 : 2.0 / 3; }

void setKey(FxUniforms& u, const std::array<float, 3>& key, double tolerance, double softness, int32_t metric) {
  setRgb(u, "u_key", key);
  u.f("u_tolerance", float(tolerance));
  u.f("u_softness", float(softness));
  u.i("u_metric", metric);
  u.f("u_softScale", float(keySoftness(metric)));
}

FxImage leaveColor(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return colorEffect(ctx, input, fx::leave_color, [&](FxUniforms& u) {
    u.f("u_amount", float(clamp01(p.num(1, 0) / 100)));
    setKey(u, p.rgb(2, {1, 0, 0}), p.num(3, 15) / 100, p.num(4, 0) / 100, p.choice(5, 1));
  });
}

FxImage changeColor(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return colorEffect(ctx, input, fx::change_color, [&](FxUniforms& u) {
    u.i("u_view", p.choice(1, 1));
    u.f("u_shift", float(p.num(2, 0) / 360), float(p.num(4, 0) / 100), float(p.num(3, 0) / 100));
    u.i("u_invert", p.flag(9, false) ? 1 : 0);
    setKey(u, p.rgb(5, {1, 0, 0}), p.num(6, 15) / 100, p.num(7, 0) / 100, p.choice(8, 1));
  });
}

FxImage changeToColor(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const std::array<double, 3> from = rgbToHsl(p.rgb(1, {1, 0, 0}));
  const std::array<double, 3> to = rgbToHsl(p.rgb(2, {0, 0, 1}));
  // The Change menu (CHANGE_TO_COLOR_CHANNELS): hue; hue and lightness; hue and saturation; all three.
  const int32_t change = p.choice(3, 1);
  const bool light = change == 2 || change == 4, sat = change == 3 || change == 4;
  return colorEffect(ctx, input, fx::change_to_color, [&](FxUniforms& u) {
    u.f("u_from", float(from[0]), float(from[1]), float(from[2]));
    u.f("u_to", float(to[0]), float(to[1]), float(to[2]));
    u.f("u_tolerance", float(p.num(5, 0.05)), float(p.num(6, 0.5)), float(p.num(7, 0.5)));
    u.f("u_softness", float(p.num(8, 0.5)));
    u.i("u_change", light ? 1 : 0, sat ? 1 : 0);
    u.i("u_transform", p.choice(4, 1) == 2 ? 1 : 0);
    u.i("u_view", p.flag(9, false) ? 1 : 0);
  });
}

/** CC Kernel: a 3 x 3 convolution of straight colour, divided by Divider, blended with the original. */
FxImage kernel(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  static const uint32_t kTaps[9] = {2, 3, 4, 7, 8, 9, 12, 13, 14};
  float k[9];
  for (int i = 0; i < 9; i++) k[i] = float(p.num(kTaps[i], kTaps[i] == 8 ? 1 : 0));
  return mapPass(ctx, input, fx::kernel, [&](FxUniforms& u) {
    u.fv("u_k", k, 9);
    u.f("u_divider", float(std::max(0.01, p.num(16, 1))));
    u.i("u_absolute", p.flag(17, false) ? 1 : 0);
    u.f("u_blend", float(clamp01(p.num(18, 0) / 100)));
  });
}

}  // namespace

FxRenderer tintRenderer() { return tint; }
FxRenderer tritoneRenderer() { return tritone; }
FxRenderer brightnessContrastRenderer() { return brightnessContrast; }
FxRenderer exposureRenderer() { return exposure; }
FxRenderer hueSaturationRenderer() { return hueSaturation; }
FxRenderer vibranceRenderer() { return vibrance; }
FxRenderer colorBalanceHlsRenderer() { return colorBalanceHls; }
FxRenderer channelMixerRenderer() { return channelMixer; }
FxRenderer blackWhiteRenderer() { return blackWhite; }
FxRenderer easyLevelsRenderer() { return easyLevels; }
FxRenderer invertRenderer() { return invert; }
FxRenderer posterizeRenderer() { return posterize; }
FxRenderer shiftChannelsRenderer() { return shiftChannels; }
FxRenderer proLevelsRenderer() { return proLevels; }
FxRenderer tonerRenderer() { return toner; }
FxRenderer colorOffsetRenderer() { return colorOffset; }
FxRenderer gammaPedestalGainRenderer() { return gammaPedestalGain; }
FxRenderer colorBalanceRenderer() { return colorBalance; }
FxRenderer neutralizerRenderer() { return neutralizer; }
FxRenderer photoFilterRenderer() { return photoFilter; }
FxRenderer selectiveColorRenderer() { return selectiveColor; }
FxRenderer leaveColorRenderer() { return leaveColor; }
FxRenderer changeColorRenderer() { return changeColor; }
FxRenderer changeToColorRenderer() { return changeToColor; }
FxRenderer kernelRenderer() { return kernel; }

}  // namespace aevk
