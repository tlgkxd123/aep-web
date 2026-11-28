/**
 * Transitions of src/render/effects/transitionsExtra.ts: Gradient Wipe, CC Image Wipe, CC Scale Wipe, CC Radial
 * ScaleWipe, CC Light Wipe, CC Jaws, CC Line Sweep, Iris Wipe and Block Dissolve. The shaders are the TypeScript
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

constexpr double kPi = 3.14159265358979323846;
constexpr double kDeg = kPi / 180;

double clamp01(double v) { return std::min(1.0, std::max(0.0, v)); }

/** A CC effect's point parameter as a layer point in image pixels: Cycore effects place a point at the centre of its pixel (ccPoint). */
std::array<double, 2> ccPoint(const std::vector<double>& v, double k) {
  return {(v.size() > 0 ? v[0] + 0.5 : 0.5) * k, (v.size() > 1 ? v[1] + 0.5 : 0.5) * k};
}

/** The CC effects' default centre: the layer's middle less half a pixel, as ccPoint adds it back. */
std::vector<double> ccCenterDefault(const EffectLayer& layer, const FxImage& input) {
  const std::array<double, 2> c = layerCenter(layer, input);
  return {c[0] - 0.5, c[1] - 0.5};
}

/** The rectangle's corners. */
std::array<std::array<double, 2>, 4> corners(const FxRect& r) {
  return {{{r.x, r.y}, {r.x + r.width, r.y}, {r.x, r.y + r.height}, {r.x + r.width, r.y + r.height}}};
}

/** The smallest and largest projections of the rectangle's corners on `dir` (projectionRange in stockMath.ts). */
std::array<double, 2> projectionRange(const FxRect& r, const std::array<double, 2>& dir) {
  double lo = 1e300, hi = -1e300;
  for (const auto& c : corners(r)) {
    const double v = c[0] * dir[0] + c[1] * dir[1];
    lo = std::min(lo, v);
    hi = std::max(hi, v);
  }
  return {lo, hi};
}

/** The plain pass of a layerPass shader over the input's rectangle with the input as its only source; releases `input`. */
FxImage plainPass(FxContext& ctx, FxImage input, fx::Id shader, const FxSetter& set) { return pixelPass(ctx, input, shader, set); }

/**
 * The layer kept where the effect's keep() says, its edges blurred to fall off as a Gaussian of `sigma` image pixels,
 * the matte drawn beyond the image so edges leaving it blur as they would inside (keepMatte). Releases `input`.
 */
FxImage keepMatte(FxContext& ctx, FxImage input, fx::Id keepShader, fx::Id matteShader, const FxSetter& set, double sigma) {
  const double blur = std::sqrt(std::max(0.0, sigma * sigma - 1.0 / 12));
  if (blur < 0.2) return plainPass(ctx, input, keepShader, set);
  const int32_t radius = int32_t(std::ceil(3.5 * blur));
  const uint32_t width = ctx.width(input.target) + 2 * uint32_t(radius);
  const uint32_t height = ctx.height(input.target) + 2 * uint32_t(radius);
  const float originX = input.originX - float(radius), originY = input.originY - float(radius);
  Target* matte = ctx.acquire(width, height, FxFormat::Float);
  ctx.pass(matteShader, *matte, {}, [&](FxUniforms& u) {
    u.f("u_size", float(width), float(height));
    u.f("u_pad", float(ctx.pad));
    u.f("u_origin", originX, originY);
    if (set) set(u);
  });
  for (const std::array<int32_t, 2> step : {std::array<int32_t, 2>{1, 0}, std::array<int32_t, 2>{0, 1}}) {
    Target* next = ctx.acquire(width, height, FxFormat::Float);
    ctx.pass(fx::keep_feather, *next, {matte}, [&](FxUniforms& u) {
      u.i("u_source", 0);
      u.i("u_step", step[0], step[1]);
      u.i("u_radius", radius);
      u.f("u_sigma", float(blur));
      u.i("u_pad", ctx.pad);
    });
    ctx.release(matte);
    matte = next;
  }
  FxImage blurred = input;
  blurred.target = matte;
  blurred.originX = originX;
  blurred.originY = originY;
  blurred.width = input.width + 2 * uint32_t(radius);
  blurred.height = input.height + 2 * uint32_t(radius);
  const FxImage out = layerPass(ctx, imageRect(input), {input, blurred}, fx::keep_apply, {}, input.scale);
  ctx.release(matte);
  ctx.release(input.target);
  return out;
}

