/**
 * Keying and Matte effects of src/render/effects/keying.ts: Linear Color Key, Color Key, Luma Key, Extract, Color
 * Range, Matte Choker, Spill Suppressor and Advanced Spill Suppressor. The per-pixel models are keyingMath.ts's,
 * fitted to After Effects' renders of the keying fixtures.
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
 * View popups: 1 the result, 2 the source untouched, 3 the result's alpha as grey; 4 the alpha alone and 5 the key's
 * share alone, as mattes.
 */
enum View : int32_t { kViewFinal = 1, kViewSource = 2, kViewMatte = 3, kViewAlpha = 4, kViewKey = 5 };

/** Match Colors popup (MatchColors in keyingMath.ts). */
enum Match : int32_t { kMatchRgb = 1, kMatchHue = 2, kMatchChroma = 3 };

/** Chroma's weights of the r-g, r-b and g-b differences (CHROMA_WEIGHTS). */
constexpr float kChromaWeights[3] = {0.10902f, 0.03745f, 0.04379f};

/** Per Match Colors: Matching Softness 100 % as a ramp of the squared distance (LINEAR_SOFTNESS). */
double linearSoftness(int32_t match) {
  switch (match) {
    case kMatchRgb: return 0.672;
    case kMatchHue: return 1.1636;
    case kMatchChroma: return 0.41231;
    default: return 1;
  }
}

/** Per Match Colors: Matching Tolerance 100 % as a distance (LINEAR_TOLERANCE). */
double linearTolerance(int32_t match) {
  switch (match) {
    case kMatchRgb: return 255.5 / 255;
    case kMatchHue: return 1;
    case kMatchChroma: return 1.00806;
    default: return 1;
  }
}

/** A colour's hue, 0..1 (rgbToHsl in keyingMath.ts). */
double hueOf(const std::array<float, 3>& c) {
  const double r = c[0], g = c[1], b = c[2];
  const double mx = std::max({r, g, b}), mn = std::min({r, g, b});
  const double d = mx - mn;
  if (d <= 1e-6) return 0;
  const double h = mx == r ? (g - b) / d + (g < b ? 6 : 0) : mx == g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h / 6;
}

/** A keyShader pass over the input at View `view` (keyPass); the input itself for View Source, else releases it. */
FxImage keyPass(FxContext& ctx, FxImage input, fx::Id shader, int32_t view, const FxSetter& set = {}) {
  if (view == kViewSource) return input;
  return mapPass(ctx, input, shader, [&](FxUniforms& u) {
    u.i("u_view", view);
    if (set) set(u);
  });
}

/** A matte (every channel the value) of `input`, which stays valid: kViewAlpha its keyed alpha, kViewKey the key alone (keyMatte). */
FxImage keyMatte(FxContext& ctx, const FxImage& input, fx::Id shader, int32_t view, const FxSetter& set = {}) {
  return mapPass(ctx, copyImage(ctx, input), shader, [&](FxUniforms& u) {
    u.i("u_view", view);
    if (set) set(u);
  });
}

/** A matte eroded (`radius` > 0) or dilated (< 0) over a square of whole pixels (morph). */
FxImage morph(FxContext& ctx, FxImage matte, double radius) {
  const int32_t r = int32_t(std::round(std::abs(radius)));
  if (!r) return matte;
  for (int axis = 0; axis < 2; axis++) {
    matte = mapPass(ctx, matte, fx::key_morph, [&](FxUniforms& u) {
      u.f("u_dir", axis == 0 ? 1.0f : 0.0f, axis == 0 ? 0.0f : 1.0f);
      u.i("u_radius", r);
      u.i("u_max", radius < 0 ? 1 : 0);
    });
  }
  return matte;
}

/**
 * The keying effects' blur (featherMatte): a Gaussian truncated at the radius, its edge pixels repeated, its deviation
 * fitted to After Effects' feathered keys. Releases `image`.
 */
FxImage featherMatte(FxContext& ctx, FxImage image, double feather) {
  const double sigma = 0.3985 * feather + 0.443;
  for (int axis = 0; axis < 2; axis++) {
    image = mapPass(ctx, image, fx::key_feather, [&](FxUniforms& u) {
      u.f("u_dir", axis == 0 ? 1.0f : 0.0f, axis == 0 ? 0.0f : 1.0f);
      u.i("u_radius", int32_t(std::ceil(feather)));
      u.f("u_sigma", float(sigma));
    });
  }
  return image;
}

/** The colour of `colour` under the alpha of `matte` (or its own alpha times `matte`'s); releases both (withMatte). */
FxImage withMatte(FxContext& ctx, FxImage colour, FxImage matte, int32_t view, bool multiply = false) {
  FxImage out = mapPass(ctx, colour, fx::key_combine, [&](FxUniforms& u) {
    u.i("u_view", view);
    u.i("u_multiply", multiply ? 1 : 0);
  }, {matte});
  ctx.release(matte.target);
  return out;
}

