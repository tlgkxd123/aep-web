/**
 * Channel and Utility effects, ported from src/render/effects/channelUtility.ts with the same shaders: Set Channels,
 * Channel Combiner, Arithmetic, Compound Arithmetic, Blend, Calculations, Solid Composite, CC Composite, Grow Bounds,
 * Cineon Converter, HDR Compander and HDR Highlight Compression. Their layer parameters read another layer's content
 * (FxContext::source), or the layer's own input when they name none.
 */
#include <algorithm>
#include <cmath>
#include <vector>

#include "effects.h"
#include "stock.h"

namespace aevk {
namespace {

/** Math.round: half up. */
double jsRound(double v) { return std::floor(v + 0.5); }

/** Math.round as a GLint. */
int32_t roundInt(double v) { return glInt(jsRound(v)); }

/** clamp(v, 0, 1). */
float unit(double v) { return float(std::min(1.0, std::max(0.0, v))); }

/** The layer blending modes the composite shaders take (BlendMode in src/render/shaders.ts). */
enum BlendMode : int32_t {
  kNormal = 5212,
  kDarken = 5215,
  kMultiply = 5216,
  kLinearBurn = 5217,
  kColorBurn = 5218,
  kClassicColorBurn = 5219,
  kAdd = 5220,
  kLighten = 5221,
  kScreen = 5222,
  kLinearDodge = 5223,
  kColorDodge = 5224,
  kClassicColorDodge = 5225,
  kOverlay = 5226,
  kSoftLight = 5227,
  kHardLight = 5228,
  kLinearLight = 5229,
  kVividLight = 5230,
  kPinLight = 5231,
  kHardMix = 5232,
  kDifference = 5233,
  kClassicDifference = 5234,
  kExclusion = 5235,
  kHue = 5236,
  kSaturation = 5237,
  kColor = 5238,
  kLuminosity = 5239,
  kStencilAlpha = 5240,
  kStencilLuma = 5241,
  kSilhouetteAlpha = 5242,
  kSilhouetteLuma = 5243,
  kAlphaAdd = 5244,
  kLuminescentPremul = 5245,
};

/** A popup's stored value mapped to a blending mode. */
struct ModeEntry {
  int32_t value;
  int32_t mode;
};

/** The blending mode `value` maps to in `table`, else Normal. */
template <size_t N>
int32_t modeOf(const ModeEntry (&table)[N], int32_t value) {
  for (const ModeEntry& e : table)
    if (e.value == value) return e.mode;
  return kNormal;
}

/**
 * The image a layer parameter names, placed under the layer (Second in channelUtility.ts): second image point =
 * scale * layer image point + offset, per axis.
 */
struct Second {
  FxImage image;
  float scale[2] = {1, 1};
  float offset[2] = {0, 0};
  /** Whether `image` is the caller's to release (not the effect's input). */
  bool owned = false;
  /** Pixel centres a stretched layer's reads stay within (x0, y0, x1, y1), else unbounded. */
  float clamp[4] = {-1e9f, -1e9f, 1e9f, 1e9f};
  bool clamped = false;
};

/** Where an unstretched second layer goes (Placement.unstretched). */
enum class Unstretched { Center, TopLeft };

/** The input itself as a second layer. */
Second inputSecond(const FxImage& input) {
  Second s;
  s.image = input;
  return s;
}

/**
 * The layer that parameter `param` names, stretched over the layer's box or else centred on it (or at its top left),
 * as secondImage does: the input when it names no other layer; false when that layer draws nothing.
 */
bool secondImage(FxContext& ctx, const Effect& effect, uint32_t param, const EffectLayer& layer, const FxImage& input, bool stretch, Second& out,
                 Unstretched unstretched = Unstretched::Center, bool clampEdges = false) {
  FxImage image;
  EffectLayer other;
  const FxSource found = ctx.source(effect, param, image, other);
  if (found == FxSource::None) {
    out = inputSecond(input);
    return true;
  }
  if (found == FxSource::Empty || !image.target) return false;
  const double k = input.scale;
  const double mk = image.scale;
  const FxRect rect = layerRect(layer, input);
  const FxRect mrect = layerRect(other, image);
  const double sx = stretch ? mrect.width / rect.width : mk / k;
  const double sy = stretch ? mrect.height / rect.height : mk / k;
  out = Second{};
  out.image = image;
  out.owned = true;
  out.scale[0] = float(sx);
  out.scale[1] = float(sy);
  if (!stretch && unstretched == Unstretched::TopLeft) {
    out.offset[0] = float(mrect.x - rect.x * sx);
    out.offset[1] = float(mrect.y - rect.y * sy);
  } else {
    out.offset[0] = float(mrect.x + mrect.width / 2 - (rect.x + rect.width / 2) * sx);
    out.offset[1] = float(mrect.y + mrect.height / 2 - (rect.y + rect.height / 2) * sy);
  }
  if (stretch && clampEdges) {
    out.clamped = true;
    out.clamp[0] = float(mrect.x + 0.5);
    out.clamp[1] = float(mrect.y + 0.5);
    out.clamp[2] = float(mrect.x + mrect.width - 0.5);
    out.clamp[3] = float(mrect.y + mrect.height - 0.5);
  }
  return true;
}

void release(FxContext& ctx, const Second& s) {
  if (s.owned) ctx.release(s.image.target);
}

/** Sets second layer n's placement uniforms (bindSecond). */
void bindSecond(FxUniforms& u, int n, const Second& s) {
  const std::string i = std::to_string(n);
  u.f(("u_scale" + i).c_str(), s.scale[0], s.scale[1]);
  u.f(("u_offset" + i).c_str(), s.offset[0], s.offset[1]);
  u.f(("u_clamp" + i).c_str(), s.clamp[0], s.clamp[1], s.clamp[2], s.clamp[3]);
}

/**
 * A withSeconds shader over the input's pixels: the input is source 0 and second layer n source n + 1 (the native
 * shaders give each its own source, as secondsDecls builds them). Releases the input and the seconds it owns.
 */
FxImage withSeconds(FxContext& ctx, FxImage input, const std::vector<Second>& seconds, fx::Id shader, const FxSetter& set) {
  const auto bind = [&](FxUniforms& u) {
    for (size_t n = 0; n < seconds.size(); n++) bindSecond(u, int(n), seconds[n]);
    if (set) set(u);
  };
  FxImage out;
  switch (seconds.size()) {
    case 1: out = layerPass(ctx, imageRect(input), {input, seconds[0].image}, shader, bind, input.scale); break;
    case 4:
      out = layerPass(ctx, imageRect(input), {input, seconds[0].image, seconds[1].image, seconds[2].image, seconds[3].image}, shader, bind, input.scale);
      break;
    default: ctx.warn("withSeconds: unsupported layer count"); return input;
  }
  for (const Second& s : seconds) release(ctx, s);
  ctx.release(input.target);
  return out;
}

/** Set Channels: each of the layer's channels from a channel of a source layer (the layer itself when none is chosen). */
FxImage setChannels(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const bool stretch = p.flag(9, true);
  std::vector<Second> seconds(4);
  int32_t channels[4], empty[4];
  for (uint32_t c = 0; c < 4; c++) {
    const bool drawn = secondImage(ctx, effect, 1 + 2 * c, layer, input, stretch, seconds[c]);
    if (!drawn) seconds[c] = inputSecond(input);
    empty[c] = drawn ? 0 : 1;
    channels[c] = roundInt(p.num(2 + 2 * c, c + 1));
  }
  return withSeconds(ctx, input, seconds, fx::set_channels, [&](FxUniforms& u) {
    u.i("u_channels", channels[0], channels[1], channels[2], channels[3]);
    u.i("u_empty", empty[0], empty[1], empty[2], empty[3]);
  });
}

/** Channel Combiner's From and To defaults: RGB to HLS, Lightness. */
constexpr int32_t kFromRgbToHls = 1;
constexpr int32_t kToLightness = 7;

/** Channel Combiner: one representation of the layer's colour (or a source layer's) converted to another. */
FxImage channelCombiner(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  Second source = inputSecond(input);
  if (p.flag(2, false) && !secondImage(ctx, effect, 3, layer, input, true, source)) source = inputSecond(input);
  return withSeconds(ctx, input, {source}, fx::channel_combiner, [&](FxUniforms& u) {
    u.i("u_from", roundInt(p.num(5, kFromRgbToHls)));
    u.i("u_to", roundInt(p.num(6, kToLightness)));
    u.i("u_invert", p.flag(7, false) ? 1 : 0);
    u.i("u_solid", p.flag(8, false) ? 1 : 0);
  });
}

/** Arithmetic's Operator default: Xor. */
constexpr int32_t kArithXor = 3;

/** Arithmetic: an integer operation on each 8-bit colour channel with a constant. */
FxImage arithmetic(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return mapPass(ctx, input, fx::arithmetic, [&](FxUniforms& u) {
    u.i("u_op", roundInt(p.num(1, kArithXor)));
    u.i("u_value", roundInt(p.num(2, 0)), roundInt(p.num(3, 0)), roundInt(p.num(4, 0)));
    u.i("u_clip", p.flag(5, true) ? 1 : 0);
  });
}

/** Compound Arithmetic's operators and overflow behaviours that the passes tell apart. */
enum Compound : int32_t { kCompoundCopy = 1, kCompoundAdd = 2, kCompoundSubtract = 3 };
enum Overflow : int32_t { kOverflowClip = 1, kOverflowWrap = 2, kOverflowScale = 3 };

/** The per-channel minimum (or maximum) of a float image as a 1 x 1 float target, by 8 x 8 steps; releases nothing (reduceMinMax). */
Target* reduceMinMax(FxContext& ctx, Target* image, bool max) {
  Target* from = image;
  while (ctx.width(from) > 1 || ctx.height(from) > 1) {
    const uint32_t w = ctx.width(from);
    const uint32_t h = ctx.height(from);
    Target* to = ctx.acquire(std::ceil(w / 8.0), std::ceil(h / 8.0), FxFormat::Float);
    ctx.pass(fx::min_max, *to, {from}, [&](FxUniforms& u) {
      u.i("u_source", 0);
      u.i("u_from", int32_t(w), int32_t(h));
      u.i("u_max", max ? 1 : 0);
    });
    if (from != image) ctx.release(from);
    from = to;
  }
  return from;
}

/**
 * Compound Arithmetic: the layer combined channel by channel with a second layer (stretched over the layer's box or at
 * its top left), on the colour channels, the alpha or both, at 1 - Blend With Original.
 */
FxImage compoundArithmetic(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  Second second;
  if (!secondImage(ctx, effect, 1, layer, input, p.flag(5, true), second, Unstretched::TopLeft, true)) return input;
  const auto bind = [&](FxUniforms& u) { bindSecond(u, 0, second); };
  /** Straight colour, not premultiplied. */
  const FxImage aligned = layerPass(ctx, imageRect(input), {second.image}, fx::compound_aligned, bind, input.scale);
  /** A stretched layer's edges keep their colour but fade out in alpha: the factor, apart so the colour keeps 8 bits. */
  FxImage fade;
  if (second.clamped) fade = layerPass(ctx, imageRect(input), {second.image}, fx::compound_fade, bind, input.scale);
  release(ctx, second);
  const bool fades = fade.target != nullptr;
  const FxImage& fadeOrAligned = fades ? fade : aligned;
  const int32_t op = roundInt(p.num(2, kCompoundCopy));
  const int32_t overflow = roundInt(p.num(4, kOverflowClip));
  Target* lo = nullptr;
  Target* hi = nullptr;
  /** Only Add and Subtract leave 0..1, so only their results are scaled. */
  if (overflow == kOverflowScale && (op == kCompoundAdd || op == kCompoundSubtract)) {
    Target* raw = ctx.acquire(ctx.width(input.target), ctx.height(input.target), FxFormat::Float);
    ctx.pass(fx::compound_raw, *raw, {input.target, aligned.target, fadeOrAligned.target}, [&](FxUniforms& u) {
      u.i("u_source", 0);
      u.i("u_extra0", 1);
      u.i("u_extra1", 2);
      u.i("u_fades", fades ? 1 : 0);
      u.i("u_op", op);
    });
    lo = reduceMinMax(ctx, raw, false);
    hi = reduceMinMax(ctx, raw, true);
    ctx.release(raw);
  }
  const auto set = [&](FxUniforms& u) {
    u.i("u_op", op);
    u.i("u_fades", fades ? 1 : 0);
    u.i("u_channels", roundInt(p.num(3, 1)));
    u.i("u_overflow", lo && hi ? kOverflowScale : overflow == kOverflowWrap ? kOverflowWrap : kOverflowClip);
    u.f("u_blend", unit(p.num(6, 0) / 100));
  };
  FxImage out;
  if (lo && hi) {
    FxImage low, high;
    low.target = lo;
    high.target = hi;
    out = mapPass(ctx, input, fx::compound, set, {aligned, fadeOrAligned, low, high});
  } else {
    out = mapPass(ctx, input, fx::compound, set, {aligned, fadeOrAligned});
  }
  ctx.release(lo);
  ctx.release(hi);
  ctx.release(aligned.target);
  ctx.release(fade.target);
  return out;
}

/** Blend's Blend With Layer modes: Crossfade is the default. */
constexpr int32_t kBlendCrossfade = 1;

/** Blend: the layer mixed with a second layer by one of the crossfade or colour modes. */
FxImage blend(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  Second second;
  if (!secondImage(ctx, effect, 1, layer, input, p.num(4, 1) == 2, second)) return input;
  return withSeconds(ctx, input, {second}, fx::blend, [&](FxUniforms& u) {
    u.i("u_mode", roundInt(p.num(2, kBlendCrossfade)));
    u.f("u_original", unit(p.num(3, 0)));
  });
}

/** Calculations' Blending Mode popup (stored values, separators counted) as layer blending modes; 2 is Copy. */
constexpr ModeEntry kCalcModes[] = {
    {1, kNormal},          {4, kDarken},          {5, kMultiply},           {6, kColorBurn},       {7, kClassicColorBurn},
    {9, kAdd},             {10, kLighten},        {11, kScreen},            {12, kColorDodge},     {13, kClassicColorDodge},
    {15, kOverlay},        {16, kSoftLight},      {17, kHardLight},         {18, kLinearLight},    {19, kVividLight},
    {20, kPinLight},       {22, kDifference},     {23, kClassicDifference}, {24, kExclusion},      {26, kHue},
    {27, kSaturation},     {28, kColor},          {29, kLuminosity},        {31, kStencilAlpha},   {32, kStencilLuma},
    {33, kSilhouetteAlpha}, {34, kSilhouetteLuma}, {36, kAlphaAdd},          {37, kLuminescentPremul},
};

/** Calculations: one channel of the layer composited with one channel of a second layer. */
FxImage calculations(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  Second second;
  const bool hasSecond = secondImage(ctx, effect, 6, layer, input, p.flag(10, true), second);
  if (!hasSecond) second = inputSecond(input);
  const int32_t mode = roundInt(p.num(12, 1));
  return withSeconds(ctx, input, {second}, fx::calculations, [&](FxUniforms& u) {
    u.i("u_inChannel", roundInt(p.num(2, 1)));
    u.i("u_inInvert", p.flag(3, false) ? 1 : 0);
    u.i("u_secondChannel", roundInt(p.num(7, 1)));
    u.i("u_secondInvert", p.flag(9, false) ? 1 : 0);
    u.i("u_hasSecond", hasSecond ? 1 : 0);
    u.f("u_opacity", unit(p.num(8, 0)));
    u.i("u_mode", modeOf(kCalcModes, mode));
    u.i("u_copy", mode == 2 ? 1 : 0);
    u.i("u_preserve", p.flag(13, true) ? 1 : 0);
  });
}

/** Solid Composite's Blending Mode popup (stored values, separators counted); its Color Dodge, Color Burn and Difference are the classic modes. */
constexpr ModeEntry kSolidModes[] = {
    {1, kNormal},           {3, kAdd},        {4, kMultiply},    {5, kScreen},     {6, kOverlay},     {7, kSoftLight},
    {8, kHardLight},        {10, kClassicColorDodge}, {11, kClassicColorBurn}, {13, kDarken}, {14, kLighten},
    {15, kClassicDifference}, {16, kExclusion}, {18, kHue},       {19, kSaturation}, {20, kColor},     {21, kLuminosity},
};

/** Solid Composite: the layer at Source Opacity composited over a solid colour at Opacity. */
FxImage solidComposite(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return mapPass(ctx, input, fx::solid_composite, [&](FxUniforms& u) {
    u.f("u_sourceOpacity", unit(p.num(1, 100) / 100));
    const std::array<float, 3> color = p.rgb(2, {1, 1, 1});
    u.fv("u_color", color.data(), 1, 3);
    u.f("u_opacity", unit(p.num(3, 100) / 100));
    u.i("u_mode", modeOf(kSolidModes, roundInt(p.num(4, 1))));
  });
}

/**
 * CC Composite's Composite Original popup (stored values, separators counted); 1 Copy, 2 Behind, 3 In Front. 21 sits
 * where Linear Light does in the layer modes but composites as Linear Dodge.
 */
constexpr ModeEntry kCcModes[] = {
    {5, kDarken},        {6, kMultiply},         {7, kLinearBurn},     {8, kColorBurn},       {9, kClassicColorBurn},
    {11, kAdd},          {12, kLighten},         {13, kScreen},        {14, kLinearDodge},    {15, kColorDodge},
    {16, kClassicColorDodge}, {18, kOverlay},    {19, kSoftLight},     {20, kHardLight},      {21, kLinearDodge},
    {22, kVividLight},   {23, kPinLight},        {24, kHardMix},       {26, kDifference},     {27, kClassicDifference},
    {28, kExclusion},    {30, kHue},             {31, kSaturation},    {32, kColor},          {33, kLuminosity},
    {35, kStencilAlpha}, {36, kStencilLuma},     {37, kSilhouetteAlpha}, {38, kSilhouetteLuma}, {40, kAlphaAdd},
    {41, kLuminescentPremul},
};

/** CC Composite's first mode that RGB Only leaves alone (the stencil, silhouette and luminescent modes). */
constexpr int32_t kCcStencilAlpha = 35;

/** CC Composite: the layer before its effects (its content) composited with the effects' result, at Opacity. */
FxImage ccComposite(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  FxImage original;
  if (!ctx.ownContent(original) || !original.target) return input;
  Second second;
  second.image = original;
  second.owned = true;
  second.scale[0] = second.scale[1] = original.scale / input.scale;
  const int32_t mode = roundInt(p.num(2, 3));
  return withSeconds(ctx, input, {second}, fx::cc_composite, [&](FxUniforms& u) {
    u.i("u_op", mode <= 3 ? mode : 0);
    u.i("u_mode", modeOf(kCcModes, mode));
    u.f("u_opacity", unit(p.num(1, 100) / 100));
    u.i("u_rgbOnly", p.flag(3, true) && mode < kCcStencilAlpha ? 1 : 0);
  });
}

/** Grow Bounds' growth (layer pixels) beyond which a texture could exceed what devices allocate. */
constexpr double kMaxGrow = 2048;

/** Grow Bounds: the layer's image grown by Pixels of transparency on every side, for the effects after it (grown in fxextraUtil.ts). */
FxImage growBounds(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double g = std::max(0.0, std::ceil(std::min(kMaxGrow, std::max(0.0, p.num(1, 10))) * input.scale));
  if (g <= 0) return input;
  FxImage out = input;
  out.width = input.width + uint32_t(2 * g);
  out.height = input.height + uint32_t(2 * g);
  out.originX = float(input.originX - g);
  out.originY = float(input.originY - g);
  out.target = ctx.acquire(out.width + 2 * ctx.pad, out.height + 2 * ctx.pad, FxFormat::Color, false);
  const float outW = float(ctx.width(out.target));
  const float outH = float(ctx.height(out.target));
  ctx.pass(fx::grown, *out.target, {input.target}, [&](FxUniforms& u) {
    u.i("u_source", 0);
    u.f("u_outSize", outW, outH);
    u.f("u_inSize", float(ctx.width(input.target)), float(ctx.height(input.target)));
    u.f("u_grow", float(g));
  });
  ctx.release(input.target);
  return out;
}

/** Cineon Converter's Conversion Type default: Log to Linear. */
constexpr int32_t kCineonLogToLinear = 2;

/** Cineon Converter: 10-bit log codes to linear light, back, or between black and white points. */
FxImage cineon(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return mapPass(ctx, input, fx::cineon, [&](FxUniforms& u) {
    u.i("u_type", roundInt(p.num(1, kCineonLogToLinear)));
    u.f("u_black", float(p.num(2, 95)));
    u.f("u_white", float(p.num(4, 685)));
    u.f("u_k", float(0.0034 / std::max(1e-3, p.num(6, 1.7))));
    u.f("u_rolloff", float(std::max(0.0, p.num(7, 20))));
    u.f("u_lo", float(p.num(8, 0)));
    u.f("u_hi", float(p.num(9, 1)));
  });
}

/** HDR Compander's Mode default: Compress Range. */
constexpr int32_t kCompanderCompress = 1;

/** HDR Compander: the straight colour divided by Gain under 1 / Gamma, or the reverse. */
FxImage compander(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return mapPass(ctx, input, fx::compander, [&](FxUniforms& u) {
    u.i("u_mode", roundInt(p.num(1, kCompanderCompress)));
    u.f("u_gain", float(std::max(1e-6, p.num(2, 1))));
    u.f("u_gamma", float(std::max(1e-6, p.num(3, 1))));
  });
}

/** HDR Highlight Compression: a pixel's linear light scaled by 1 / (1 + its luminance), mixed in by Amount. */
FxImage hdrToneMap(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  return mapPass(ctx, input, fx::hdr_tonemap, [&](FxUniforms& u) { u.f("u_amount", unit(p.num(1, 100) / 100)); });
}

}  // namespace

FxRenderer setChannelsRenderer() { return setChannels; }
FxRenderer channelCombinerRenderer() { return channelCombiner; }
FxRenderer arithmeticRenderer() { return arithmetic; }
FxRenderer compoundArithmeticRenderer() { return compoundArithmetic; }
FxRenderer blendRenderer() { return blend; }
FxRenderer calculationsRenderer() { return calculations; }
FxRenderer solidCompositeRenderer() { return solidComposite; }
FxRenderer ccCompositeRenderer() { return ccComposite; }
FxRenderer growBoundsRenderer() { return growBounds; }
FxRenderer cineonRenderer() { return cineon; }
FxRenderer companderRenderer() { return compander; }
FxRenderer hdrToneMapRenderer() { return hdrToneMap; }

}  // namespace aevk
