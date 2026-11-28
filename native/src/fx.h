// What effects (native/src/effects) render with: the engine's FxContext, ported from RenderContext in
// src/render/registry.ts, and the effect shaders of native/src/fx_shaders.inc, which scripts/generate/native-shaders.ts
// converts from the TypeScript effects' GLSL. Effects are written as their TypeScript versions are, pass for pass: a
// shader sees WebGL's coordinates (rows from the bottom), and uniforms and sampler units are set by name.
#pragma once

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <initializer_list>
#include <string>
#include <vector>

#include "plan.h"

namespace aevk {

enum class FxType : uint8_t { Float, Vec2, Vec3, Vec4, Int, IVec2, IVec3, IVec4, UInt, UVec2, UVec3, UVec4, Bool, Mat2, Mat3, Mat4 };

struct FxUniform {
  const char* name;
  FxType type;
  uint32_t count;
  uint32_t offset;
  uint32_t stride;
};

struct FxShader {
  const char* name;
  const uint32_t* code;
  size_t codeBytes;
  const FxUniform* uniforms;
  uint32_t uniformCount;
  /** In binding order. */
  const char* const* samplers;
  uint32_t samplerCount;
  uint32_t paramBytes;
};

}  // namespace aevk

#include "fx_shaders.inc"

namespace aevk {

struct Target;

/** A layer's image in its own pixels (LayerImage in registry.ts): premultiplied, with the kPad border. */
struct FxImage {
  Target* target = nullptr;
  /** Content size without the border. */
  uint32_t width = 0, height = 0;
  /** Layer-space position of the first content pixel. */
  float originX = 0, originY = 0;
  /** Image pixels per layer pixel. */
  float scale = 1;
};

/** Formats of effect targets: the layer images' RGBA8, and floatTargets.ts's RGBA32F (sampled nearest) and RGBA16F (linear). */
enum class FxFormat : uint8_t { Color, Float, Half };

/** Sets a pass's uniforms by name, as gl.uniform* calls do; names the shader does not have are ignored, as WebGL ignores them. */
class FxUniforms {
 public:
  FxUniforms(const FxShader& shader, uint8_t* params, uint32_t* units) : shader_(shader), params_(params), units_(units) {}

  /** uniform1i..4i; on a sampler, the input unit it reads. */
  void i(const char* name, int32_t x);
  void i(const char* name, int32_t x, int32_t y);
  void i(const char* name, int32_t x, int32_t y, int32_t z);
  void i(const char* name, int32_t x, int32_t y, int32_t z, int32_t w);
  void f(const char* name, float x);
  void f(const char* name, float x, float y);
  void f(const char* name, float x, float y, float z);
  void f(const char* name, float x, float y, float z, float w);
  /** uniform{1..4}fv: `count` elements of the array (or vector) named, `components` floats each. */
  void fv(const char* name, const float* values, uint32_t count, uint32_t components = 1);
  void iv(const char* name, const int32_t* values, uint32_t count, uint32_t components = 1);
  /** uniformMatrix{2,3,4}fv without transposing: column-major values. */
  void matrix(const char* name, const float* columns);

 private:
  const FxUniform* find(const char* name) const;
  void write(const char* name, const void* values, uint32_t count, uint32_t components, bool integer);
  const FxShader& shader_;
  uint8_t* params_;
  uint32_t* units_;
};

using FxSetter = std::function<void(FxUniforms&)>;

/** What an effect's layer parameter names (FxContext::source). */
enum class FxSource : uint8_t { None, Empty, Image };

class FxContext {
 public:
  virtual ~FxContext() = default;
  /** Width of the transparent border around every layer image. */
  int pad = kPad;
  /** A target from the pool, transparent when `clear` (as TargetPool.acquire and acquireFloat give them). */
  /** Sizes are rounded up, to at least 1. */
  virtual Target* acquire(double width, double height, FxFormat format = FxFormat::Color, bool clear = true) = 0;
  /** Back to the pool; null is ignored. */
  virtual void release(Target* target) = 0;
  virtual uint32_t width(const Target* target) const = 0;
  virtual uint32_t height(const Target* target) const = 0;
  /** Draws `shader` over all of `out` with `inputs` as units 0..n-1 (ctx.pass). */
  virtual void pass(fx::Id shader, Target& out, std::initializer_list<const Target*> inputs, const FxSetter& set = {}) = 0;
  /** Records something skipped or approximated in this frame. */
  virtual void warn(const std::string& message) = 0;
  /**
   * The layer an effect's layer parameter (declared index `param`) names, as its content alone in its own pixels
   * (ctx.layerImage(other, time, false)): None when it names no other layer, Empty when that layer draws nothing,
   * else Image with `image` a new image the caller releases and `layer` that layer's size and kind.
   */
  virtual FxSource source(const Effect& effect, uint32_t param, FxImage& image, EffectLayer& layer) = 0;
  /** The effect's own layer's content before its masks and effects, a new image the caller releases; false when it draws nothing. */
  virtual bool ownContent(FxImage& image) = 0;
};

/** A number as WebGL's GLint arguments convert it (WebIDL long): truncated, NaN and infinities to 0, modulo 2^32. */
inline int32_t glInt(double v) {
  if (!(v == v) || v - v != 0) return 0;
  const double t = v < 0 ? -std::floor(-v) : std::floor(v);
  const double m = std::fmod(t, 4294967296.0);
  const double u = m < 0 ? m + 4294967296.0 : m;
  return int32_t(uint32_t(u));
}

/** One effect on a layer's image (EffectRenderer); returns a new image and may release `input`. */
using FxRenderer = FxImage (*)(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx);

/** The renderer of an effect the engine draws, or null. */
FxRenderer fxRenderer(const std::string& matchName);

/** An effect's parameter as effectNumber (effectParams.ts) reads it: the first value of the n-th declared parameter. */
double fxNumber(const Effect& effect, uint32_t index, double fallback = 0);
/** effectVector: all of the parameter's values, or `fallback`. */
std::vector<double> fxVector(const Effect& effect, uint32_t index, const std::vector<double>& fallback);

}  // namespace aevk