/**
 * Color Key and Luma Key: the key thinned by Edge Thin (layer pixels; positive shrinks the opaque part) and softened
 * by Edge Feather, multiplied into the layer's alpha (keyWithEdges). Releases `input`.
 */
FxImage keyWithEdges(FxContext& ctx, FxImage input, fx::Id shader, double thin, double feather, const FxSetter& set) {
  const double k = input.scale;
  const double r = std::round(std::round(thin) * k);
  if (r == 0 && feather <= 0) return keyPass(ctx, input, shader, kViewFinal, set);
  FxImage matte = keyMatte(ctx, input, shader, kViewKey, set);
  matte = morph(ctx, matte, r);
  if (feather > 0) matte = featherMatte(ctx, matte, feather * k);
  return withMatte(ctx, input, matte, kViewFinal, true);
}

/** Linear Color Key (keyingMath.linearKey, linearKeyAlpha). */
FxImage linearColorKey(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const std::array<float, 3> key = p.rgb(3, {0, 0, 1});
  const int32_t match = int32_t(std::round(p.num(4, kMatchRgb)));
  const double tolerance = p.num(5, 0) / 100, softness = p.num(6, 10) / 100;
  const double t = tolerance * linearTolerance(match) + (match == kMatchHue && softness <= 0 ? 1.0 / 255 : 0);
  const bool keep = p.num(7, 1) == 2;
  return keyPass(ctx, input, fx::key_linear, int32_t(p.num(2, kViewFinal)), [&](FxUniforms& u) {
    u.f("u_key", key[0], key[1], key[2]);
    u.f("u_keyHue", float(std::round(hueOf(key) * 255)));
    u.i("u_match", match);
    u.f("u_chroma", kChromaWeights[0], kChromaWeights[1], kChromaWeights[2]);
    u.f("u_tolerance2", float(t * t));
    u.f("u_ramp", float(softness > 0 ? linearSoftness(match) * softness : 0));
    u.i("u_keep", keep ? 1 : 0);
  });
}

/** Color Key (keyingMath.colorKey). */
FxImage colorKey(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const std::array<float, 3> key = p.rgb(1, {0, 0, 1});
  const double tolerance = p.num(2, 0);
  return keyWithEdges(ctx, input, fx::key_color, p.num(3, 0), p.num(4, 0), [&](FxUniforms& u) {
    u.f("u_key", key[0], key[1], key[2]);
    u.f("u_tolerance", float(tolerance));
  });
}

/** Luma Key (keyingMath.lumaKey): luma and its limits times 100, whole numbers that compare exactly. */
FxImage lumaKey(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const int32_t type = int32_t(p.num(1, 2));
  const double threshold = std::round(p.num(2, 0) * 100), tolerance = std::round(p.num(3, 0) * 100);
  return keyWithEdges(ctx, input, fx::key_luma, p.num(4, 0), p.num(5, 0), [&](FxUniforms& u) {
    u.i("u_type", type);
    u.f("u_threshold", float(threshold));
    u.f("u_tolerance", float(tolerance));
  });
}

/** Extract (keyingMath.extract). */
FxImage extract(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return keyPass(ctx, input, fx::key_extract, kViewFinal, [&](FxUniforms& u) {
    u.i("u_channel", int32_t(p.num(2, 1)));
    u.f("u_black", float(p.num(3, 0)));
    u.f("u_white", float(p.num(4, 255)));
    u.f("u_blackSoftness", float(p.num(5, 0)));
    u.f("u_whiteSoftness", float(p.num(6, 0)));
    u.i("u_invert", p.flag(7, false) ? 1 : 0);
  });
}

/** Color Range (keyingMath.colorRange). */
FxImage colorRange(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return keyPass(ctx, input, fx::key_range, kViewFinal, [&](FxUniforms& u) {
    u.i("u_space", int32_t(p.num(3, 1)));
    u.f("u_min", float(p.num(4, 127)), float(p.num(6, 127)), float(p.num(8, 127)));
    u.f("u_max", float(p.num(5, 127)), float(p.num(7, 127)), float(p.num(9, 127)));
    u.f("u_fuzziness", float(p.num(2, 20)));
  });
}

/**
 * Matte Choker: per stage, the matte blurred by Geometric Softness, then cut at a level Choke sets (positive chokes,
 * negative spreads) with a ramp as wide as Gray Level Softness; both stages repeated Iterations times.
 */
