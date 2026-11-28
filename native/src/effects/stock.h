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

/**
 * The layer's own rectangle in the input's pixels (layerRect): an AV layer's source box, a shape layer's comp-sized box
 * centred on its origin, else the input image's extent.
 */
FxRect layerRect(const EffectLayer& layer, const FxImage& input);

FxRect unionRect(const FxRect& a, const FxRect& b);

/** The largest output a distortion may grow the layer to, per side (image pixels; MAX_EXTENT). */
constexpr double kMaxExtent = 16384;

/** `r` grown to whole pixels, within kMaxExtent of the origin (clampRect). */
FxRect clampRect(const FxRect& r);

/** The default of an effect's centre point in layer pixels: the middle of a sized layer's box, else of its image (layerCenter). */
std::array<double, 2> layerCenter(const EffectLayer& layer, const FxImage& input);

/** A direction angle (degrees, 0 = up, clockwise) as a unit vector in layer space, y down (directionVector). */
std::array<double, 2> directionVector(double degrees);

/** An effect point in layer pixels: points are measured from the top left of the layer's box (layerPoint in generateExtra.ts). */
std::array<double, 2> effectPoint(const EffectLayer& layer, const std::vector<double>& point);

/** The default of an effect's centre point: the middle of the layer's box. */
inline std::vector<double> layerMiddle(const EffectLayer& layer) { return {layer.width / 2.0, layer.height / 2.0}; }

/** The most images one effect pass reads (layerPass sources, or mapPass's input and extras). */
constexpr size_t kMaxPassSources = 8;

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

/**
 * Runs a PASS_HEADER shader (sampling u_source at v_uv) over an image of the input's size, with u_size and u_pad set
 * and `extra` as u_extra0...; releases `input` (mapPass in fxextraUtil.ts).
 */
FxImage mapPass(FxContext& ctx, FxImage input, fx::Id shader, const FxSetter& set = {}, std::initializer_list<FxImage> extra = {});

/** The input's straight colours, opaque (unpremultiplied in stylizeExtra.ts); keeps `input`. */
FxImage unpremultiplied(FxContext& ctx, const FxImage& input);

/** A copy of `image` in a target of its own (copyImage in fxextraUtil.ts); keeps `image`. */
FxImage copyImage(FxContext& ctx, const FxImage& image);

/** layerPass over the input's own rectangle with the input as source 0, keeping its scale; releases `input`. */
FxImage pixelPass(FxContext& ctx, FxImage input, fx::Id shader, const FxSetter& set = {});

/** `r` grown by whole pixels, gx each side horizontally and gy vertically (growRect in stockMath.ts). */
FxRect growRect(const FxRect& r, double gx, double gy);

/** `input` resampled into `rect` (reframe in stockUtil.ts): the input itself when it covers just that; else releases it. */
FxImage reframe(FxContext& ctx, FxImage input, const FxRect& rect);

/** `input` with `grow` pixels (rounded up) of transparency added on every side (grown in fxextraUtil.ts); releases `input`. */
FxImage grown(FxContext& ctx, FxImage input, double grow);

/** A warp shader's pass over `rect` with the input as its source, at its scale (warp in stockUtil.ts); releases `input`. */
FxImage warpPass(FxContext& ctx, FxImage input, const FxRect& rect, fx::Id shader, const FxSetter& set = {});

/** A transparent image over `rect` at the input's scale; releases `input`. */
FxImage blankImage(FxContext& ctx, FxImage input, const FxRect& rect);

/**
 * The inverse of the projective map taking the unit square's corners (0,0), (1,0), (0,1), (1,1) to the four pins: a
 * row-major 3x3 matrix from layer points to unit-square coordinates (cornerPinInverse in stockMath.ts). False for a
 * degenerate quad.
 */
bool cornerPinInverse(const std::array<std::array<double, 2>, 4>& pins, std::array<double, 9>& inverse);

}  // namespace aevk