/** Gradient Wipe's Gradient Placement popup. */
enum GradientPlacement { kTile = 1, kCenter = 2, kStretch = 3 };

/** Layer point -> point of another layer's image: scale * p + offset per axis, and that image's box (placement). */
struct Placement {
  double scale[2] = {1, 1}, offset[2] = {0, 0};
  FxRect mapRect{0, 0, 1, 1};
};

Placement placement(const EffectLayer& layer, const FxImage& input, const EffectLayer& other, const FxImage& map, int32_t mode) {
  const FxRect rect = layerRect(layer, input);
  const FxRect mapRect = layerRect(other, map);
  const double k = input.scale, mk = map.scale;
  Placement out;
  out.mapRect = mapRect;
  if (mode == kStretch) {
    out.scale[0] = mapRect.width / rect.width;
    out.scale[1] = mapRect.height / rect.height;
    out.offset[0] = mapRect.x - rect.x * out.scale[0] + 0.5 * (1 - out.scale[0]);
    out.offset[1] = mapRect.y - rect.y * out.scale[1] + 0.5 * (1 - out.scale[1]);
    return out;
  }
  const double s = mk / k;
  out.scale[0] = out.scale[1] = s;
  if (mode == kCenter) {
    out.offset[0] = mapRect.x + mapRect.width / 2 - (rect.x + rect.width / 2) * s;
    out.offset[1] = mapRect.y + mapRect.height / 2 - (rect.y + rect.height / 2) * s;
  } else {
    out.offset[0] = mapRect.x - rect.x * s;
    out.offset[1] = mapRect.y - rect.y * s;
  }
  return out;
}

/** The gradient layer a wipe's layer parameter names, placed: false when it names none or that layer draws nothing (the layer itself then). */
bool gradientLayer(FxContext& ctx, const Effect& effect, uint32_t param, const EffectLayer& layer, const FxImage& input, int32_t mode, FxImage& map,
                   Placement& place) {
  EffectLayer other;
  const FxSource found = ctx.source(effect, param, map, other);
  if (found != FxSource::Image || !map.target) return false;
  place = placement(layer, input, other, map, mode);
  return true;
}

/**
 * Gradient Wipe: pixels whose gradient luminance (8-bit levels) is below the completion's threshold become
 * transparent, over Softness levels; the gradient is the Gradient Layer's (the layer itself for None).
 */
FxImage gradientWipe(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double completion = clamp01(p.num(1, 0));
  if (completion <= 0) return input;
  const double soft = std::floor(clamp01(p.num(2, 0)) * 255 + 0.5);
  const bool invert = p.flag(5, false);
  const double threshold = invert ? std::floor((1 - completion) * (255 + soft)) : std::floor(completion * (255 + soft)) - soft;
  const int32_t mode = p.choice(4, kStretch);
  FxImage map;
  Placement place;
  const bool own = !gradientLayer(ctx, effect, 3, layer, input, mode, map, place);
  const FxImage out = layerPass(ctx, imageRect(input), {input, own ? input : map}, fx::gradient_wipe, [&](FxUniforms& u) {
    u.f("u_scale", float(place.scale[0]), float(place.scale[1]));
    u.f("u_offset", float(place.offset[0]), float(place.offset[1]));
    u.f("u_mapRect", float(place.mapRect.x), float(place.mapRect.y), float(place.mapRect.width), float(place.mapRect.height));
    u.i("u_mode", mode);
    u.i("u_own", own ? 1 : 0);
    u.i("u_invert", invert ? 1 : 0);
    u.f("u_threshold", float(threshold));
    u.f("u_soft", float(soft != 0 ? soft : 2));
  }, input.scale);
  if (!own) ctx.release(map.target);
  ctx.release(input.target);
  return out;
}

/** CC Image Wipe's Property popup. */
enum ImageProperty { kLuminance = 5 };

