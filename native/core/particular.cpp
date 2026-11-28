/**
 * Trapcode Particular's look-alike as particles: a port of src/render/effects/particularSim.ts, held to it by
 * scripts/reports/native-parity.ts. Its random numbers, emission tables and the order it draws them in follow the
 * TypeScript step for step, so both planners give the engine the same splats.
 */
#include "particular.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <string>

#include "evaluate.h"
#include "transform.h"

namespace aep
{

namespace
{

const f64 PI = 3.14159265358979323846;
const f64 INF = std::numeric_limits<f64>::infinity();

const f64 EMITTER_BOX = 2;
const f64 EMITTER_SPHERE = 3;
const f64 DIRECTION_UNIFORM = 1;
const f64 DIRECTION_DIRECTIONAL = 2;
const f64 DIRECTION_BIDIRECTIONAL = 3;
const f64 DIRECTION_DISC = 4;
const f64 DIRECTION_OUTWARDS = 5;
const f64 SIZE_LINKED = 1;
const f64 DOF_OFF = 1;
const f64 TYPE_SPHERE = 1;
const f64 TYPE_GLOW_SPHERE = 2;
const f64 TYPE_STAR = 3;
const f64 TYPE_SPRITE = 6;
const f64 TYPE_POLYGON_FILL = 11;
const f64 TYPE_CIRCLE = 13;
/** Circle of confusion (comp pixels) of a particle twice the focal distance away: fitted, not Particular's own. */
const f64 DOF_APERTURE = 15;
const f64 BLEND_ADD = 2;
const f64 BLEND_SCREEN = 3;
const f64 BLEND_LIGHTEN = 4;
const u32 SIZE_OVER_LIFE = 569;
const u32 OPACITY_OVER_LIFE = 570;
/** Samples of an over Life curve, and where they start in its data (particularCurves.ts). */
const size_t CURVE_SAMPLES = 201;
const size_t CURVE_AT = 28;

/** A number as JavaScript's `| 0` makes it: truncated, modulo 2^32, as a signed 32-bit integer. */
u32 ToUint32(f64 v)
{
	if (!std::isfinite(v))
	{
		return 0;
	}
	const f64 t = std::trunc(v);
	f64 m = std::fmod(t, 4294967296.0);
	if (m < 0)
	{
		m += 4294967296.0;
	}
	return u32(m);
}

/** Deterministic uniform random numbers in [0, 1) (random in particularSim.ts). */
class CRandom
{
public:
	explicit CRandom(u32 seed) : m_uState(seed ? seed : 1) {}

	f64 Next()
	{
		m_uState += 0x6d2b79f5u;
		u32 t = m_uState;
		t = (t ^ (t >> 15)) * (t | 1u);
		t ^= t + (t ^ (t >> 7)) * (t | 61u);
		return f64(t ^ (t >> 14)) / 4294967296.0;
	}

private:
	u32 m_uState;
};

/** A random unit vector (uniformDirection). */
sVec3 UniformDirection(CRandom& rand)
{
	const f64 z = rand.Next() * 2 - 1;
	const f64 a = rand.Next() * 2 * PI;
	const f64 r = std::sqrt(1 - z * z);
	return { r * std::cos(a), r * std::sin(a), z };
}

CMat4 Rotation(f64 x, f64 y, f64 z)
{
	return CMat4::RotateX(x) * CMat4::RotateY(y) * CMat4::RotateZ(z);
}

/** An effect parameter by declared index (effectProperty): the first property named "<effect>-000n". */
const CPropertyNode* Param(const CPropertyNode& effect, u32 index)
{
	char suffix[8];
	std::snprintf(suffix, sizeof(suffix), "-%04u", unsigned(index));
	const std::string name = effect.m_MatchName + suffix;
	for (const auto& child : effect.m_Children)
	{
		if (child->m_MatchName == name)
		{
			return child->m_bGroup ? nullptr : child.get();
		}
	}
	return nullptr;
}

/** Reading the effect's parameters at a time, as effectNumber and effectVector do. */
class CParams
{
public:
	CParams(const CPropertyNode& effect, const CLayer& layer) : m_Effect(effect), m_Layer(layer) {}

