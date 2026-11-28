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
  const Target* t[8] = {};
  size_t n = 0;
  for (const FxImage& s : sources) t[n++] = s.target;
  /** ctx.pass takes an initializer list: spell out the counts layerPass shaders are built for. */
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
  switch (n) {
    case 1: ctx.pass(shader, *out.target, {t[0]}, bind); break;
    case 2: ctx.pass(shader, *out.target, {t[0], t[1]}, bind); break;
    case 3: ctx.pass(shader, *out.target, {t[0], t[1], t[2]}, bind); break;
    case 4: ctx.pass(shader, *out.target, {t[0], t[1], t[2], t[3]}, bind); break;
    default: ctx.warn("layerPass: unsupported source count"); break;
  }
  return out;
}

FxImage mapPass(FxContext& ctx, FxImage input, fx::Id shader, const FxSetter& set, std::initializer_list<FxImage> extra) {
  const uint32_t w = ctx.width(input.target);
  const uint32_t h = ctx.height(input.target);
  Target* out = ctx.acquire(w, h, FxFormat::Color, false);
  const Target* t[8] = {input.target};
  size_t n = 1;
  for (const FxImage& e : extra) t[n++] = e.target;
  const auto bind = [&](FxUniforms& u) {
    u.i("u_source", 0);
    for (size_t i = 1; i < n; i++) u.i(("u_extra" + std::to_string(i - 1)).c_str(), int32_t(i));
    u.f("u_size", float(w), float(h));
    u.f("u_pad", float(ctx.pad));
    if (set) set(u);
  };
  switch (n) {
    case 1: ctx.pass(shader, *out, {t[0]}, bind); break;
    case 2: ctx.pass(shader, *out, {t[0], t[1]}, bind); break;
    case 3: ctx.pass(shader, *out, {t[0], t[1], t[2]}, bind); break;
    default: ctx.warn("mapPass: unsupported source count"); break;
  }
  ctx.release(input.target);
  input.target = out;
  return input;
}

FxImage pixelPass(FxContext& ctx, FxImage input, fx::Id shader, const FxSetter& set) {
  FxImage out = layerPass(ctx, imageRect(input), {input}, shader, set, input.scale);
  ctx.release(input.target);
  return out;
}

}  // namespace aevk
