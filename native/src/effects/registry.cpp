/** Effect renderers by match name: the effects native/src/effects/list.inc names that draw something. */
#include <cstring>

#include "../fx.h"
#include "effects.h"

namespace aevk {

FxRenderer fxRenderer(const std::string& matchName) {
  struct Entry {
    const char* matchName;
    FxRenderer (*renderer)();
  };
  static const Entry entries[] = {
      {"ADBE AudSpect", audioSpectrumRenderer},
      {"ADBE Box Blur2", boxBlurRenderer},
      {"ADBE Channel Blur", channelBlurRenderer},
      {"CS CrossBlur", crossBlurRenderer},
      {"ADBE Strobe", strobeRenderer},
      {"PEDG2", deepGlowRenderer},
      {"ADBE Checkerboard", checkerboardRenderer},
      {"ADBE Circle", circleRenderer},
      {"ADBE Grid", gridRenderer},
      {"ADBE ELLIPSE", ellipseRenderer},
      {"ADBE Laser", beamRenderer},
      {"CC Light Sweep", lightSweepRenderer},
      {"ADBE Fill", fillRenderer},
      {"ADBE Polar Coordinates", polarRenderer},
      {"ADBE Mirror", mirrorRenderer},
      {"ADBE Ramp", rampRenderer},
      {"CC Threshold", thresholdRenderer},
      {"CC Threshold RGB", thresholdRgbRenderer},
      {"ADBE Find Edges", findEdgesRenderer},
      {"ADBE Emboss", embossRenderer},
      {"ADBE Color Emboss", colorEmbossRenderer},
      {"CC RepeTile", repeTileRenderer},
      {"CC Kaleida", kaleidaRenderer},
      {"CS HexTile", hexTileRenderer},
      {"CS BlockLoad", blockLoadRenderer},
      {"ADBE Set Channels", setChannelsRenderer},
      {"ADBE Channel Combiner", channelCombinerRenderer},
      {"ADBE Arithmetic", arithmeticRenderer},
      {"ADBE Compound Arithmetic", compoundArithmeticRenderer},
      {"ADBE Blend", blendRenderer},
      {"ADBE Calculations", calculationsRenderer},
      {"ADBE Solid Composite", solidCompositeRenderer},
      {"CC Composite", ccCompositeRenderer},
      {"ADBE GROW BOUNDS", growBoundsRenderer},
      {"ADBE Cineon Converter2", cineonRenderer},
      {"ADBE Compander", companderRenderer},
      {"ADBE HDR ToneMap", hdrToneMapRenderer},
  };
  for (const Entry& e : entries)
    if (matchName == e.matchName) return e.renderer();
  return nullptr;
}

}  // namespace aevk