	f64 Number(u32 index, f64 time, f64 fallback) const
	{
		const CPropertyNode* prop = Param(m_Effect, index);
		if (!prop)
		{
			return fallback;
		}
		const CValue v = CurrentValue(*prop, time, m_Layer, &m_Effect);
		if (v.IsNumber())
		{
			return v.m_V[0];
		}
		return v.IsVector() && v.m_uCount ? v.m_V[0] : fallback;
	}

	/** Three components of a vector parameter; missing ones are NaN, as an array read past its end makes them. */
	sVec3 Vector(u32 index, f64 time, const sVec3& fallback) const
	{
		const CPropertyNode* prop = Param(m_Effect, index);
		if (!prop)
		{
			return fallback;
		}
		const CValue v = CurrentValue(*prop, time, m_Layer, &m_Effect);
		if (!v.IsNumeric())
		{
			return fallback;
		}
		const f64 nan = std::numeric_limits<f64>::quiet_NaN();
		return { v.At(0, nan), v.At(1, nan), v.At(2, nan) };
	}

	bool Animated(u32 index) const
	{
		const CPropertyNode* prop = Param(m_Effect, index);
		return prop && (!prop->m_Keyframes.empty() || prop->m_bExpressionEnabled);
	}

private:
	const CPropertyNode& m_Effect;
	const CLayer& m_Layer;
};

/**
 * Particles emitted since time 0 (real seconds), the integral of a rate that may be animated, built in steps of
 * `step` seconds and extended as later times are asked for (Emission).
 */
template <typename Rate>
class CEmission
{
public:
	CEmission(Rate rate, f64 step) : m_Rate(rate), m_fStep(step), m_Cumulative(1, 0.0) {}

	/** Particles emitted from 0 to `t`. */
	f64 At(f64 t)
	{
		if (t <= 0)
		{
			return 0;
		}
		const f64 k = std::floor(t / m_fStep);
		if (!std::isfinite(k))
		{
			return INF;
		}
		const size_t i = size_t(k);
		Extend(i + 1);
		return m_Cumulative[i] + (m_Cumulative[i + 1] - m_Cumulative[i]) * (t / m_fStep - k);
	}

	/** The time by which `count` particles have been emitted (infinity when never). */
	f64 TimeOf(f64 count, f64 limit)
	{
		if (count <= 0)
		{
			return 0;
		}
		size_t lo = 0;
		size_t hi = size_t(std::max(1.0, std::ceil(limit / m_fStep) + 1));
		Extend(hi);
		if (m_Cumulative[hi] < count)
		{
			return INF;
		}
		while (hi - lo > 1)
		{
			const size_t mid = (lo + hi) >> 1;
			if (m_Cumulative[mid] < count)
			{
				lo = mid;
			}
			else
			{
				hi = mid;
			}
		}
		const f64 a = m_Cumulative[lo];
		const f64 b = m_Cumulative[hi];
		return (f64(lo) + (b > a ? (count - a) / (b - a) : 0)) * m_fStep;
	}

private:
	void Extend(size_t index)
	{
		if (index < m_Cumulative.size())
		{
			return;
		}
		f64 previous = m_Rate(f64(m_Cumulative.size() - 1) * m_fStep);
		for (size_t k = m_Cumulative.size(); k <= index; k++)
		{
			const f64 rate = m_Rate(f64(k) * m_fStep);
			m_Cumulative.push_back(m_Cumulative[k - 1] + ((previous + rate) / 2) * m_fStep);
			previous = rate;
		}
	}

