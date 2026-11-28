/**
 * Shared pieces of the stock After Effects effects, ported from src/render/effects/stockUtil.ts: parameter readers and
 * layerPass, the pass that writes a rectangle of layer space from layer images with a shader of layerPassFragment.
 */
#pragma once

#include <array>
#include <initializer_list>
#include <vector>

#include "../fx.h"

namespace aevk {

/** A rectangle in image pixels (Rect in stockMath.ts). */
struct FxRect {
  double x = 0, y = 0, width = 0, height = 0;
};

/** An image's content rectangle (imageRect). */
FxRect imageRect(const FxImage& image);

/** Reads an effect's parameters by 1-based index (Params in stockUtil.ts). */
class FxParams {
 public:
  explicit FxParams(const Effect& effect) : effect_(effect) {}
  /** The first value, or `fallback` when absent or not finite. */
  double num(uint32_t index, double fallback) const;
  std::vector<double> vec(uint32_t index, const std::vector<double>& fallback) const;
  bool flag(uint32_t index, bool fallback) const { return num(index, fallback ? 1 : 0) != 0; }
  std::array<float, 3> rgb(uint32_t index, std::array<float, 3> fallback) const;
  /**
   * A popup's choice (1-based, separators skipped): the project's menu when it has one, else `menu` (After Effects'
   * own, separators included); `fallback` when the parameter is absent.
   */
  int32_t choice(uint32_t index, int32_t fallback, std::initializer_list<const char*> menu = {}) const;

 private:
  const Effect& effect_;
};

/**
 * Writes `rect` from `sources` with an effect shader built by layerPassFragment for that many sources: sets u_size,
 * u_pad, u_origin and each source's u_src<i> and placement, then `set`. Releases nothing; the result has `scale`
 * (or 1 when negative).
 */
FxImage layerPass(FxContext& ctx, const FxRect& rect, std::initializer_list<FxImage> sources, fx::Id shader, const FxSetter& set = {},
                  float scale = -1);

/** layerPass over the input's own rectangle with the input as source 0, keeping its scale; releases `input`. */
FxImage pixelPass(FxContext& ctx, FxImage input, fx::Id shader, const FxSetter& set = {});

}  // namespace aevk
