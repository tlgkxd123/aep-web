/**
 * Trapcode Particular's look-alike as particles (src/render/effects/particularSim.ts): the seeded system the WebGL
 * renderer draws, worked out by the planner so the engine only lays the splats down.
 */
#pragma once

#include <vector>

#include "model.h"

namespace aep
{

/** One frame of dot particles, as the engine draws them (aevk::EffectParticles). */
struct sParticularSplats
{
	/** Glow halos then particles, far to near: cx, cy, outer, inner, opacity each (SPLAT_FLOATS). */
	std::vector<f64> m_Glow;
	std::vector<f64> m_Core;
	f64 m_Color[3] = { 1, 1, 1 };
	/** Particular's blend modes between halos and between particles: 1 normal, 2 add, 3 screen, 4 lighten. */
	u32 m_uGlowBlend = 1;
	u32 m_uParticleBlend = 1;
};

/**
 * Particular's splats at comp time `time` on its layer's image (`width` x `height`) in `comp` (particularFrame and
 * particularSplats); false when its particles are textured (sprites and polygons), which the engine does not draw yet.
 */
bool ParticularSplats(const CPropertyNode& effect, const CLayer& layer, const CItem& comp, f64 time, f64 width, f64 height,
	sParticularSplats& out);

} /** namespace aep */
