/** Gaussian blur (gaussian in src/render/effects/stockUtil.ts), with the same kernels, passes and reduced resolutions. */
#include "gaussian.h"

#include <algorithm>
#include <cmath>
#include <vector>

#include "box_blur.h"

namespace aevk {
namespace {

/** Entries of PAIRED_GAUSS_FS's kernel at most (MAX_KERNEL). */
constexpr size_t kMaxKernel = 40;

/** Standard deviations (image pixels) from which a Gaussian is computed at half, and at a quarter, of the resolution (REDUCE_SIGMA). */
constexpr double kReduceSigma[2] = {10, 20};

/** The variance a reduced blur adds per axis, which the kernel takes off (reducedVariance). */
double reducedVariance(double f) { return (f * f - 1) / 12 + (f * f) / 6; }

/** The half-width of a box whose three passes have variance sigma^2 (boxRadiusForSigma in stockMath.ts). */
double boxRadiusForSigma(double sigma) { return (std::sqrt(1 + 4 * sigma * sigma) - 1) / 2; }

/** GAUSS_FS's kernel for `sigma` out to `radius` as PAIRED_GAUSS_FS reads it: (offset, weight) per texture read (pairedKernel). */
std::vector<float> pairedKernel(double sigma, int32_t radius) {
  const auto w = [&](double i) { return std::exp((-0.5 * i * i) / (sigma * sigma)); };
  double total = w(0);
  for (int32_t i = 1; i <= radius; i++) total += 2 * w(i);
  std::vector<float> kernel = {0, float(w(0) / total)};
  for (int32_t i = 1; i <= radius && kernel.size() < 2 * kMaxKernel; i += 2) {
    const double a = w(i);
    const double b = i + 1 <= radius ? w(i + 1) : 0;
    kernel.push_back(float((i * a + (i + 1) * b) / (a + b)));
    kernel.push_back(float((a + b) / total));
  }
  return kernel;
}

/** `image` blurred by sigmaX, sigmaY at 1 / `f` of its resolution, in half float, and read back at full size; releases `image` (reducedGaussian). */
FxImage reducedGaussian(FxContext& ctx, FxImage image, double sigmaX, double sigmaY, double f) {
  const uint32_t width = uint32_t(std::ceil(image.width / f));
  const uint32_t height = uint32_t(std::ceil(image.height / f));
  const auto reduced = [&] { return ctx.acquire(width + 2 * ctx.pad, height + 2 * ctx.pad, FxFormat::Half, true); };
  const auto placed = [&](FxUniforms& u, const Target* to) {
    u.i("u_source", 0);
    u.f("u_size", float(ctx.width(to)), float(ctx.height(to)));
    u.f("u_pad", float(ctx.pad));
  };
  const auto scaled = [&](FxUniforms& u, const Target* from, uint32_t fromHeight, const Target* to) {
    placed(u, to);
    u.f("u_fromSize", float(ctx.width(from)), float(ctx.height(from)));
    u.f("u_fromHeight", float(fromHeight));
    u.f("u_factor", float(f));
  };
  Target* small = reduced();
  ctx.pass(fx::gauss_reduce, *small, {image.target}, [&](FxUniforms& u) { scaled(u, image.target, image.height, small); });
  for (int axis = 0; axis < 2; axis++) {
    const double sigma = axis == 0 ? sigmaX : sigmaY;
    const double s = std::sqrt(std::max(0.0, sigma * sigma - reducedVariance(f))) / f;
    const std::vector<float> kernel = pairedKernel(s, int32_t(std::ceil(3 * s)));
    Target* next = reduced();
    ctx.pass(fx::paired_gauss, *next, {small}, [&](FxUniforms& u) {
      placed(u, next);
      u.f("u_dir", axis == 0 ? 1.0f : 0.0f, axis == 0 ? 0.0f : 1.0f);
      u.i("u_taps", int32_t(kernel.size() / 2));
      u.fv("u_kernel", kernel.data(), uint32_t(kernel.size() / 2), 2);
    });
    ctx.release(small);
    small = next;
  }
  FxImage out = image;
  out.target = ctx.acquire(ctx.width(image.target), ctx.height(image.target), FxFormat::Color, false);
  ctx.pass(fx::gauss_expand, *out.target, {small}, [&](FxUniforms& u) {
    scaled(u, small, height, out.target);
    u.f("u_height", float(image.height));
  });
  ctx.release(small);
  ctx.release(image.target);
  return out;
}

}  // namespace

FxImage gaussian(FxContext& ctx, FxImage input, double sigmaX, double sigmaY, const FxRect* repeatEdges) {
  const double sx = sigmaX >= 0.1 ? sigmaX : 0;
  const double sy = sigmaY >= 0.1 ? sigmaY : 0;
  if (!sx && !sy) return repeatEdges ? reframe(ctx, input, *repeatEdges) : input;
  const float scale = input.scale;
  if (std::max(sx, sy) > kExactSigmaLimit) {
    BoxBlurOptions o;
    o.radius = boxRadiusForSigma(std::max(sx, sy));
    o.iterations = 3;
    o.horizontal = sx > 0;
    o.vertical = sy > 0;
    o.repeatEdges = repeatEdges != nullptr;
    if (repeatEdges) {
      o.hasBounds = true;
      o.bounds = {repeatEdges->x, repeatEdges->y, repeatEdges->width, repeatEdges->height};
    }
    FxImage out = boxBlur(ctx, input, o);
    out.scale = scale;
    return out;
  }
  const int32_t rx = int32_t(std::ceil(3 * sx));
  const int32_t ry = int32_t(std::ceil(3 * sy));
  FxImage image = reframe(ctx, input, repeatEdges ? *repeatEdges : growRect(imageRect(input), rx, ry));
  // Wide on both axes: blurred at a lower resolution, where Repeat Edge Pixels does not ask more.
  const bool exact = repeatEdges != nullptr;
  const double factor = exact ? 1 : std::min(sx, sy) >= kReduceSigma[1] ? 4 : std::min(sx, sy) >= kReduceSigma[0] ? 2 : 1;
  if (factor > 1) return reducedGaussian(ctx, image, sx, sy, factor);
  for (int axis = 0; axis < 2; axis++) {
    const double sigma = axis == 0 ? sx : sy;
    const int32_t radius = axis == 0 ? rx : ry;
    if (!sigma) continue;
    const float dx = axis == 0 ? 1.0f : 0.0f, dy = axis == 0 ? 0.0f : 1.0f;
    // Repeat Edge Pixels leaves out each tap beyond the edges, which a read of two taps cannot.
    if (exact) {
      image = mapPass(ctx, image, fx::gauss, [&](FxUniforms& u) {
        u.f("u_dir", dx, dy);
        u.f("u_sigma", float(sigma));
        u.i("u_radius", radius);
        u.i("u_clamp", 1);
      });
      continue;
    }
    const std::vector<float> kernel = pairedKernel(sigma, radius);
    image = mapPass(ctx, image, fx::paired_gauss, [&](FxUniforms& u) {
      u.f("u_dir", dx, dy);
      u.i("u_taps", int32_t(kernel.size() / 2));
      u.fv("u_kernel", kernel.data(), uint32_t(kernel.size() / 2), 2);
    });
  }
  return image;
}

}  // namespace aevk
