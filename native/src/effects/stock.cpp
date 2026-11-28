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

FxImage pixelPass(FxContext& ctx, FxImage input, fx::Id shader, const FxSetter& set) {
  FxImage out = layerPass(ctx, imageRect(input), {input}, shader, set, input.scale);
  ctx.release(input.target);
  return out;
}

}  // namespace aevk
