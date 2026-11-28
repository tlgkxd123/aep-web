/**
 * The Time effects (Echo, Posterize Time, Time Difference, Time Displacement, CC Wide Time, CC Force Motion Blur), ported from
 * src/render/effects/perspectiveTime.ts with the same shaders. They read their layer at other times through the
 * plan's effect inputs (FxContext::input), which the planners time from the effects' parameters.
 */
#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

#include "effects.h"
#include "stock.h"

namespace aevk {
namespace {

/** Frames one fold pass reads besides its running result, which is source kFoldFrames (nativeFoldDecls). */
constexpr uint32_t kFoldFrames = 7;

/** Math.round. */
double jsRound(double v) { return std::floor(v + 0.5); }

/** The neutral grey of Time Difference's signed result (DIFFERENCE_MID). */
constexpr float kDifferenceMid = 127.0f / 255.0f;

/** A frame to fold: absent when the layer drew nothing then. */
struct Frame {
  bool present = false;
  FxImage image;
  float weight = 0;
};

/** A float running result of foldFrames as an image over `rect` (stateImage). */
FxImage stateImage(Target* state, const FxRect& rect) {
  FxImage image;
  image.target = state;
  image.width = uint32_t(rect.width);
  image.height = uint32_t(rect.height);
  image.originX = float(rect.x);
  image.originY = float(rect.y);
  return image;
}

/**
 * Folds weighted frames into a float running result over `rect`, kFoldFrames a pass, with a fold shader (foldFrames):
 * its step updates the result from vec4(0) with each frame and its weight. Releases the frames.
 */
Target* foldFrames(FxContext& ctx, const FxRect& rect, std::vector<Frame>& frames, fx::Id shader) {
  const double width = rect.width + 2 * ctx.pad;
  const double height = rect.height + 2 * ctx.pad;
  /** Stands in for the samplers a pass leaves unread. */
  Target* spare = ctx.acquire(1, 1, FxFormat::Float, true);
  Target* state = nullptr;
  for (size_t start = 0; start == 0 || start < frames.size(); start += kFoldFrames) {
    const size_t count = std::min<size_t>(kFoldFrames, frames.size() - start);
    FxImage images[kFoldFrames + 1];
    int32_t slots[kFoldFrames];
    float weights[kFoldFrames] = {};
    uint32_t n = 0;
    for (uint32_t i = 0; i < kFoldFrames; i++) {
      slots[i] = -1;
      if (i >= count) continue;
      const Frame& f = frames[start + i];
      weights[i] = f.weight;
      if (f.present) {
        slots[i] = int32_t(n);
        images[n++] = f.image;
      }
    }
    for (uint32_t i = n; i < kFoldFrames; i++) images[i] = stateImage(spare, rect);
    images[kFoldFrames] = stateImage(state ? state : spare, rect);
    Target* next = ctx.acquire(width, height, FxFormat::Float, false);
    const bool first = !state;
    const auto bind = [&](FxUniforms& u) {
      u.f("u_size", float(ctx.width(next)), float(ctx.height(next)));
      u.f("u_pad", float(ctx.pad));
      u.f("u_origin", float(rect.x), float(rect.y));
      for (uint32_t i = 0; i <= kFoldFrames; i++) {
        const std::string img = "u_img" + std::to_string(i);
        u.i(("u_src" + std::to_string(i)).c_str(), int32_t(i));
        u.f((img + "Origin").c_str(), images[i].originX, images[i].originY);
        u.f((img + "Height").c_str(), float(images[i].height));
        u.f((img + "Target").c_str(), float(ctx.width(images[i].target)), float(ctx.height(images[i].target)));
      }
      u.iv("u_slot", slots, kFoldFrames);
      u.fv("u_w", weights, kFoldFrames);
      u.i("u_count", int32_t(count));
      u.i("u_first", first ? 1 : 0);
    };
    ctx.pass(shader, *next,
             {images[0].target, images[1].target, images[2].target, images[3].target, images[4].target, images[5].target, images[6].target,
              images[7].target},
             bind);
    for (size_t i = start; i < start + count; i++)
      if (frames[i].present) ctx.release(frames[i].image.target);
    if (state) ctx.release(state);
    state = next;
  }
  ctx.release(spare);
  return state;
}

/** The folded result clamped to valid premultiplied colour over `rect` (finishPass with CLAMPED); releases `state`. */
FxImage finish(FxContext& ctx, const FxRect& rect, Target* state) {
  const FxImage out = layerPass(ctx, rect, {stateImage(state, rect)}, fx::time_finish);
  ctx.release(state);
  return out;
}

/** The layer at the effect's i-th other time as a frame of `weight`. */
Frame inputFrame(FxContext& ctx, const Effect& effect, uint32_t i, double weight) {
  Frame f;
  f.present = ctx.input(effect, i, f.image);
  f.weight = float(weight);
  return f;
}

/**
 * Echo: the layer at Number of Echoes + 1 times Echo Time apart, the k-th weighted Starting Intensity x Decay^k,
 * stacked from the newest with the blend mode Echo Operator names.
 */
FxImage echo(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double start = std::max(0.0, std::min(1.0, p.num(3, 1)));
  const double decay = std::max(0.0, std::min(1.0, p.num(4, 1)));
  const int32_t chosen = p.choice(5, 1);
  const int32_t op = chosen >= 1 && chosen <= 7 ? chosen : 1;
  static const fx::Id kSteps[7] = {fx::time_echo1, fx::time_echo2, fx::time_echo3, fx::time_echo4, fx::time_echo5, fx::time_echo6, fx::time_echo7};
  const FxRect rect = imageRect(input);
  std::vector<Frame> frames;
  Frame now;
  now.present = true;
  now.image = input;
  now.weight = float(start);
  frames.push_back(now);
  for (uint32_t k = 1; k <= ctx.inputCount(effect); k++) frames.push_back(inputFrame(ctx, effect, k - 1, start * std::pow(decay, double(k))));
  return finish(ctx, rect, foldFrames(ctx, rect, frames, kSteps[op - 1]));
}

/** Posterize Time: the layer held at the last frame of Frame Rate before the time (the plan's one input, when it differs). */
FxImage posterizeTime(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  if (!ctx.inputCount(effect)) return input;
  const FxRect rect = imageRect(input);
  FxImage held;
  if (ctx.input(effect, 0, held)) {
    ctx.release(input.target);
    return held;
  }
  return blankImage(ctx, input, rect);
}

/**
 * Time Difference: the layer minus Target (itself when none) Time Offset later, per straight channel, about a neutral
 * grey or as an absolute value, with the alpha Alpha Channel says.
 */
FxImage timeDifference(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double contrast = p.num(3, 50);
  const bool absolute = p.flag(4, false);
  const double alpha = p.num(5, 1);
  FxImage other;
  EffectLayer info;
  bool hasOther = false;
  switch (ctx.source(effect, 1, other, info)) {
    case FxSource::Image: hasOther = true; break;
    case FxSource::Empty: break;
    case FxSource::None: hasOther = ctx.inputCount(effect) && ctx.input(effect, 0, other); break;
  }
  const FxRect rect = imageRect(input);
  const FxImage out = layerPass(ctx, rect, {input, hasOther ? other : input}, fx::time_difference, [&](FxUniforms& u) {
    u.f("u_contrast", float(contrast));
    u.i("u_absolute", absolute ? 1 : 0);
    u.i("u_alpha", glInt(alpha));
    u.f("u_mid", kDifferenceMid);
    u.i("u_hasTarget", hasOther ? 1 : 0);
  });
  ctx.release(input.target);
  if (hasOther) ctx.release(other.target);
  return out;
}

/**
 * CC Wide Time: a weighted mean of the layer over Backward Steps frames before and Forward Steps frames after the
 * time, the weights falling linearly from the time's to zero one step beyond each end.
 */
FxImage wideTime(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const int32_t forward = int32_t(std::max(0.0, jsRound(p.num(1, 1))));
  const int32_t backward = int32_t(std::max(0.0, jsRound(p.num(2, 1))));
  const auto tent = [&](int32_t k) { return k > 0 ? 1 - double(k) / (forward + 1) : 1 + double(k) / (backward + 1); };
  double total = 0;
  for (int32_t k = -backward; k <= forward; k++) total += tent(k);
  const FxRect rect = imageRect(input);
  std::vector<Frame> frames;
  Frame now;
  now.present = true;
  now.image = input;
  now.weight = float(1 / total);
  frames.push_back(now);
  uint32_t i = 0;
  for (int32_t k = -backward; k <= forward; k++) {
    if (!k) continue;
    if (i < ctx.inputCount(effect)) frames.push_back(inputFrame(ctx, effect, i, tent(k) / total));
    i++;
  }
  return finish(ctx, rect, foldFrames(ctx, rect, frames, fx::time_sum));
}

/** CC Force Motion Blur: the mean of Motion Blur Samples renders of the layer spread over the shutter. */
FxImage forceMotionBlur(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  const FxParams p(effect);
  const double samples = std::max(1.0, jsRound(p.num(1, 8)));
  const FxRect rect = imageRect(input);
  ctx.release(input.target);
  std::vector<Frame> frames;
  for (uint32_t i = 0; i < ctx.inputCount(effect); i++) frames.push_back(inputFrame(ctx, effect, i, 1 / samples));
  return finish(ctx, rect, foldFrames(ctx, rect, frames, fx::time_sum));
}

/** Frames one Time Displacement pass reads besides its map (source 0) and running result (source 7). */
constexpr uint32_t kDisplaceFrames = 6;

/**
 * Time Displacement: each pixel from the layer at the time its Time Displacement Layer pixel's luminance says, from
 * Max Displacement Time back (black) to forward (white), in steps of 1 / Time Resolution; the map stretched over the
 * layer, or at its own size from the layer's corner. The plan's inputs are the map (the layer at the time, when no
 * map layer is named) and then every grid step from the first to the last.
 */
FxImage timeDisplacement(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const double maximum = p.num(2, 1);
  const double resolution = std::max(0.01, p.num(3, 60));
  const bool stretch = p.flag(4, true);
  const FxRect rect = imageRect(input);
  FxImage map;
  EffectLayer info;
  bool hasMap = false;
  uint32_t offset = 0;
  switch (ctx.source(effect, 1, map, info)) {
    case FxSource::Image: hasMap = true; break;
    case FxSource::Empty: break;
    case FxSource::None:
      hasMap = ctx.inputCount(effect) && ctx.input(effect, 0, map);
      offset = 1;
      break;
  }
  if (!hasMap || !maximum) {
    if (hasMap) ctx.release(map.target);
    return input;
  }
  const double time = layer.time;
  const double reach = std::abs(maximum);
  const double first = std::floor((time - reach) * resolution + 1e-6);
  const double last = std::min(first + 1200, std::floor((time + reach) * resolution + 1e-6));
  const double width = rect.width + 2 * ctx.pad;
  const double height = rect.height + 2 * ctx.pad;
  const float mapScale[2] = {stretch ? float(map.width / rect.width) : 1.0f, stretch ? float(map.height / rect.height) : 1.0f};
  Target* spare = ctx.acquire(1, 1, FxFormat::Float, true);
  Target* state = nullptr;
  for (double base = first; base <= last; base += kDisplaceFrames) {
    const uint32_t count = uint32_t(std::min<double>(kDisplaceFrames, last - base + 1));
    FxImage images[kDisplaceFrames + 2];
    images[0] = map;
    int32_t slots[kDisplaceFrames];
    uint32_t n = 1;
    for (uint32_t j = 0; j < kDisplaceFrames; j++) {
      slots[j] = -1;
      if (j >= count) continue;
      const size_t k = offset + size_t(base + j - first);
      if (k >= effect.inputs.size()) continue;
      if (std::abs(effect.inputs[k].time - time) < 1e-6) {
        slots[j] = -2;
      } else if (ctx.input(effect, uint32_t(k), images[n])) {
        slots[j] = int32_t(n++);
      }
    }
    const uint32_t present = n;
    for (; n <= kDisplaceFrames; n++) images[n] = stateImage(spare, rect);
    images[kDisplaceFrames + 1] = stateImage(state ? state : spare, rect);
    Target* next = ctx.acquire(width, height, FxFormat::Float, false);
    const bool firstPass = !state;
    const auto bind = [&](FxUniforms& u) {
      u.f("u_size", float(ctx.width(next)), float(ctx.height(next)));
      u.f("u_pad", float(ctx.pad));
      u.f("u_origin", float(rect.x), float(rect.y));
      for (uint32_t i = 0; i < kDisplaceFrames + 2; i++) {
        const std::string img = "u_img" + std::to_string(i);
        u.i(("u_src" + std::to_string(i)).c_str(), int32_t(i));
        u.f((img + "Origin").c_str(), images[i].originX, images[i].originY);
        u.f((img + "Height").c_str(), float(images[i].height));
        u.f((img + "Target").c_str(), float(ctx.width(images[i].target)), float(ctx.height(images[i].target)));
      }
      u.iv("u_slot", slots, kDisplaceFrames);
      u.i("u_count", int32_t(count));
      u.i("u_base", glInt(base));
      u.i("u_first", firstPass ? 1 : 0);
      u.f("u_mapRect", map.originX, map.originY, mapScale[0], mapScale[1]);
      u.f("u_maximum", float(maximum));
      u.f("u_time", float(time));
      u.f("u_resolution", float(resolution));
    };
    ctx.pass(fx::time_displace, *next,
             {images[0].target, images[1].target, images[2].target, images[3].target, images[4].target, images[5].target, images[6].target,
              images[7].target},
             bind);
    for (uint32_t i = 1; i < present; i++) ctx.release(images[i].target);
    if (state) ctx.release(state);
    state = next;
  }
  ctx.release(spare);
  ctx.release(map.target);
  /** Pixels marked -1 show the layer at the time itself. */
  const FxImage out = layerPass(ctx, rect, {input, stateImage(state, rect)}, fx::time_displace_finish);
  ctx.release(state);
  ctx.release(input.target);
  return out;
}

}  // namespace

FxRenderer timeDisplacementRenderer() { return timeDisplacement; }
FxRenderer echoRenderer() { return echo; }
FxRenderer posterizeTimeRenderer() { return posterizeTime; }
FxRenderer timeDifferenceRenderer() { return timeDifference; }
FxRenderer wideTimeRenderer() { return wideTime; }
FxRenderer forceMotionBlurRenderer() { return forceMotionBlur; }

}  // namespace aevk
