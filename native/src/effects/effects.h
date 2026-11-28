/** The renderers of the effects the engine draws, by the file that ports them; registry.cpp maps match names to them. */
#pragma once

#include "../fx.h"

namespace aevk {

/** audio_spectrum.cpp */
FxRenderer audioSpectrumRenderer();
/** blur.cpp */
FxRenderer channelBlurRenderer();
FxRenderer crossBlurRenderer();
/** transitions.cpp */
FxRenderer gradientWipeRenderer();
FxRenderer imageWipeRenderer();
FxRenderer scaleWipeRenderer();
FxRenderer radialScaleWipeRenderer();
FxRenderer lightWipeRenderer();
FxRenderer jawsRenderer();
FxRenderer lineSweepRenderer();
FxRenderer irisWipeRenderer();
FxRenderer blockDissolveRenderer();
/** box_blur.cpp */
FxRenderer boxBlurRenderer();
/** channel.cpp */
FxRenderer setChannelsRenderer();
FxRenderer channelCombinerRenderer();
FxRenderer arithmeticRenderer();
FxRenderer compoundArithmeticRenderer();
FxRenderer blendRenderer();
FxRenderer calculationsRenderer();
FxRenderer solidCompositeRenderer();
FxRenderer ccCompositeRenderer();
FxRenderer growBoundsRenderer();
FxRenderer cineonRenderer();
FxRenderer companderRenderer();
FxRenderer hdrToneMapRenderer();
/** deep_glow.cpp */
FxRenderer deepGlowRenderer();
/** generate.cpp */
FxRenderer checkerboardRenderer();
FxRenderer circleRenderer();
FxRenderer gridRenderer();
FxRenderer ellipseRenderer();
FxRenderer beamRenderer();
FxRenderer lightSweepRenderer();
/** simple.cpp */
FxRenderer fillRenderer();
FxRenderer polarRenderer();
FxRenderer mirrorRenderer();
FxRenderer rampRenderer();
/** stylize.cpp */
FxRenderer strobeRenderer();
FxRenderer thresholdRenderer();
FxRenderer thresholdRgbRenderer();
FxRenderer findEdgesRenderer();
FxRenderer embossRenderer();
FxRenderer colorEmbossRenderer();
FxRenderer repeTileRenderer();
FxRenderer kaleidaRenderer();
FxRenderer hexTileRenderer();
FxRenderer blockLoadRenderer();

}  // namespace aevk
