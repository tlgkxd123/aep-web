/**
 * Trapcode Particular's look-alike (tc Particular), as src/render/effects/particular.ts draws its dot particles: the
 * planner works the particles out (native/core/particular.cpp) and the plan carries their splats, which are laid down
 * here with the effect's own shaders, glow halos first, each set with its blend mode. Textured particles (sprites,
 * polygons) are left to WebGL by the planners.
 */
#include <algorithm>
#include <vector>

#include "effects.h"

namespace aevk {
namespace {

/** Texels a row of the splat data holds: two per splat. */
constexpr uint32_t kDataWidth = 4096;

FxBlend blendOf(uint32_t mode) {
  return mode == 2 ? FxBlend::Add : mode == 3 ? FxBlend::Screen : mode == 4 ? FxBlend::Max : FxBlend::Over;
}

FxImage render(FxImage input, const Effect& effect, const EffectLayer&, FxContext& ctx) {
  ctx.warn("Particular is drawn with a seeded look-alike; particle positions do not match After Effects");
  const int pad = ctx.pad;
  Target* out = ctx.acquire(input.width + 2.0 * pad, input.height + 2.0 * pad);
  ctx.release(input.target);
  input.target = out;
  if (!effect.hasParticles) return input;
  const EffectParticles& particles = effect.particles;
  const uint32_t glowCount = uint32_t(particles.glow.size() / 5);
  const uint32_t coreCount = uint32_t(particles.core.size() / 5);
  const uint32_t splats = glowCount + coreCount;
  if (!splats) return input;

  /** Glow splats then particles, two texels each: cx, cy, outer, inner; opacity. */
  const uint32_t texels = splats * 2;
  const uint32_t width = std::min(texels, kDataWidth);
  const uint32_t height = (texels + width - 1) / width;
  std::vector<float> data(size_t(width) * height * 4, 0.0f);
  const auto put = [&](const std::vector<float>& from, uint32_t first) {
    for (size_t i = 0; i * 5 < from.size(); i++) {
      float* t = &data[(size_t(first) + i) * 8];
      t[0] = from[i * 5];
      t[1] = from[i * 5 + 1];
      t[2] = from[i * 5 + 2];
      t[3] = from[i * 5 + 3];
      t[4] = from[i * 5 + 4];
    }
  };
  put(particles.glow, 0);
  put(particles.core, glowCount);
  Target* splatData = ctx.upload(data.data(), width, height);

  const float w = float(ctx.width(out)), h = float(ctx.height(out));
  const float r = particles.color[0], g = particles.color[1], b = particles.color[2];
  const auto drawOf = [&](uint32_t first, uint32_t count, uint32_t mode) {
    FxDraw d;
    d.vertices = 4;
    d.instances = count;
    d.blend = blendOf(mode);
    d.set = [=](FxUniforms& u) {
      u.i("u_data", 0);
      u.i("u_width", int32_t(width));
      u.i("u_first", int32_t(first));
      u.f("u_size", w, h);
      u.f("u_pad", float(pad));
      u.f("u_color", r, g, b);
    };
    return d;
  };
  std::vector<FxDraw> draws;
  if (glowCount) draws.push_back(drawOf(0, glowCount, particles.glowBlend));
  if (coreCount) draws.push_back(drawOf(glowCount, coreCount, particles.particleBlend));
  FxScissor scissor;
  scissor.x = pad;
  scissor.y = pad;
  scissor.width = input.width;
  scissor.height = input.height;
  ctx.draw(fx::splat, *out, {splatData}, FxBlend::Over, scissor, draws);
  ctx.release(splatData);
  return input;
}

}  // namespace

FxRenderer particularRenderer() { return render; }

}  // namespace aevk
