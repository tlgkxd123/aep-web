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
      {"ADBE Box Blur2", boxBlurRenderer},
      {"ADBE Strobe", strobeRenderer},
      {"PEDG2", deepGlowRenderer},
  };
  for (const Entry& e : entries)
    if (matchName == e.matchName) return e.renderer();
  return nullptr;
}

}  // namespace aevk