FxImage matteChoker(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const double stages[2][3] = {{p.num(1, 4), p.num(2, 75), p.num(3, 0.1)}, {p.num(4, 0), p.num(5, 0), p.num(6, 1)}};
  const int32_t iterations = std::clamp(int32_t(std::round(p.num(7, 1))), 1, 100);
  const double reach = std::ceil(iterations * (stages[0][0] + stages[1][0]) * k) + 1;
  FxImage image = grown(ctx, input, reach);
  FxImage matte = keyMatte(ctx, image, fx::key_alpha, kViewAlpha);
  for (int32_t i = 0; i < iterations; i++) {
    for (const auto& stage : stages) {
      const double softness = stage[0], choke = stage[1], gray = stage[2];
      if (softness <= 0 && choke == 0) continue;
      if (softness > 0) {
        const FxRect edges = imageRect(matte);
        matte = gaussian(ctx, matte, softness * k / 2, softness * k / 2, &edges);
      }
      matte = mapPass(ctx, matte, fx::key_level, [&](FxUniforms& u) {
        u.f("u_threshold", float(0.5 + choke / 254));
        u.f("u_width", float(gray));
      });
    }
  }
  return withMatte(ctx, image, matte, kViewFinal);
}

/** Spill Suppressor (keyingMath.spillSuppress). */
FxImage spillSuppressor(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const std::array<float, 3> key = p.rgb(1, {0, 0, 1});
  const int32_t main = key[1] >= key[0] && key[1] >= key[2] ? 1 : key[2] >= key[0] ? 2 : 0;
  const double amount = p.num(3, 100) / 100;
  return keyPass(ctx, input, fx::key_spill, kViewFinal, [&](FxUniforms& u) {
    u.i("u_main", main);
    u.f("u_amount", float(amount));
  });
}

/** Advanced Spill Suppressor's Standard method (keyingMath.spillStandard); Suppression is parameter 1001. */
FxImage advancedSpillSuppressor(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  if (p.num(1, 1) != 1) {
    ctx.warn("Advanced Spill Suppressor's Ultra method is not rendered yet");
    return input;
  }
  const double amount = p.num(1001, 100) / 100;
  return keyPass(ctx, input, fx::key_spill2, kViewFinal, [&](FxUniforms& u) { u.f("u_amount", float(amount)); });
}

/** Difference Matte's Difference Layer placement choice that stretches it over the layer. */
constexpr int32_t kStretchToFit = 2;

/**
 * Difference Matte: the pixels whose colour matches the Difference Layer's source (centred on the layer, or stretched
 * over it) within Matching Tolerance are keyed out, softened over Matching Softness (a ramp of the squared distance);
 * both are blurred first by Blur Before Difference.
 */
FxImage differenceMatte(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const int32_t view = int32_t(p.num(1, kViewFinal));
  if (view == kViewSource) return input;
  FxImage plate;
  EffectLayer other;
  const bool hasPlate = ctx.source(effect, 2, plate, other) == FxSource::Image && plate.target;
  const double k = input.scale;
  const double blur = p.num(6, 0);
  FxImage source = input;
  bool ownSource = false;
  if (blur > 0) {
    source = featherMatte(ctx, copyImage(ctx, input), blur * k);
    ownSource = true;
    if (hasPlate) plate = featherMatte(ctx, plate, blur * k);
  }
  const FxRect rect = layerRect(layer, input);
  double scale[2] = {1, 1}, offset[2] = {0, 0};
  if (hasPlate) {
    const double mk = plate.scale;
    const FxRect mrect = layerRect(other, plate);
    if (p.num(3, 1) == kStretchToFit) {
      scale[0] = mrect.width / rect.width;
      scale[1] = mrect.height / rect.height;
    } else {
      scale[0] = scale[1] = mk / k;
    }
    offset[0] = mrect.x + mrect.width / 2 - (rect.x + rect.width / 2) * scale[0];
    offset[1] = mrect.y + mrect.height / 2 - (rect.y + rect.height / 2) * scale[1];
  }
  FxImage out = layerPass(ctx, imageRect(input), {input, source, hasPlate ? plate : source}, fx::difference_matte, [&](FxUniforms& u) {
    u.i("u_view", view);
    u.i("u_hasPlate", hasPlate ? 1 : 0);
    /** Fitted to keying_dmatte: the premultiplied RGB distance in 8-bit steps against the tolerance, its square ramped over the softness. */
    u.f("u_tolerance", float(p.num(4, 15) * 4.37));
    u.f("u_softness", float(p.num(5, 0) * 1302.6));
    u.f("u_scale", float(scale[0]), float(scale[1]));
    u.f("u_offset", float(offset[0]), float(offset[1]));
  }, input.scale);
  if (hasPlate) ctx.release(plate.target);
  if (ownSource) ctx.release(source.target);
  ctx.release(input.target);
  return out;
}

}  // namespace

FxRenderer linearColorKeyRenderer() { return linearColorKey; }
FxRenderer colorKeyRenderer() { return colorKey; }
FxRenderer lumaKeyRenderer() { return lumaKey; }
FxRenderer extractRenderer() { return extract; }
FxRenderer colorRangeRenderer() { return colorRange; }
FxRenderer matteChokerRenderer() { return matteChoker; }
FxRenderer spillSuppressorRenderer() { return spillSuppressor; }
FxRenderer advancedSpillSuppressorRenderer() { return advancedSpillSuppressor; }
FxRenderer differenceMatteRenderer() { return differenceMatte; }

}  // namespace aevk
