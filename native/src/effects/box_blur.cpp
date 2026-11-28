/**
 * Fast Box Blur (ADBE Box Blur2), ported from src/render/effects/boxBlur.ts: `Iterations` passes of a box of half-width
 * Blur Radius along each chosen dimension, on premultiplied pixels in float, summed from power-of-two partial sums.
 */
#include "box_blur.h"

#include <algorithm>
#include <cmath>

namespace aevk {
namespace {

enum Dimensions { kBoth = 1, kHorizontal = 2, kVertical = 3 };

struct Plane {
  Target* target;
  uint32_t width, height;
};

/**
 * One box pass of half-width `radius` (n whole taps each side plus a fractional outer tap) along an axis; with `inside`
 * = [lo, hi) it averages only the taps in that range. Releases `x`.
 */
Plane boxPass(FxContext& ctx, Plane x, bool horizontal, double radius, const int32_t* inside) {
  const int32_t n = int32_t(std::floor(radius));
  const double frac = radius - n;
  const int32_t taps = 2 * n + 1;
  const int32_t size = int32_t(horizontal ? x.width : x.height);
  const int32_t pSize = size + 2 * n;
  auto common = [&](FxUniforms& u) {
    u.i("u_x", 0);
    u.i("u_p", 1);
    u.i("u_acc", 2);
    u.i("u_axis", horizontal ? 1 : 0, horizontal ? 0 : 1);
    u.i("u_xSize", size);
    u.i("u_pOffset", n);
    u.i("u_pSize", pSize);
  };
  Target* p = nullptr;
  Target* acc = nullptr;
  int32_t start = -n;
  for (int32_t b = 0;; b++) {
    const int32_t bit = 1 << b;
    if (taps & bit) {
      Target* next = ctx.acquire(x.width, x.height, FxFormat::Float);
      ctx.pass(fx::box_accumulate, *next, {x.target, p ? p : x.target, acc ? acc : x.target}, [&](FxUniforms& u) {
        common(u);
        u.i("u_level0", p ? 0 : 1);
        u.i("u_hasAcc", acc ? 1 : 0);
        u.i("u_start", start);
      });
      ctx.release(acc);
      acc = next;
      start += bit;
    }
    if (taps < 2 * bit) break;
    Target* next = ctx.acquire(horizontal ? uint32_t(pSize) : x.width, horizontal ? x.height : uint32_t(pSize), FxFormat::Float);
    ctx.pass(fx::box_level, *next, {x.target, p ? p : x.target, x.target}, [&](FxUniforms& u) {
      common(u);
      u.i("u_level0", p ? 0 : 1);
      u.i("u_outOffset", n);
      u.i("u_step", bit);
    });
    ctx.release(p);
    p = next;
  }
  ctx.release(p);
  Target* out = ctx.acquire(x.width, x.height, FxFormat::Float);
  ctx.pass(fx::box_finish, *out, {x.target, x.target, acc}, [&](FxUniforms& u) {
    common(u);
    u.i("u_level0", 1);
    u.i("u_n", n);
    u.f("u_frac", float(frac));
    u.i("u_inside", inside ? 1 : 0);
    u.i("u_lo", inside ? inside[0] : 0);
    u.i("u_hi", inside ? inside[1] : size);
  });
  ctx.release(acc);
  ctx.release(x.target);
  return {out, x.width, x.height};
}

FxImage fastBoxBlur(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  auto num = [&](uint32_t index, double fallback) { return fxNumber(effect, index, fallback); };
  const double dims = num(3, kBoth);
  const bool repeatEdges = num(4, 0) != 0;
  BoxBlurOptions o;
  o.radius = std::max(0.0, num(1, 0)) * input.scale;
  o.iterations = int32_t(std::min(50.0, std::max(1.0, std::floor(num(2, 1) + 0.5))));
  o.horizontal = dims != kVertical;
  o.vertical = dims != kHorizontal;
  o.repeatEdges = repeatEdges;
  // The edges repeated are the buffer's, wherever the layer's content image ends.
  if (repeatEdges) o.hasBounds = effectBounds(layer, input, o.bounds);
  return boxBlur(ctx, input, o);
}

}  // namespace

bool effectBounds(const EffectLayer& layer, const FxImage& input, FxBounds& out) {
  if (layer.width <= 0 || layer.height <= 0) return false;
  double x0, y0;
  if (layer.kind == 1) {
    x0 = -std::floor(layer.width / 2.0);
    y0 = -std::floor(layer.height / 2.0);
  } else if (layer.kind == 0) {
    x0 = 0;
    y0 = 0;
  } else {
    return false;
  }
  double x1 = x0 + layer.width, y1 = y0 + layer.height;
  const double k = input.scale;
  if (k != 1) {
    x0 = std::floor(x0 * k + 1e-6);
    y0 = std::floor(y0 * k + 1e-6);
    x1 = std::ceil(x1 * k - 1e-6);
    y1 = std::ceil(y1 * k - 1e-6);
  }
  const double left = std::min(x0, double(input.originX));
  const double top = std::min(y0, double(input.originY));
  const double right = std::max(x1, double(input.originX) + input.width);
  const double bottom = std::max(y1, double(input.originY) + input.height);
  out = {left, top, right - left, bottom - top};
  return true;
}

FxImage boxBlur(FxContext& ctx, FxImage input, const BoxBlurOptions& o) {
  if (o.radius <= 0 || (!o.horizontal && !o.vertical)) return input;
  const FxBounds base = o.hasBounds ? o.bounds : FxBounds{input.originX, input.originY, double(input.width), double(input.height)};
  const int32_t step = int32_t(std::ceil(o.radius));
  const int32_t gx = o.horizontal ? o.iterations * step : 0;
  const int32_t gy = o.vertical ? o.iterations * step : 0;
  const double width = base.width + 2 * gx;
  const double height = base.height + 2 * gy;
  Plane plane{ctx.acquire(width, height, FxFormat::Float), uint32_t(width), uint32_t(height)};
  ctx.pass(fx::box_load, *plane.target, {input.target}, [&](FxUniforms& u) {
    u.i("u_source", 0);
    u.i("u_offset", glInt(base.originX - gx - input.originX), glInt(input.height - height - base.originY + gy + input.originY));
    u.i("u_size", int32_t(input.width), int32_t(input.height));
    u.i("u_pad", ctx.pad);
  });
  for (int32_t k = 0; k < o.iterations; k++) {
    if (o.horizontal) {
      const int32_t extent[2] = {gx - k * step, gx + int32_t(base.width) + k * step};
      plane = boxPass(ctx, plane, true, o.radius, o.repeatEdges ? extent : nullptr);
    }
    if (o.vertical) {
      const int32_t extent[2] = {gy - k * step, gy + int32_t(base.height) + k * step};
      plane = boxPass(ctx, plane, false, o.radius, o.repeatEdges ? extent : nullptr);
    }
  }
  const int32_t cx = o.repeatEdges ? gx : 0, cy = o.repeatEdges ? gy : 0;
  const double outWidth = width - 2 * cx;
  const double outHeight = height - 2 * cy;
  Target* out = ctx.acquire(outWidth + 2 * ctx.pad, outHeight + 2 * ctx.pad);
  ctx.pass(fx::box_store, *out, {plane.target}, [&](FxUniforms& u) {
    u.i("u_source", 0);
    u.i("u_size", glInt(outWidth), glInt(outHeight));
    u.i("u_crop", cx, cy);
    u.i("u_pad", ctx.pad);
  });
  ctx.release(plane.target);
  ctx.release(input.target);
  FxImage result;
  result.target = out;
  result.width = uint32_t(outWidth);
  result.height = uint32_t(outHeight);
  result.originX = float(base.originX - gx + cx);
  result.originY = float(base.originY - gy + cy);
  return result;
}

FxRenderer boxBlurRenderer() { return fastBoxBlur; }

}  // namespace aevk
