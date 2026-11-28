/** Shared pieces of the stock effects (src/render/effects/stockUtil.ts). */
#include "stock.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>

namespace aevk {
namespace {

/** Math.round: half up. */
double jsRound(double v) { return std::floor(v + 0.5); }

/** ctx.pass with the first `n` of `t` as inputs: it takes an initializer list, so the counts effects use are spelled out. */
void passInputs(FxContext& ctx, fx::Id shader, Target& out, const Target* const* t, size_t n, const FxSetter& bind, const char* caller) {
  switch (n) {
    case 1: ctx.pass(shader, out, {t[0]}, bind); break;
    case 2: ctx.pass(shader, out, {t[0], t[1]}, bind); break;
    case 3: ctx.pass(shader, out, {t[0], t[1], t[2]}, bind); break;
    case 4: ctx.pass(shader, out, {t[0], t[1], t[2], t[3]}, bind); break;
    case 5: ctx.pass(shader, out, {t[0], t[1], t[2], t[3], t[4]}, bind); break;
    case 6: ctx.pass(shader, out, {t[0], t[1], t[2], t[3], t[4], t[5]}, bind); break;
    case 7: ctx.pass(shader, out, {t[0], t[1], t[2], t[3], t[4], t[5], t[6]}, bind); break;
    case 8: ctx.pass(shader, out, {t[0], t[1], t[2], t[3], t[4], t[5], t[6], t[7]}, bind); break;
    default: ctx.warn(std::string(caller) + ": unsupported source count"); break;
  }
}

}  // namespace

FxRect imageRect(const FxImage& image) { return {image.originX, image.originY, double(image.width), double(image.height)}; }

FxRect layerRect(const EffectLayer& layer, const FxImage& input) {
  const double k = input.scale;
  double x0, y0;
  if (layer.width > 0 && layer.height > 0 && layer.kind == 0) {
    x0 = 0;
    y0 = 0;
  } else if (layer.width > 0 && layer.height > 0 && layer.kind == 1) {
    x0 = -std::floor(layer.width / 2.0);
    y0 = -std::floor(layer.height / 2.0);
  } else {
    return imageRect(input);
  }
  const double x1 = std::ceil((x0 + layer.width) * k - 1e-6);
  const double y1 = std::ceil((y0 + layer.height) * k - 1e-6);
  const double fx = std::floor(x0 * k + 1e-6);
  const double fy = std::floor(y0 * k + 1e-6);
  return {fx, fy, x1 - fx, y1 - fy};
}

FxRect unionRect(const FxRect& a, const FxRect& b) {
  const double x = std::min(a.x, b.x);
  const double y = std::min(a.y, b.y);
  return {x, y, std::max(a.x + a.width, b.x + b.width) - x, std::max(a.y + a.height, b.y + b.height) - y};
}

FxRect clampRect(const FxRect& r) {
  const double x = std::max(-kMaxExtent, std::floor(r.x));
  const double y = std::max(-kMaxExtent, std::floor(r.y));
  return {x, y, std::min(kMaxExtent, std::ceil(r.x + r.width)) - x, std::min(kMaxExtent, std::ceil(r.y + r.height)) - y};
}

std::array<double, 2> layerCenter(const EffectLayer& layer, const FxImage& input) {
  if (layer.width > 0 && layer.height > 0) return {layer.width / 2.0, layer.height / 2.0};
  const double k = input.scale;
  return {(input.originX + input.width / 2.0) / k, (input.originY + input.height / 2.0) / k};
}

double layerTimeAt(const EffectLayer& layer) {
  const double stretch = layer.stretch;
  const double offset = stretch >= 0 ? layer.startTime : layer.startTime - std::abs(stretch) / 3000;
  return (layer.time - offset) / stretch;
}

std::array<double, 2> directionVector(double degrees) {
  const double r = degrees * M_PI / 180;
  return {std::sin(r), -std::cos(r)};
}

std::array<double, 2> effectPoint(const EffectLayer& layer, const std::vector<double>& point) {
  const double x = point.empty() ? 0 : point[0];
  const double y = point.size() > 1 ? point[1] : 0;
  if (layer.kind == 1 && layer.width > 0 && layer.height > 0) return {x - std::floor(layer.width / 2.0), y - std::floor(layer.height / 2.0)};
  return {x, y};
}

double FxParams::num(uint32_t index, double fallback) const {
  const double v = fxNumber(effect_, index, fallback);
  return std::isfinite(v) ? v : fallback;
}

std::vector<double> FxParams::vec(uint32_t index, const std::vector<double>& fallback) const { return fxVector(effect_, index, fallback); }

std::array<float, 3> FxParams::rgb(uint32_t index, std::array<float, 3> fallback) const {
  const std::vector<double> v = vec(index, {fallback[0], fallback[1], fallback[2]});
  std::array<float, 3> out = fallback;
  for (size_t i = 0; i < 3 && i < v.size(); i++) out[i] = float(v[i]);
  return out;
}

int32_t FxParams::choice(uint32_t index, int32_t fallback, std::initializer_list<const char*> menu) const {
  const double v = num(index, NAN);
  if (std::isnan(v)) return fallback;
  const EffectParam* param = effect_.param(index);
  const bool own = param && !param->menu.empty();
  const size_t size = own ? param->menu.size() : menu.size();
  const int64_t steps = int64_t(jsRound(v));
  int32_t choice = 0;
  for (int64_t i = 0; i < steps; i++) {
    const size_t k = size_t(i);
    const bool separator = k < size && (own ? param->menu[k] != 0 : std::strncmp(menu.begin()[k], "(-", 2) == 0);
    if (!separator) choice++;
  }
  return choice < 1 ? 1 : choice;
}

FxImage layerPass(FxContext& ctx, const FxRect& rect, std::initializer_list<FxImage> sources, fx::Id shader, const FxSetter& set, float scale) {
  FxImage out;
  out.width = uint32_t(std::max(1.0, jsRound(rect.width)));
  out.height = uint32_t(std::max(1.0, jsRound(rect.height)));
  out.originX = float(jsRound(rect.x));
  out.originY = float(jsRound(rect.y));
  out.scale = scale < 0 ? 1 : scale;
  out.target = ctx.acquire(out.width + 2 * ctx.pad, out.height + 2 * ctx.pad, FxFormat::Color, false);
  const Target* t[kMaxPassSources] = {};
  size_t n = 0;
  for (const FxImage& s : sources)
    if (n < kMaxPassSources) t[n++] = s.target;
  const auto bind = [&](FxUniforms& u) {
    u.f("u_size", float(ctx.width(out.target)), float(ctx.height(out.target)));
    u.f("u_pad", float(ctx.pad));
    u.f("u_origin", out.originX, out.originY);
    int32_t i = 0;
    for (const FxImage& s : sources) {
      const std::string img = "u_img" + std::to_string(i);
      u.i(("u_src" + std::to_string(i)).c_str(), i);
      u.f((img + "Origin").c_str(), s.originX, s.originY);
      u.f((img + "Height").c_str(), float(s.height));
      u.f((img + "Target").c_str(), float(ctx.width(s.target)), float(ctx.height(s.target)));
      i++;
    }
    if (set) set(u);
  };
  passInputs(ctx, shader, *out.target, t, sources.size() <= kMaxPassSources ? n : 0, bind, "layerPass");
  return out;
}

FxImage mapPass(FxContext& ctx, FxImage input, fx::Id shader, const FxSetter& set, std::initializer_list<FxImage> extra) {
  const uint32_t w = ctx.width(input.target);
  const uint32_t h = ctx.height(input.target);
  Target* out = ctx.acquire(w, h, FxFormat::Color, false);
  const Target* t[kMaxPassSources] = {input.target};
  size_t n = 1;
  for (const FxImage& e : extra)
    if (n < kMaxPassSources) t[n++] = e.target;
  const auto bind = [&](FxUniforms& u) {
    u.i("u_source", 0);
    for (size_t i = 1; i < n; i++) u.i(("u_extra" + std::to_string(i - 1)).c_str(), int32_t(i));
    u.f("u_size", float(w), float(h));
    u.f("u_pad", float(ctx.pad));
    if (set) set(u);
  };
  passInputs(ctx, shader, *out, t, extra.size() < kMaxPassSources ? n : 0, bind, "mapPass");
  ctx.release(input.target);
  input.target = out;
  return input;
}

FxImage copyImage(FxContext& ctx, const FxImage& image) {
  FxImage out = image;
  out.target = ctx.acquire(ctx.width(image.target), ctx.height(image.target), FxFormat::Color, false);
  ctx.pass(fx::copy, *out.target, {image.target}, [](FxUniforms& u) { u.i("u_source", 0); });
  return out;
}

FxImage unpremultiplied(FxContext& ctx, const FxImage& input) { return layerPass(ctx, imageRect(input), {input}, fx::unpremultiplied); }

FxImage pixelPass(FxContext& ctx, FxImage input, fx::Id shader, const FxSetter& set) {
  FxImage out = layerPass(ctx, imageRect(input), {input}, shader, set, input.scale);
  ctx.release(input.target);
  return out;
}

FxRect growRect(const FxRect& r, double gx, double gy) {
  const double x = std::ceil(std::max(0.0, gx)), y = std::ceil(std::max(0.0, gy));
  return {r.x - x, r.y - y, r.width + 2 * x, r.height + 2 * y};
}

FxImage reframe(FxContext& ctx, FxImage input, const FxRect& rect) {
  const FxRect r = imageRect(input);
  if (r.x == rect.x && r.y == rect.y && r.width == rect.width && r.height == rect.height) return input;
  FxImage out = layerPass(ctx, rect, {input}, fx::reframe, {}, input.scale);
  ctx.release(input.target);
  return out;
}

FxImage grown(FxContext& ctx, FxImage input, double grow) {
  const double g = std::max(0.0, std::ceil(grow));
  if (g <= 0) return input;
  FxImage out = input;
  out.width = input.width + uint32_t(2 * g);
  out.height = input.height + uint32_t(2 * g);
  out.originX = float(input.originX - g);
  out.originY = float(input.originY - g);
  out.target = ctx.acquire(out.width + 2 * ctx.pad, out.height + 2 * ctx.pad, FxFormat::Color, false);
  const float outW = float(ctx.width(out.target)), outH = float(ctx.height(out.target));
  ctx.pass(fx::grown, *out.target, {input.target}, [&](FxUniforms& u) {
    u.i("u_source", 0);
    u.f("u_outSize", outW, outH);
    u.f("u_inSize", float(ctx.width(input.target)), float(ctx.height(input.target)));
    u.f("u_grow", float(g));
  });
  ctx.release(input.target);
  return out;
}

FxImage warpPass(FxContext& ctx, FxImage input, const FxRect& rect, fx::Id shader, const FxSetter& set) {
  FxImage out = layerPass(ctx, rect, {input}, shader, set, input.scale);
  ctx.release(input.target);
  return out;
}

FxImage blankImage(FxContext& ctx, FxImage input, const FxRect& rect) {
  ctx.release(input.target);
  return layerPass(ctx, rect, {}, fx::blank, {}, input.scale);
}

bool cornerPinInverse(const std::array<std::array<double, 2>, 4>& pins, std::array<double, 9>& inverse) {
  /** squareToQuad in stockMath.ts. */
  const double x0 = pins[0][0], y0 = pins[0][1], x1 = pins[1][0], y1 = pins[1][1];
  const double x2 = pins[2][0], y2 = pins[2][1], x3 = pins[3][0], y3 = pins[3][1];
  const double dx1 = x1 - x3, dy1 = y1 - y3, dx2 = x2 - x3, dy2 = y2 - y3;
  const double sx = x0 - x1 - x2 + x3, sy = y0 - y1 - y2 + y3;
  double g = 0, h = 0;
  if (std::abs(sx) > 1e-12 || std::abs(sy) > 1e-12) {
    const double det = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / det;
    h = (dx1 * sy - sx * dy1) / det;
  }
  const double a = x1 - x0 + g * x1, b = x2 - x0 + h * x2, c = x0;
  const double d = y1 - y0 + g * y1, e = y2 - y0 + h * y2, f = y0;
  const double i = 1;
  /** invert3 in stockMath.ts. */
  const double A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const double det = a * A + b * B + c * C;
  if (!(std::abs(det) >= 1e-12) || !std::isfinite(det)) return false;
  inverse = {A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det,
             -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det};
  return true;
}

}  // namespace aevk
