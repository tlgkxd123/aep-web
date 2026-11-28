/** The Gaussian blur Gaussian Blur, Glow, Drop Shadow and other effects are built on (gaussian in src/render/effects/stockUtil.ts). */
#pragma once

#include "stock.h"

namespace aevk {

/** Standard deviations (image pixels) above which a Gaussian is three box passes of the same variance (EXACT_SIGMA_LIMIT). */
constexpr double kExactSigmaLimit = 24;

/** A Blurriness in pixels as the standard deviation of its kernel (blurrinessSigma in stockMath.ts). */
inline double blurrinessSigma(double blurriness) { return blurriness > 0 ? blurriness / 2.4 : 0; }

/** Blur Dimensions popups (1 both, 2 horizontal, 3 vertical): whether each axis blurs (blurAxes). */
inline bool blurHorizontal(double dimensions) { return dimensions != 3; }
inline bool blurVertical(double dimensions) { return dimensions != 2; }

/**
 * Gaussian blur of a premultiplied image with standard deviations in image pixels, grown by the blur's reach unless
 * `repeatEdges` is given: then the result covers just that rectangle and each pixel averages only the taps within it.
 * Releases `input`.
 */
FxImage gaussian(FxContext& ctx, FxImage input, double sigmaX, double sigmaY, const FxRect* repeatEdges = nullptr);

}  // namespace aevk