	Rate m_Rate;
	f64 m_fStep;
	std::vector<f64> m_Cumulative;
};

template <typename Rate>
CEmission<Rate> MakeEmission(Rate rate, f64 step)
{
	return CEmission<Rate>(rate, step);
}

/** An over Life curve's samples (overLifeCurve), empty when the effect stores none. */
std::vector<f64> OverLifeCurve(const CPropertyNode& effect, u32 index)
{
	char suffix[8];
	std::snprintf(suffix, sizeof(suffix), "-%04u", unsigned(index));
	const auto found = effect.m_InstanceData.find(effect.m_MatchName + suffix);
	std::vector<f64> samples;
	if (found == effect.m_InstanceData.end() || found->second.size() < CURVE_AT + CURVE_SAMPLES * 4)
	{
		return samples;
	}
	for (size_t i = 0; i < CURVE_SAMPLES; i++)
	{
		const u8* b = found->second.data() + CURVE_AT + i * 4;
		const u32 bits = u32(b[0]) | u32(b[1]) << 8 | u32(b[2]) << 16 | u32(b[3]) << 24;
		float v;
		static_assert(sizeof v == sizeof bits, "float is 32 bits");
		std::memcpy(&v, &bits, 4);
		samples.push_back(v);
	}
	return samples;
}

/** A curve's value at life share `u`, 1 without a curve (sampleCurve). */
f64 SampleCurve(const std::vector<f64>& curve, f64 u)
{
	if (curve.empty())
	{
		return 1;
	}
	const f64 x = std::max(0.0, std::min(1.0, u)) * f64(CURVE_SAMPLES - 1);
	const size_t i = std::min(CURVE_SAMPLES - 2, size_t(std::floor(x)));
	return std::max(0.0, curve[i] + (curve[i + 1] - curve[i]) * (x - f64(i)));
}

/** Appends a disc, opaque out to `inner` and fading to zero at `outer` (splat). */
void Splat(std::vector<f64>& out, f64 cx, f64 cy, f64 inner, f64 outer, f64 opacity)
{
	/** Dots below a pixel keep their area as fainter one-pixel dots. */
	const f64 r = std::max(outer, 0.75);
	opacity *= std::min(1.0, std::pow(outer / r, 2));
	if (opacity > 0)
	{
		out.insert(out.end(), { cx, cy, r, std::min(inner, r), opacity });
	}
}

/** A splat widened by `blur` on both sides of its falloff, keeping its light (defocused). */
void Defocused(std::vector<f64>& out, f64 cx, f64 cy, f64 inner, f64 outer, f64 opacity, f64 blur)
{
	if (blur <= 0)
	{
		Splat(out, cx, cy, inner, outer, opacity);
		return;
	}
	const auto light = [](f64 i, f64 o) { return i * i + i * o + o * o; };
	const f64 i2 = std::max(0.0, inner - blur);
	const f64 o2 = outer + blur;
	Splat(out, cx, cy, i2, o2, opacity * std::min(1.0, light(inner, outer) / light(i2, o2)));
}

/** A particle as it is drawn: depth, place, size, defocus and visibility. */
struct sParticle
{
	f64 m_fZ;
	f64 m_fX;
	f64 m_fY;
	f64 m_fRadius;
	f64 m_fBlur;
	f64 m_fSeen;
};

u32 BlendMode(f64 mode)
{
	return mode == BLEND_ADD ? 2 : mode == BLEND_SCREEN ? 3 : mode == BLEND_LIGHTEN ? 4 : 1;
}

} /** namespace */

bool ParticularSplats(const CPropertyNode& effect, const CLayer& layer, const CItem& comp, f64 time, f64 width, f64 height,
	sParticularSplats& out)
{
	const CParams params(effect, layer);
	const auto num = [&](u32 index, f64 fallback) { return params.Number(index, time, fallback); };
	const f64 compW = comp.m_fWidth;
	const f64 compH = comp.m_fHeight;

	const f64 particleType = num(26, TYPE_SPHERE);
	if (particleType >= TYPE_SPRITE && particleType <= TYPE_POLYGON_FILL)
	{
		return false;
	}
	const f64 rate = std::max(0.0, num(146, 100));
	const f64 emitterType = num(5, 1);
	const f64 direction = num(113, DIRECTION_UNIFORM);
	const f64 spread = std::max(0.0, std::min(100.0, num(10, 20))) / 100;
	const CMat4 emitterRotation = Rotation(num(112, 0), num(111, 0), num(76, 0));
	const bool linked = num(577, SIZE_LINKED) == SIZE_LINKED;
	const f64 sizeX = num(14, 50);
	const f64 boxSize[3] = { sizeX, linked ? sizeX : num(15, 50), linked ? sizeX : num(16, 50) };
	const f64 velocity = num(11, 100);
	const f64 velocityRandom = num(12, 20) / 100;
	const f64 life = std::max(0.0, num(2, 3));
	const f64 lifeRandom = std::min(1.0, num(65, 0) / 100);
	const f64 particleSize = std::max(0.0, num(27, 4));
	const f64 sizeRandom = std::min(1.0, num(74, 0) / 100);
	const f64 opacity = num(33, 100) / 100;
	const f64 opacityRandom = std::min(1.0, num(75, 0) / 100);
	const f64 feather = num(29, 50) / 100;
	const f64 particleBlend = num(69, 1);
	const f64 glowBlend = num(218, 1);
	const bool glows = particleType != TYPE_SPHERE;
	const f64 glowSize = num(215, 300) / 100;
	const f64 glowOpacity = glows ? num(216, 25) / 100 : 0;
	const f64 glowFeather = std::max(0.0, std::min(100.0, num(217, 100))) / 100;
	const sVec3 color = params.Vector(70, time, { 1, 1, 1 });
	const f64 timeFactor = num(25, 1);
	const f64 gravity = num(17, 0);
	const f64 wind[3] = { num(22, 0), num(23, 0), num(24, 0) };
	const f64 seed = num(230, 100000);
	const f64 preRun = std::max(0.0, num(227, 0)) / 100;
	/** Glow Sphere, Star and Circle are the "No DOF" particle types, regardless of the rendering setting. */
	const bool noDof = particleType == TYPE_GLOW_SPHERE || particleType == TYPE_STAR || particleType == TYPE_CIRCLE;
	const f64 aperture = noDof || num(319, DOF_OFF) == DOF_OFF ? 0 : DOF_APERTURE;
	const f64 farVanish = num(100, 20000);
	const f64 farFade = num(102, 19000);
	const f64 nearFade = num(103, 10);
	const f64 nearVanish = num(105, 1);
	const auto visibility = [&](f64 z) {
		const f64 nearShare = nearFade > nearVanish ? (z - nearVanish) / (nearFade - nearVanish) : z >= nearVanish ? 1 : 0;
		const f64 farShare = farVanish > farFade ? (farVanish - z) / (farVanish - farFade) : z <= farVanish ? 1 : 0;
		return std::max(0.0, std::min({ 1.0, nearShare, farShare }));
	};
	const std::vector<f64> sizeOverLife = OverLifeCurve(effect, SIZE_OVER_LIFE);
	const std::vector<f64> opacityOverLife = OverLifeCurve(effect, OPACITY_OVER_LIFE);

	/** Particle space -> comp space: World Transform rotates about the comp centre, then offsets. */
	const f64 cx = compW / 2;
	const f64 cy = compH / 2;
	const CMat4 world = CMat4::Translation(cx + num(293, 0), cy + num(294, 0), num(295, 0)) * Rotation(num(290, 0), num(291, 0), num(292, 0)) *
		CMat4::Translation(-cx, -cy, 0);
	const sCamera camera = CameraAt(comp, time, ActiveCameraLayer(comp, time));
	CMat4 toCamera;
	camera.m_Rotation.Inverse(toCamera);
	/** Particular draws in comp space; a layer that is not comp-sized is centred on it. */
	const f64 shiftX = (width - compW) / 2;
	const f64 shiftY = (height - compH) / 2;

	const f64 fps = comp.m_fFrameRate != 0 && !std::isnan(comp.m_fFrameRate) ? comp.m_fFrameRate : 24;
	const f64 step = 1 / fps;
	const auto emitterPosition = [&](f64 t) {
		const f64 frame = JsRound(t * fps);
		return params.Vector(581, frame / fps, { cx, cy, 0 });
	};

	/**
	 * Physics Time Factor runs the whole simulation slower or faster; Pre Run runs `preRun · life` seconds before time 0
	 * at the rate and time factor of time 0. An animated rate or factor accumulates (Emission).
	 */
	const bool animatedRate = params.Animated(146);
	const bool animatedFactor = params.Animated(25);
	const f64 startRate = animatedRate ? std::max(0.0, params.Number(146, 0, 0)) : rate;
	const auto rateAt = [&](f64 t) { return std::max(0.0, params.Number(146, t, 0)); };
	const auto factorAt = [&](f64 t) { return std::max(0.0, params.Number(25, t, 1)); };
	auto sim = MakeEmission(factorAt, step);
	auto births = MakeEmission([&](f64 t) { return rateAt(t) * factorAt(t); }, step);
	auto emission = MakeEmission(rateAt, step);

	f64 nowSim = 0;
	f64 first = 0;
	f64 last = 0;
	f64 preRunCount = 0;
	const f64 simFactor = std::max(timeFactor, 1e-3);
	const f64 preRunSeconds = preRun * life;
	if (animatedFactor)
	{
		preRunCount = preRun * life * std::max(0.0, params.Number(25, 0, 1)) * startRate;
		nowSim = sim.At(time);
		const f64 oldest = nowSim - life;
		const f64 before = oldest < 0 ? preRunCount + oldest * startRate : preRunCount + births.At(sim.TimeOf(oldest, time));
		first = std::max(0.0, std::floor(before) - 1);
		last = std::floor(preRunCount + births.At(time) + 1e-6);
	}
	else
	{
		const auto emitted = [&](f64 t) {
			return simFactor * (std::max(0.0, std::min(t, 0.0) + preRunSeconds) * startRate + (animatedRate ? emission.At(t) : rate * std::max(0.0, t)));
		};
		preRunCount = simFactor * preRunSeconds * startRate;
		nowSim = time * simFactor;
		first = std::max(0.0, std::floor(emitted(time - life / simFactor)) - 1);
		last = std::floor(emitted(time) + 1e-6);
	}
	/** Real and simulation birth times of particle i (real time is never before 0). */
	const auto birthOf = [&](f64 i, f64& real, f64& simulated) {
		if (animatedFactor)
		{
			if (i < preRunCount)
			{
				real = 0;
				simulated = (i - preRunCount) / startRate;
				return;
			}
			real = births.TimeOf(i - preRunCount, time);
			simulated = std::isfinite(real) ? sim.At(real) : real;
			return;
		}
		const f64 remaining = i / simFactor - preRunSeconds * startRate;
		const f64 r = i < preRunCount ? i / (simFactor * startRate) - preRunSeconds
			: animatedRate         ? emission.TimeOf(remaining, time)
								   : remaining / std::max(rate, 1e-9);
		real = std::max(0.0, r);
		simulated = r * simFactor;
	};

	const u32 seedBits = ToUint32(seed) * 2654435761u;
	std::vector<sParticle> particles;
	for (f64 i = first; i <= last && (rate > 0 || animatedRate); i++)
	{
		f64 birthReal = 0;
		f64 birthSim = 0;
		birthOf(i, birthReal, birthSim);
		if (!std::isfinite(birthSim))
		{
			break;
		}
		const f64 age = nowSim - birthSim;
		CRandom rand(seedBits ^ (ToUint32(i + 1) * 0x9e3779b1u));
		const f64 lifeSpan = life * (1 - lifeRandom * 0.5 * rand.Next());
		if (age < 0 || age > lifeSpan)
		{
			continue;
		}
		sVec3 offset;
		if (emitterType == EMITTER_BOX)
		{
			offset.x = (rand.Next() - 0.5) * boxSize[0];
			offset.y = (rand.Next() - 0.5) * boxSize[1];
			offset.z = (rand.Next() - 0.5) * boxSize[2];
		}
		else if (emitterType == EMITTER_SPHERE)
		{
			const sVec3 d = UniformDirection(rand);
			offset.x = (d.x * std::cbrt(rand.Next()) * boxSize[0]) / 2;
			offset.y = (d.y * std::cbrt(rand.Next()) * boxSize[1]) / 2;
			offset.z = (d.z * std::cbrt(rand.Next()) * boxSize[2]) / 2;
		}
		sVec3 dir;
		if (direction == DIRECTION_DIRECTIONAL || direction == DIRECTION_BIDIRECTIONAL)
		{
			const sVec3 cone = UniformDirection(rand);
			const f64 sign = direction == DIRECTION_BIDIRECTIONAL && rand.Next() < 0.5 ? -1 : 1;
			dir = emitterRotation.TransformVector({ cone.x * spread, cone.y * spread, sign });
		}
		else if (direction == DIRECTION_DISC)
		{
			const f64 a = rand.Next() * 2 * PI;
			const f64 c = std::cos(a);
			const f64 s = std::sin(a);
			dir = emitterRotation.TransformVector({ c, s, (rand.Next() * 2 - 1) * spread });
		}
		else if (direction == DIRECTION_OUTWARDS)
		{
			dir = offset.x != 0 || offset.y != 0 || offset.z != 0 ? offset : UniformDirection(rand);
		}
		else
		{
			dir = UniformDirection(rand);
		}
		const f64 speed = std::max(0.0, velocity * (1 + velocityRandom * (rand.Next() * 2 - 1)));
		const f64 lifeShare = lifeSpan > 0 ? age / lifeSpan : 0;
		const f64 pSize = particleSize * (1 + sizeRandom * (rand.Next() - 0.5)) * SampleCurve(sizeOverLife, lifeShare);
		const f64 pOpacity = opacity * (1 - opacityRandom * rand.Next()) * SampleCurve(opacityOverLife, lifeShare);
		f64 norm = std::hypot(dir.x, dir.y, dir.z);
		if (norm == 0 || std::isnan(norm))
		{
			norm = 1;
		}
		const f64 t = age;
		const sVec3 origin = emitterPosition(birthReal);
		const sVec3 box = emitterRotation.TransformVector(offset);
		const sVec3 local = {
			origin.x + box.x + (dir.x / norm) * speed * t + wind[0] * t,
			origin.y + box.y + (dir.y / norm) * speed * t + wind[1] * t + 0.5 * gravity * t * t,
			origin.z + box.z + (dir.z / norm) * speed * t + wind[2] * t,
		};
		const sVec3 p = world.TransformPoint(local);
		const sVec3 view = toCamera.TransformVector({ p.x - camera.m_Position.x, p.y - camera.m_Position.y, p.z - camera.m_Position.z });
		/** As `view[2] <= 1` reads in TypeScript: NaN goes on. */
		if (view.z <= 1)
		{
			continue;
		}
		const f64 seen = pOpacity * visibility(view.z);
		const f64 scale = camera.m_fZoom / view.z;
		const f64 sx = cx + view.x * scale + shiftX;
		const f64 sy = cy + view.y * scale + shiftY;
		/** Out of the focal plane a particle spreads over its circle of confusion, keeping its light. */
		const f64 blur = (aperture * std::fabs(view.z - camera.m_fZoom)) / view.z / 2;
		/** Size is the radius of a sphere. */
		const f64 r = pSize * scale;
		const f64 reach = r * (glows ? std::max(glowSize, 1.0) : 1) + 1 + blur;
		if (seen <= 0 || sx + reach < 0 || sy + reach < 0 || sx - reach > width || sy - reach > height)
		{
			continue;
		}
		particles.push_back({ view.z, sx, sy, r, blur, seen });
	}
	/** Normal particles are laid over each other far to near. */
	std::stable_sort(particles.begin(), particles.end(), [](const sParticle& a, const sParticle& b) { return a.m_fZ > b.m_fZ; });

	for (const sParticle& p : particles)
	{
		/** A disc of radius R and feather f is full out to (R + 0.5)(1 - f) - 3 px and gone at R + 0.5 (particularSplats). */
		const auto inner = [](f64 radius, f64 f) { return std::max(0.0, (radius + 0.5) * (1 - f) - 3); };
		if (glows)
		{
			const f64 radius = p.m_fRadius * glowSize;
			Defocused(out.m_Glow, p.m_fX, p.m_fY, inner(radius, glowFeather), radius + 0.5, p.m_fSeen * glowOpacity, p.m_fBlur);
		}
		Defocused(out.m_Core, p.m_fX, p.m_fY, inner(p.m_fRadius, feather), p.m_fRadius + 0.5, p.m_fSeen, p.m_fBlur);
	}
	out.m_Color[0] = std::isnan(color.x) ? 1 : color.x;
	out.m_Color[1] = std::isnan(color.y) ? 1 : color.y;
	out.m_Color[2] = std::isnan(color.z) ? 1 : color.z;
	out.m_uGlowBlend = BlendMode(glowBlend);
	out.m_uParticleBlend = BlendMode(particleBlend);
	return true;
}

} /** namespace aep */
