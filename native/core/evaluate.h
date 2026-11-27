/**
 * Property evaluation at a point in time (src/aep/evaluate.ts): keyframe interpolation with After Effects' temporal
 * ease, spatial motion paths, roving keys, path morphing, gradient blending and Orientation slerp. Values are the
 * pre-expression values; expressions are evaluated by a later milestone (M3).
 */
#pragma once

#include "model.h"

namespace aep
{

/** Up to four eases: one per value dimension, or one for the whole value. */
struct sEaseList
{
	static const u32 MAX = 4;

	u8 m_uCount = 0;
	sEase m_Eases[MAX];

	const sEase& At(u32 i) const { return m_Eases[i < m_uCount ? i : 0]; }
};

/** What interpolation needs about a keyed property, worked out once (evaluate.ts `prepare`). */
struct sPrepared
{
	enum eKind : u8
	{
		KIND_PLAIN,
		KIND_SHAPE,
		KIND_ORIENTATION,
		KIND_GRADIENT,
	};

	std::vector<sEaseList> m_InEase;
	std::vector<sEaseList> m_OutEase;
	bool m_bMotionPath = false;
	eKind m_eKind = KIND_PLAIN;
	/** A dimension that never animates (Scale Z of a 2D layer), or -1. */
	s32 m_iInert = -1;
};

/** Composition seconds to the layer's own seconds, the axis keyframe eases are defined on. */
f64 LayerTimeAt(const CLayer& layer, f64 compTime);

/**
 * The value of `prop` (a property of `layer`) at composition time `compTime`, before expressions. `siblings` is the
 * group holding `prop`, needed for a Position whose dimensions are separated.
 */
CValue ValueAtTime(const CPropertyNode& prop, f64 compTime, const CLayer& layer, const CPropertyNode* siblings = nullptr);

/** `Math.hypot` as V8 computes it (scaled, Kahan-summed), so lengths match the TypeScript planner's. */
f64 Hypot(const f64* values, u32 count);
f64 Hypot2(f64 x, f64 y);

/** `Math.round`: halves go up. */
f64 JsRound(f64 v);

} /** namespace aep */
