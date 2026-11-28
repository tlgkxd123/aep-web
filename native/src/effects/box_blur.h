/** The box blur Fast Box Blur and other effects (Deep Glow, Minimax...) are built on (src/render/effects/boxBlur.ts). */
#pragma once

#include "../fx.h"

namespace aevk {

/** A rectangle in layer space (BoxBlurOptions.bounds). */
struct FxBounds {
  double originX = 0, originY = 0, width = 0, height = 0;
};

struct BoxBlurOptions {
  double radius = 0;
  int32_t iterations = 1;
  bool horizontal = true, vertical = true;
  /** After Effects' Repeat Edge Pixels: each pass averages only the taps within the previous pass's extent; cropped back. */
  bool repeatEdges = false;
  /** The rectangle the blur starts from when `hasBounds`, by default the input image's. */
  bool hasBounds = false;
  FxBounds bounds;
};

/** Iterated separable box blur of a layer image; releases `input`. */
FxImage boxBlur(FxContext& ctx, FxImage input, const BoxBlurOptions& options);

/**
 * The buffer After Effects hands the effect: the layer's rectangle in layer space, grown to what an earlier effect
 * spread beyond it (effectBounds); false when the layer has none.
 */
bool effectBounds(const EffectLayer& layer, const FxImage& input, FxBounds& out);

FxRenderer boxBlurRenderer();

}  // namespace aevk
