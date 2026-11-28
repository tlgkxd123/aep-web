/** The renderers of the effects the engine draws, by the file that ports them; registry.cpp maps match names to them. */
#pragma once

#include "../fx.h"

namespace aevk {

/** box_blur.cpp */
FxRenderer boxBlurRenderer();
/** deep_glow.cpp */
FxRenderer deepGlowRenderer();
/** stylize.cpp */
FxRenderer strobeRenderer();

}  // namespace aevk