/** CC Image Wipe: pixels whose gradient value (a Property of the Layer stretched over the layer) is below Completion become transparent. */
FxImage imageWipe(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double completion = clamp01(p.num(1, 0));
  if (completion <= 0) return input;
  const double soft = clamp01(p.num(2, 0.1));
  if (p.flag(3, false)) ctx.warn("CC Image Wipe: Auto Softness is drawn as the Border Softness");
  if (p.num(4, 0) > 0) ctx.warn("CC Image Wipe: Blur is not drawn");
  FxImage map;
  Placement place;
  const bool own = !gradientLayer(ctx, effect, 5, layer, input, kStretch, map, place);
  const FxImage out = layerPass(ctx, imageRect(input), {input, own ? input : map}, fx::image_wipe, [&](FxUniforms& u) {
    u.f("u_scale", float(place.scale[0]), float(place.scale[1]));
    u.f("u_offset", float(place.offset[0]), float(place.offset[1]));
    u.i("u_own", own ? 1 : 0);
    u.i("u_property", p.choice(6, kLuminance));
    u.i("u_invert", p.flag(7, false) ? 1 : 0);
    u.f("u_completion", float(completion));
    u.f("u_soft", float(soft));
    u.f("u_ramp", float(std::max(1.0, std::floor(soft * 255 + 0.5)) / 255));
  }, input.scale);
  if (!own) ctx.release(map.target);
  ctx.release(input.target);
  return out;
}

/** CC Scale Wipe: beyond the line through Center across Direction, the pixels at the line smeared out by Stretch. */
FxImage scaleWipe(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double stretch = p.num(1, 0);
  if (stretch == 0) return input;
  const double k = input.scale;
  const std::array<double, 2> c = ccPoint(p.vec(2, ccCenterDefault(layer, input)), k);
  const double sign = stretch > 0 ? 1 : -1;
  const std::array<double, 2> d = directionVector(p.num(3, 50));
  return plainPass(ctx, input, fx::scale_wipe, [&](FxUniforms& u) {
    u.f("u_center", float(c[0]), float(c[1]));
    u.f("u_dir", float(d[0] * sign), float(d[1] * sign));
    u.f("u_rate", float(std::abs(stretch) / 100 / k));
  });
}

/** CC Radial ScaleWipe's band, from the hole out to this many times its radius, and how far out its edge lies, in pixels. */
constexpr double kRadialBand = 1.309;
constexpr double kRadialEdge = 0.72;

/** CC Radial ScaleWipe: a hole opening at Center with the layer's middle smeared around it. */
FxImage radialScaleWipe(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double completion = clamp01(p.num(1, 0));
  if (completion <= 0) return input;
  const double k = input.scale;
  const std::array<double, 2> c = ccPoint(p.vec(2, ccCenterDefault(layer, input)), k);
  if (p.flag(3, false)) ctx.warn("CC Radial ScaleWipe: Reverse is drawn forwards");
  double reach = 0;
  for (const auto& q : corners(layerRect(layer, input))) reach = std::max(reach, std::hypot(q[0] - c[0] + 0.5 * k, q[1] - c[1] + 0.5 * k));
  const double radius = completion * reach;
  return plainPass(ctx, input, fx::radial_scale_wipe, [&](FxUniforms& u) {
    u.f("u_center", float(c[0]), float(c[1]));
    u.f("u_radius", float(radius));
    u.f("u_band", float(std::max(1e-3, (kRadialBand - 1) * radius)));
    u.f("u_edge", float(kRadialEdge * k));
  });
}

/** CC Light Wipe's Shape popup. */
enum LightShape { kDoors = 1, kRound = 2, kSquare = 3 };

/** CC Light Wipe: the layer cut away within a shape around Center, Color added to the pixels near its edge. */
FxImage lightWipe(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double completion = clamp01(p.num(1, 0) / 100);
  if (completion <= 0) return input;
  const double k = input.scale;
  const std::array<double, 2> c = ccPoint(p.vec(2, ccCenterDefault(layer, input)), k);
  const int32_t shape = p.choice(4, kRound);
  const std::array<double, 2> dir = directionVector(p.num(5, 0));
  if (p.flag(6, false)) ctx.warn("CC Light Wipe: Color from Source is drawn with Color");
  if (p.flag(8, false)) ctx.warn("CC Light Wipe: Reverse Transition is not drawn");
  double reach = -1e300;
  for (const auto& q : corners(layerRect(layer, input))) {
    const double vx = q[0] - c[0] + 0.5 * k, vy = q[1] - c[1] + 0.5 * k;
    reach = std::max(reach, shape == kDoors ? std::abs(vx * dir[0] + vy * dir[1]) : std::hypot(vx, vy));
  }
  const std::array<float, 3> light = p.rgb(7, {1, 1, 1});
  return plainPass(ctx, input, fx::light_wipe, [&](FxUniforms& u) {
    u.f("u_center", float(c[0]), float(c[1]));
    u.f("u_u", float(dir[0]), float(dir[1]));
    u.i("u_shape", shape);
    u.f("u_radius", float(completion * reach));
    u.f("u_light", light[0], light[1], light[2]);
    u.f("u_intensity", float(std::max(0.0, p.num(3, 100)) / 100));
  });
}

