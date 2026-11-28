/**
 * Keylight 1.2 (keylight.ts): a screen matte from how far each pixel's colour leans toward Screen Colour, with the
 * screen colour despilled out of the foreground. Draws the Final Result, Combined Matte and Status-free Screen Matte
 * views; other views and the unmodelled parameters are drawn as the Final Result and warned about.
 */
#include <array>
#include <cmath>
#include <string>

#include "effects.h"
#include "stock.h"

namespace aevk {
namespace {

/** Keylight's View choices that are drawn. */
enum KeylightView : int32_t { kViewScreenMatte = 5, kViewCombinedMatte = 10, kViewFinalResult = 11 };

/** Keylight's Replace Method choice that clipping is drawn with. */
constexpr int32_t kReplaceSoftColour = 4;

/** A parameter that changes nothing at its neutral value and is not modelled otherwise. */
struct NeutralParam {
  uint32_t index;
  double neutral;
  const char* label;
};

constexpr NeutralParam kNeutral[] = {
  {10, 0, "screen pre-blur"},
  {14, 0, "clip rollback"},
  {15, 0, "screen shrink/grow"},
  {16, 0, "screen softness"},
  {17, 0, "screen despot black"},
  {18, 0, "screen despot white"},
  {36, 0, "foreground colour correction"},
  {52, 0, "edge colour correction"},
  {75, 0, "source crop left"},
  {76, 100, "source crop right"},
  {77, 0, "source crop top"},
  {78, 100, "source crop bottom"},
};

/** Index of the screen colour's strongest channel and the two others, in the order Screen Balance weights them. */
std::array<int32_t, 3> screenChannels(const std::array<float, 3>& s) {
  const int32_t p = s[1] > s[0] && s[1] >= s[2] ? 1 : s[2] > s[0] && s[2] > s[1] ? 2 : 0;
  return {p, (p + 1) % 3, (p + 2) % 3};
}

FxImage keylight(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  int32_t view = int32_t(p.num(2, kViewFinalResult));
  if (view != kViewScreenMatte && view != kViewCombinedMatte && view != kViewFinalResult) {
    ctx.warn("Keylight view " + std::to_string(view) + " is shown as Final Result");
    view = kViewFinalResult;
  }
  const std::array<float, 3> screen = p.rgb(4, {0, 1, 0});
  const double gain = p.num(5, 100) / 100;
  const double clipBlack = p.num(12, 0) / 100;
  const double clipWhite = p.num(13, 100) / 100;
  const int32_t replaceMethod = int32_t(p.num(19, kReplaceSoftColour));
  const std::array<float, 3> replace = p.rgb(20, {0.5f, 0.5f, 0.5f});
  const bool clipped = clipBlack != 0 || clipWhite != 1;
  if (view == kViewFinalResult && clipped && replaceMethod != kReplaceSoftColour)
    ctx.warn("Keylight replace method " + std::to_string(replaceMethod) + " is drawn as Soft Colour");
  for (const NeutralParam& n : kNeutral)
    if (p.num(n.index, n.neutral) != n.neutral) ctx.warn(std::string("Keylight ") + n.label + " is not rendered yet");
  /** Screen Gain scales the screen colour's chroma by the gain and its grey level by the gain squared. */
  const double mean = (double(screen[0]) + screen[1] + screen[2]) / 3;
  std::array<float, 3> gained;
  for (int c = 0; c < 3; c++) gained[c] = float(gain * screen[c] + gain * (gain - 1) * mean);
  const std::array<int32_t, 3> channels = screenChannels(screen);
  return mapPass(ctx, input, fx::keylight, [&](FxUniforms& u) {
    u.i("u_view", view);
    u.i("u_unpremultiply", p.num(3, 1) != 0 ? 1 : 0);
    u.i("u_ignoreAlpha", p.num(28, 3) == 1 ? 1 : 0);
    u.f("u_screen", screen[0], screen[1], screen[2]);
    u.f("u_gainedScreen", gained[0], gained[1], gained[2]);
    u.i("u_channels", channels[0], channels[1], channels[2]);
    u.f("u_gain2", float(gain * gain));
    u.f("u_balance", float(p.num(6, 50) / 100));
    u.f("u_clipBlack", float(clipBlack));
    u.f("u_clipWhite", float(clipWhite));
    u.i("u_softColour", clipped ? 1 : 0);
    u.f("u_replace", replace[0], replace[1], replace[2]);
  });
}

}  // namespace

FxRenderer keylightRenderer() { return keylight; }

}  // namespace aevk