/** CC Jaws' Shape popup. */
enum JawShape { kSpikes = 1, kRobojaw = 2, kBlock = 3, kWaves = 4 };

/** How far Waves' jaws part beyond the layer's farthest edge, and overlap at Completion 0, in half tooth heights. */
constexpr double kWaveTravel = 1.1696;
constexpr double kWaveOverlap = 0.0589;

/** CC Jaws: two jaws meeting along the line through Center turned by Direction, parted by Completion. */
FxImage jaws(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double completion = clamp01(p.num(1, 0));
  if (completion <= 0) return input;
  const double k = input.scale;
  const std::array<double, 2> c = ccPoint(p.vec(2, ccCenterDefault(layer, input)), k);
  const double theta = p.num(3, 0) * kDeg;
  const double e[2] = {std::cos(theta), std::sin(theta)};
  const double n[2] = {-e[1], e[0]};
  const int32_t shape = p.choice(6, kSpikes);
  const FxRect rect = layerRect(layer, input);
  const double height = std::max(0.0, p.num(4, 0.2)) * rect.width;
  const double period = ((2 * std::max(2.0, p.num(5, 8))) / 100) * rect.width;
  double reach = -1e300;
  for (const auto& q : corners(rect)) reach = std::max(reach, std::abs((q[0] - c[0] + 0.5 * k) * n[0] + (q[1] - c[1] + 0.5 * k) * n[1]));
  const double half = height / 2;
  const double slope = (2 * height) / period;
  const double travel = shape == kSpikes ? reach + half + 0.5 * std::hypot(1.0, slope) : shape == kWaves ? reach + half * kWaveTravel : reach + half + 0.73;
  const double parted = completion * travel - (shape == kWaves ? half * kWaveOverlap : 0);
  return keepMatte(ctx, input, fx::jaws_keep, fx::jaws_keep, [&](FxUniforms& u) {
    u.f("u_center", float(c[0]), float(c[1]));
    u.f("u_e", float(e[0]), float(e[1]));
    u.f("u_n", float(n[0]), float(n[1]));
    u.i("u_shape", shape);
    u.f("u_half", float(half));
    u.f("u_period", float(period));
    u.f("u_parted", float(parted));
  }, 0);
}

/** How far CC Line Sweep's edges lie before where its geometry puts them along an axis (lineShift; measured). */
double lineShift(const std::array<double, 2>& axis) { return 0.286 - std::min(axis[0], 0.0) - std::min(axis[1], 0.0); }

/** CC Line Sweep: the layer's box cut into lines along Direction, each swept away across its length, lagging the one before. */
FxImage lineSweep(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double completion = clamp01(p.num(1, 0) / 100);
  if (completion <= 0) return input;
  const double k = input.scale;
  const std::array<double, 2> d = directionVector(p.num(2, 180));
  const bool flip = p.flag(5, false);
  const std::array<double, 2> s = flip ? std::array<double, 2>{-d[1], d[0]} : std::array<double, 2>{d[1], -d[0]};
  const FxRect rect = layerRect(layer, input);
  const std::array<double, 2> along = projectionRange(rect, d);
  const std::array<double, 2> across = projectionRange(rect, s);
  const double thickness = std::max(1.0, p.num(3, 50)) * k;
  const double length = across[1] - across[0];
  const double lines = std::max(1.0, std::floor((along[1] - along[0]) / thickness + 1e-6));
  const double first = along[1] - along[0] - lines * thickness > 1e-6 ? -1 : 0;
  const double lag = length * std::pow(1 - std::min(99.0, std::max(0.0, p.num(4, 50))) / 100, 2);
  const double lead = completion * (length + lines * lag) - lag;
  return plainPass(ctx, input, fx::line_sweep, [&](FxUniforms& u) {
    u.f("u_d", float(d[0]), float(d[1]));
    u.f("u_s", float(s[0]), float(s[1]));
    u.f("u_slo", float(across[0] - lineShift(s)));
    u.f("u_thickness", float(thickness));
    u.f("u_lead", float(lead));
    u.f("u_lag", float(lag));
    u.f("u_lines", float(lines));
    u.f("u_first", float(first));
    u.f("u_start", float(along[1] - lines * thickness - lineShift(d)));
  });
}

/**
 * Iris Wipe's iris: floor(points / 2) tips at the outer radius, the first Rotation from straight up, the notches between
 * them at the inner radius, or on the line between the tips without one (irisVertices in transitionsExtraMath.ts).
 */
std::vector<float> irisVertices(const std::array<double, 2>& center, double points, double outer, bool useInner, double inner, double rotation,
                                double k) {
  const int32_t tips = std::max(3, int32_t(std::floor(points / 2)));
  const double notch = useInner ? inner : outer * std::cos(kPi / tips);
  std::vector<float> out;
  for (int32_t i = 0; i < 2 * tips; i++) {
    const double r = i % 2 ? notch : outer;
    const double a = rotation * kDeg + (i * kPi) / tips;
    out.push_back(float((center[0] + r * std::sin(a)) * k));
    out.push_back(float((center[1] - r * std::cos(a)) * k));
  }
  return out;
}

/** Iris Wipe's feather -> sigma of its edge's Gaussian, both in layer pixels (irisFeatherSigma; measured). */
double irisFeatherSigma(double feather) {
  static const double kTable[][2] = {{0, 0.289}, {2, 0.717}, {5, 1.358}, {10, 2.421}, {20, 4.318}, {40, 8.136}};
  const size_t count = sizeof kTable / sizeof kTable[0];
  const double f = std::max(0.0, feather);
  for (size_t i = 1; i < count; i++) {
    const double f0 = kTable[i - 1][0], s0 = kTable[i - 1][1], f1 = kTable[i][0], s1 = kTable[i][1];
    if (f <= f1 || i == count - 1) return s0 + ((f - f0) * (s1 - s0)) / (f1 - f0);
  }
  return 0;
}

/** Iris Wipe: the layer cut away inside a star around Iris Center, Feather blurring its edge. */
FxImage irisWipe(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double k = input.scale;
  const double outer = std::max(0.0, p.num(3, 0));
  if (outer <= 0) return input;
  const std::array<double, 2> middle = layerCenter(layer, input);
  const std::vector<double> c = p.vec(1, {middle[0], middle[1]});
  const std::vector<float> verts =
      irisVertices({c.size() > 0 ? c[0] : 0, c.size() > 1 ? c[1] : 0}, p.num(2, 6), outer, p.flag(4, false), std::max(0.0, p.num(5, 0)), p.num(6, 0), k);
  return keepMatte(ctx, input, fx::iris_keep, fx::iris_matte, [&](FxUniforms& u) {
    u.fv("u_poly", verts.data(), uint32_t(verts.size() / 2), 2);
    u.i("u_count", int32_t(verts.size() / 2));
  }, irisFeatherSigma(p.num(7, 0)) * k);
}

/** Block Dissolve (a look-alike of After Effects' random blocks): each block goes once Completion passes its own level. */
FxImage blockDissolve(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double completion = clamp01(p.num(1, 0) / 100);
  if (completion <= 0) return input;
  const double k = input.scale;
  const double bw = std::max(1.0, p.num(2, 10)), bh = std::max(1.0, p.num(3, 10));
  return keepMatte(ctx, input, fx::block_dissolve_keep, fx::block_dissolve_matte, [&](FxUniforms& u) {
    u.f("u_block", float(bw * k), float(bh * k));
    u.f("u_completion", float(completion));
  }, p.flag(5, false) ? std::max(0.0, p.num(4, 0)) * k : 0);
}

}  // namespace

FxRenderer gradientWipeRenderer() { return gradientWipe; }
FxRenderer imageWipeRenderer() { return imageWipe; }
FxRenderer scaleWipeRenderer() { return scaleWipe; }
FxRenderer radialScaleWipeRenderer() { return radialScaleWipe; }
FxRenderer lightWipeRenderer() { return lightWipe; }
FxRenderer jawsRenderer() { return jaws; }
FxRenderer lineSweepRenderer() { return lineSweep; }
FxRenderer irisWipeRenderer() { return irisWipe; }
FxRenderer blockDissolveRenderer() { return blockDissolve; }

}  // namespace aevk
