/**
 * Port of src/aep/evaluate.ts, which follows py-aep's resolvers/interpolation.py (MIT,
 * https://github.com/forticheprod/py-aep). The numerics are kept step for step so values match the TypeScript planner.
 */
#include "evaluate.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace aep
{

namespace
{

const f64 DEFAULT_INFLUENCE = 100.0 / 6;
/** AE's arc-length table: 128 samples taken uniformly in the curve parameter. */
const s32 CURVE_SEGMENTS = 128;
const f64 EPS = 1e-10;
/** Below this cos(Y) an Orientation is gimbal-locked and the combined X+Z turn goes on Z. */
const f64 EULER_EPS = 1e-5;
const f64 PI = 3.14159265358979323846;
const f64 RAD2DEG = 180 / PI;
const f64 NaN = std::numeric_limits<f64>::quiet_NaN();

/** A small vector of up to four components, as `number[]` values are. */
struct sVec
{
	u32 m_uCount = 0;
	f64 m_V[CValue::MAX_COMPONENTS] = { 0, 0, 0, 0 };

	/** Component `i`, or NaN past the end (an undefined element in TypeScript arithmetic). */
	f64 At(u32 i) const { return i < m_uCount ? m_V[i] : NaN; }
};

sVec AsVec(const CValue& value)
{
	sVec v;
	v.m_uCount = value.Count();
	for (u32 i = 0; i < v.m_uCount; i++)
	{
		v.m_V[i] = value.m_V[i];
	}
	return v;
}

CValue ToValue(const sVec& v)
{
	return CValue::Vector(v.m_V, v.m_uCount);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Unit-square bezier easing, solved in closed form the way AE does.                                                  */
/* ------------------------------------------------------------------------------------------------------------------ */

inline f64 BezA(f64 a1, f64 a2) { return 1 - 3 * a2 + 3 * a1; }
inline f64 BezB(f64 a1, f64 a2) { return 3 * a2 - 6 * a1; }
inline f64 BezC(f64 a1) { return 3 * a1; }
inline f64 CalcBezier(f64 t, f64 a1, f64 a2) { return ((BezA(a1, a2) * t + BezB(a1, a2)) * t + BezC(a1)) * t; }

/** The root of `a t^3 + b t^2 + c t + d` in [0, 1] that AE picks (Cardano); false when there is none. */
bool SolveCubic(f64 a, f64 b, f64 c, f64 d, f64& out)
{
	f64 root;
	if (std::fabs(a) >= EPS)
	{
		const f64 bigA = b / a;
		const f64 q = (bigA * bigA - 3 * (c / a)) / 9;
		const f64 r = (2 * bigA * bigA * bigA - 9 * bigA * (c / a) + 27 * (d / a)) / 54;
		const f64 third = bigA / 3;
		const f64 q3 = q * q * q;
		if (q3 < r * r)
		{
			const f64 sq = std::sqrt(r * r - q3);
			if (r < 0)
			{
				const f64 x = std::pow(sq - r, 1.0 / 3);
				out = q / x + x - third;
				return true;
			}
			const f64 x = std::pow(sq + r, 1.0 / 3);
			out = -x - q / x - third;
			return true;
		}
		if (std::fabs(q) < EPS)
		{
			out = -third;
			return true;
		}
		const f64 theta = std::acos(r / std::sqrt(q3));
		const f64 scale = -2 * std::sqrt(q);
		const f64 first = std::cos(theta / 3) * scale - third;
		if (first > 0 && first < 1)
		{
			out = first;
			return true;
		}
		const f64 second = std::cos((theta + 2 * PI) / 3) * scale - third;
		if (second >= 0 && second <= 1)
		{
			out = second;
			return true;
		}
		root = std::cos((theta + 4 * PI) / 3) * scale - third;
	}
	else
	{
		if (std::fabs(b) < EPS)
		{
			out = std::fabs(c) >= EPS ? -d / c : 0;
			return true;
		}
		const f64 disc = c * c - 4 * b * d;
		if (disc < 0)
		{
			return false;
		}
		if (std::fabs(disc) < EPS)
		{
			out = -c / (2 * b);
			return true;
		}
		const f64 sq = std::sqrt(disc);
		const f64 qQuad = c <= 0 ? sq - c : -(sq + c);
		const f64 first = (2 * d) / qQuad;
		root = qQuad / (2 * b);
		if (first >= 0 && first <= 1)
		{
			out = first;
			return true;
		}
	}
	if (root >= 0 && root <= 1)
	{
		out = root;
		return true;
	}
	return false;
}

class CBezierEasing
{
public:
	CBezierEasing(f64 cx1, f64 cy1, f64 cx2, f64 cy2) : m_fCx1(cx1), m_fCy1(cy1), m_fCx2(cx2), m_fCy2(cy2) {}

	f64 Get(f64 x) const
	{
		if (m_fCx1 == m_fCy1 && m_fCx2 == m_fCy2)
		{
			return x;
		}
		return CalcBezier(ParameterAt(x), m_fCy1, m_fCy2);
	}

	/** The curve parameter whose x-coordinate is `x`; ends snap within EPS. */
	f64 ParameterAt(f64 x) const
	{
		if (x < 0 || std::fabs(x) < EPS)
		{
			return 0;
		}
		if (x > 1 || std::fabs(x - 1) < EPS)
		{
			return 1;
		}
		f64 u;
		return SolveCubic(BezA(m_fCx1, m_fCx2), BezB(m_fCx1, m_fCx2), BezC(m_fCx1), -x, u) ? u : x;
	}

private:
	f64 m_fCx1, m_fCy1, m_fCx2, m_fCy2;
};

/** One temporal bezier dimension; the value handles are absolute so equal-valued keys still bow. */
f64 InterpolateBezier1d(f64 t, f64 t0, f64 t1, f64 v0, f64 v1, const sEase& out, const sEase& inn)
{
	const f64 dt = t1 - t0;
	if (dt == 0)
	{
		return v0;
	}
	const f64 dv = v1 - v0;
	const f64 cx1 = out.m_fInfluence / 100;
	const f64 cx2 = 1 - inn.m_fInfluence / 100;
	const f64 cy1 = std::fabs(dv) > 1e-12 ? (out.m_fSpeed * cx1 * dt) / dv : cx1;
	const f64 cy2 = std::fabs(dv) > 1e-12 ? 1 - (inn.m_fSpeed * (1 - cx2) * dt) / dv : cx2;
	const f64 u = CBezierEasing(cx1, cy1, cx2, cy2).ParameterAt((t - t0) / dt);
	const f64 y1 = v0 + out.m_fSpeed * (out.m_fInfluence / 100) * dt;
	const f64 y2 = v1 - inn.m_fSpeed * (inn.m_fInfluence / 100) * dt;
	const f64 mu = 1 - u;
	return mu * mu * mu * v0 + 3 * mu * mu * u * y1 + 3 * mu * u * u * y2 + u * u * u * v1;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Spatial paths                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

class CBezierPath
{
public:
	CBezierPath(const sVec& v0, const sVec& v1, const sVec& outTangent, const sVec& inTangent)
	{
		m_uDims = v0.m_uCount;
		f64 p1[4], p2[4];
		for (u32 d = 0; d < m_uDims; d++)
		{
			p1[d] = v0.m_V[d] + (d < outTangent.m_uCount ? outTangent.m_V[d] : 0);
			p2[d] = v1.At(d) + (d < inTangent.m_uCount ? inTangent.m_V[d] : 0);
		}
		f64 total = 0;
		for (s32 k = 0; k < CURVE_SEGMENTS; k++)
		{
			const f64 t = f64(k) / (CURVE_SEGMENTS - 1);
			const f64 u = 1 - t;
			sVec point;
			point.m_uCount = m_uDims;
			for (u32 d = 0; d < m_uDims; d++)
			{
				point.m_V[d] = u * u * u * v0.m_V[d] + 3 * u * u * t * p1[d] + 3 * u * t * t * p2[d] + t * t * t * v1.At(d);
			}
			f64 dist = 0;
			if (k > 0)
			{
				f64 delta[4];
				for (u32 d = 0; d < m_uDims; d++)
				{
					delta[d] = point.m_V[d] - m_Points[k - 1].m_V[d];
				}
				dist = Hypot(delta, m_uDims);
			}
			total += dist;
			m_Points[k] = point;
			m_PartialLengths[k] = dist;
		}
		m_fLength = total;
	}

	f64 Length() const { return m_fLength; }

	/** The point at an arc-length fraction, walking the sampled polyline. */
	sVec PointAt(f64 perc) const
	{
		if (perc <= 0)
		{
			return m_Points[0];
		}
		if (perc >= 1)
		{
			return m_Points[CURVE_SEGMENTS - 1];
		}
		const f64 distance = m_fLength * perc;
		f64 added = 0;
		const s32 n = CURVE_SEGMENTS;
		for (s32 j = 0; j < n; j++)
		{
			added += m_PartialLengths[j];
			if (distance == 0 || j == n - 1)
			{
				return m_Points[j];
			}
			if (distance >= added && distance < added + m_PartialLengths[j + 1])
			{
				const f64 seg = (distance - added) / m_PartialLengths[j + 1];
				const sVec& a = m_Points[j];
				const sVec& b = m_Points[j + 1];
				sVec out;
				out.m_uCount = a.m_uCount;
				for (u32 d = 0; d < a.m_uCount; d++)
				{
					out.m_V[d] = a.m_V[d] + (b.m_V[d] - a.m_V[d]) * seg;
				}
				return out;
			}
		}
		return m_Points[n - 1];
	}

private:
	u32 m_uDims = 0;
	sVec m_Points[CURVE_SEGMENTS];
	f64 m_PartialLengths[CURVE_SEGMENTS];
	f64 m_fLength = 0;
};

bool IsZero(const sVec& t)
{
	for (u32 i = 0; i < t.m_uCount; i++)
	{
		if (!(std::fabs(t.m_V[i]) < 1e-12))
		{
			return false;
		}
	}
	return true;
}

/** Ease mapping a time fraction to an arc-length fraction; false for constant progress. */
bool SpatialProgressEasing(f64 dt, f64 arcLength, const sEase& out, const sEase& inn, bool outLinear, bool inLinear,
	CBezierEasing& easing)
{
	if (out.m_fInfluence <= 0 && inn.m_fInfluence <= 0)
	{
		return false;
	}
	const f64 outFrac = out.m_fInfluence / 100;
	const f64 inFrac = inn.m_fInfluence / 100;
	const f64 dsdt = arcLength > 1e-12 ? 1 / arcLength : 0;
	f64 cx1 = outFrac;
	f64 cy1 = out.m_fSpeed * dsdt * outFrac * dt;
	f64 cx2 = 1 - inFrac;
	f64 cy2 = 1 - inn.m_fSpeed * dsdt * inFrac * dt;
	if (outLinear)
	{
		cy1 = cx1;
	}
	if (inLinear)
	{
		cy2 = cx2;
	}
	/** A handle past the unit square is shortened along its own slope, keeping the speed. */
	if (cy1 > 1)
	{
		cx1 = cx1 / cy1;
		cy1 = 1;
	}
	else if (cy1 < 0)
	{
		cy1 = 0;
	}
	if (cy2 < 0)
	{
		cx2 = 1 - (1 - cx2) / (1 - cy2);
		cy2 = 0;
	}
	else if (cy2 > 1)
	{
		cy2 = 1;
	}
	easing = CBezierEasing(cx1, cy1, cx2, cy2);
	return true;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Orientation (quaternion slerp in AE's Rx.Ry.Rz order)                                                              */
/* ------------------------------------------------------------------------------------------------------------------ */

struct sQuat
{
	f64 m_V[4];
};

sQuat AxisQuat(s32 axis, f64 degrees)
{
	const f64 half = (degrees * PI) / 360;
	sQuat q = { { 0, 0, 0, std::cos(half) } };
	q.m_V[axis] = std::sin(half);
	return q;
}

sQuat QuatMul(const sQuat& a, const sQuat& b)
{
	const f64 ax = a.m_V[0], ay = a.m_V[1], az = a.m_V[2], aw = a.m_V[3];
	const f64 bx = b.m_V[0], by = b.m_V[1], bz = b.m_V[2], bw = b.m_V[3];
	return { {
		aw * bx + ax * bw + ay * bz - az * by,
		aw * by - ax * bz + ay * bw + az * bx,
		aw * bz + ax * by - ay * bx + az * bw,
		aw * bw - ax * bx - ay * by - az * bz,
	} };
}

sQuat EulerToQuat(const sVec& angles)
{
	sQuat q = { { 0, 0, 0, 1 } };
	for (s32 axis = 0; axis < 3; axis++)
	{
		q = QuatMul(q, AxisQuat(axis, u32(axis) < angles.m_uCount ? angles.m_V[axis] : 0));
	}
	return q;
}

f64 Wrap360(f64 a)
{
	return std::fmod(std::fmod(a, 360) + 360, 360);
}

sVec QuatToEuler(sQuat q)
{
	const f64 norm = Hypot(q.m_V, 4);
	if (norm > 0)
	{
		for (f64& v : q.m_V)
		{
			v /= norm;
		}
	}
	const f64 x = q.m_V[0], y = q.m_V[1], z = q.m_V[2], w = q.m_V[3];
	const f64 r00 = 1 - 2 * (y * y + z * z);
	const f64 r01 = 2 * (x * y - z * w);
	const f64 r02 = 2 * (x * z + y * w);
	const f64 r10 = 2 * (x * y + z * w);
	const f64 r11 = 1 - 2 * (x * x + z * z);
	const f64 r12 = 2 * (y * z - x * w);
	const f64 r22 = 1 - 2 * (x * x + y * y);
	const f64 beta = std::asin(std::max(-1.0, std::min(1.0, r02)));
	const f64 cosBeta = Hypot2(r00, r01);
	sVec angles;
	angles.m_uCount = 3;
	if (std::fabs(cosBeta) > EULER_EPS)
	{
		angles.m_V[0] = std::atan2(-r12, r22) * RAD2DEG;
		angles.m_V[1] = beta * RAD2DEG;
		angles.m_V[2] = std::atan2(-r01, r00) * RAD2DEG;
	}
	else
	{
		angles.m_V[0] = 0;
		angles.m_V[1] = beta * RAD2DEG;
		angles.m_V[2] = std::atan2(r10, r11) * RAD2DEG;
	}
	for (u32 i = 0; i < 3; i++)
	{
		angles.m_V[i] = Wrap360(angles.m_V[i]);
	}
	return angles;
}

sVec SlerpOrientation(const sVec& start, const sVec& end, f64 progress)
{
	const sQuat q0 = EulerToQuat(start);
	sQuat q1 = EulerToQuat(end);
	f64 dot = 0;
	for (s32 i = 0; i < 4; i++)
	{
		dot += q0.m_V[i] * q1.m_V[i];
	}
	if (dot < 0)
	{
		for (f64& v : q1.m_V)
		{
			v = -v;
		}
		dot = -dot;
	}
	dot = std::min(1.0, std::max(-1.0, dot));
	sQuat blend;
	if (dot > 0.9995)
	{
		for (s32 i = 0; i < 4; i++)
		{
			blend.m_V[i] = q0.m_V[i] + (q1.m_V[i] - q0.m_V[i]) * progress;
		}
		return QuatToEuler(blend);
	}
	const f64 theta = std::acos(dot);
	const f64 sinTheta = std::sin(theta);
	const f64 s0 = std::sin((1 - progress) * theta) / sinTheta;
	const f64 s1 = std::sin(progress * theta) / sinTheta;
	for (s32 i = 0; i < 4; i++)
	{
		blend.m_V[i] = q0.m_V[i] * s0 + q1.m_V[i] * s1;
	}
	return QuatToEuler(blend);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Path morphing                                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

struct sCubic
{
	sVec2 m_P[4];
};

inline sVec2 LerpPt(const sVec2& a, const sVec2& b, f64 t)
{
	return { a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t };
}

void SplitCubic(const sCubic& c, f64 t, sCubic& left, sCubic& right)
{
	const sVec2 a = LerpPt(c.m_P[0], c.m_P[1], t);
	const sVec2 b = LerpPt(c.m_P[1], c.m_P[2], t);
	const sVec2 cc = LerpPt(c.m_P[2], c.m_P[3], t);
	const sVec2 d = LerpPt(a, b, t);
	const sVec2 e = LerpPt(b, cc, t);
	const sVec2 f = LerpPt(d, e, t);
	left = { { c.m_P[0], a, d, f } };
	right = { { f, e, cc, c.m_P[3] } };
}

/** AE bisects breadth-first in path order until the segment counts match. */
std::vector<std::vector<f64>> SubdivisionCuts(s32 segmentCount, s32 targetCount)
{
	struct sPiece
	{
		s32 m_iIndex;
		f64 m_fStart;
		f64 m_fEnd;
	};
	std::vector<sPiece> pieces;
	for (s32 i = 0; i < segmentCount; i++)
	{
		pieces.push_back({ i, 0, 1 });
	}
	size_t head = 0;
	while (s64(pieces.size() - head) < targetCount)
	{
		const sPiece piece = pieces[head++];
		const f64 middle = (piece.m_fStart + piece.m_fEnd) / 2;
		pieces.push_back({ piece.m_iIndex, piece.m_fStart, middle });
		pieces.push_back({ piece.m_iIndex, middle, piece.m_fEnd });
	}
	std::vector<std::vector<f64>> cuts(size_t(std::max(0, segmentCount)));
	for (size_t i = head; i < pieces.size(); i++)
	{
		if (pieces[i].m_fStart > 0)
		{
			cuts[size_t(pieces[i].m_iIndex)].push_back(pieces[i].m_fStart);
		}
	}
	for (std::vector<f64>& c : cuts)
	{
		std::sort(c.begin(), c.end());
	}
	return cuts;
}

inline bool Truthy(f64 v)
{
	return v != 0 && !std::isnan(v);
}

sShape ResamplePath(const sShape& shape, s32 target)
{
	const s32 count = s32(shape.m_Vertices.size());
	const s32 segmentCount = shape.m_bClosed ? count : count - 1;
	if (segmentCount < 1)
	{
		return shape;
	}
	const std::vector<std::vector<f64>> cuts = SubdivisionCuts(segmentCount, segmentCount + target - count);
	std::vector<sCubic> chain;
	for (s32 index = 0; index < segmentCount; index++)
	{
		const s32 tail = (index + 1) % count;
		const sVec2 start = shape.m_Vertices[size_t(index)];
		const sVec2 end = shape.m_Vertices[size_t(tail)];
		const sVec2 outT = shape.m_OutTangents[size_t(index)];
		const sVec2 inT = shape.m_InTangents[size_t(tail)];
		if (!Truthy(outT.x) && !Truthy(outT.y) && !Truthy(inT.x) && !Truthy(inT.y))
		{
			/** A straight segment stays straight: new vertices land on the line with zero handles. */
			std::vector<f64> bounds = { 0 };
			bounds.insert(bounds.end(), cuts[size_t(index)].begin(), cuts[size_t(index)].end());
			bounds.push_back(1);
			for (size_t i = 0; i + 1 < bounds.size(); i++)
			{
				const sVec2 a = LerpPt(start, end, bounds[i]);
				const sVec2 b = LerpPt(start, end, bounds[i + 1]);
				chain.push_back({ { a, a, b, b } });
			}
			continue;
		}
		sCubic cubic = { { start, { start.x + outT.x, start.y + outT.y }, { end.x + inT.x, end.y + inT.y }, end } };
		f64 consumed = 0;
		for (const f64 cut : cuts[size_t(index)])
		{
			sCubic left, right;
			SplitCubic(cubic, (cut - consumed) / (1 - consumed), left, right);
			chain.push_back(left);
			cubic = right;
			consumed = cut;
		}
		chain.push_back(cubic);
	}
	sShape out;
	out.m_bClosed = shape.m_bClosed;
	std::vector<sVec2> arriving;
	for (const sCubic& c : chain)
	{
		out.m_Vertices.push_back(c.m_P[0]);
		out.m_OutTangents.push_back({ c.m_P[1].x - c.m_P[0].x, c.m_P[1].y - c.m_P[0].y });
		arriving.push_back({ c.m_P[2].x - c.m_P[3].x, c.m_P[2].y - c.m_P[3].y });
	}
	if (shape.m_bClosed)
	{
		out.m_InTangents.push_back(arriving.back());
		out.m_InTangents.insert(out.m_InTangents.end(), arriving.begin(), arriving.end() - 1);
	}
	else
	{
		out.m_Vertices.push_back(chain.back().m_P[3]);
		out.m_OutTangents.push_back(shape.m_OutTangents.back());
		out.m_InTangents.push_back(shape.m_InTangents.front());
		out.m_InTangents.insert(out.m_InTangents.end(), arriving.begin(), arriving.end());
	}
	return out;
}

bool InterpolateShapes(const sShape& start, const sShape& end, f64 progress, sShape& out)
{
	if (start.m_Vertices.empty() || end.m_Vertices.empty())
	{
		return false;
	}
	const s32 target = s32(std::max(start.m_Vertices.size(), end.m_Vertices.size()));
	const sShape a = s32(start.m_Vertices.size()) < target ? ResamplePath(start, target) : start;
	const sShape b = s32(end.m_Vertices.size()) < target ? ResamplePath(end, target) : end;
	if (a.m_Vertices.size() != b.m_Vertices.size())
	{
		return false;
	}
	const auto lerp = [progress](const std::vector<sVec2>& p, const std::vector<sVec2>& q) {
		std::vector<sVec2> r(p.size());
		for (size_t i = 0; i < p.size(); i++)
		{
			const sVec2 qi = i < q.size() ? q[i] : sVec2{ NaN, NaN };
			r[i] = { p[i].x + (qi.x - p[i].x) * progress, p[i].y + (qi.y - p[i].y) * progress };
		}
		return r;
	};
	out.m_bClosed = start.m_bClosed;
	out.m_Vertices = lerp(a.m_Vertices, b.m_Vertices);
	out.m_InTangents = lerp(a.m_InTangents, b.m_InTangents);
	out.m_OutTangents = lerp(a.m_OutTangents, b.m_OutTangents);
	return true;
}

/** Blends two gradient ramps stop by stop; differing stop counts hold the left ramp. */
std::shared_ptr<const sGradient> InterpolateGradients(const std::shared_ptr<const sGradient>& a,
	const std::shared_ptr<const sGradient>& b, f64 t)
{
	if (a->m_ColorStops.size() != b->m_ColorStops.size() || a->m_AlphaStops.size() != b->m_AlphaStops.size())
	{
		return a;
	}
	const auto lerp = [t](f64 x, f64 y) { return x + (y - x) * t; };
	auto out = std::make_shared<sGradient>();
	for (size_t i = 0; i < a->m_ColorStops.size(); i++)
	{
		const sGradientColorStop& s = a->m_ColorStops[i];
		const sGradientColorStop& o = b->m_ColorStops[i];
		sGradientColorStop r;
		r.m_fOffset = lerp(s.m_fOffset, o.m_fOffset);
		r.m_fMidpoint = lerp(s.m_fMidpoint, o.m_fMidpoint);
		for (s32 k = 0; k < 3; k++)
		{
			r.m_Color[k] = lerp(s.m_Color[k], o.m_Color[k]);
		}
		out->m_ColorStops.push_back(r);
	}
	for (size_t i = 0; i < a->m_AlphaStops.size(); i++)
	{
		const sGradientAlphaStop& s = a->m_AlphaStops[i];
		const sGradientAlphaStop& o = b->m_AlphaStops[i];
		sGradientAlphaStop r;
		r.m_fOffset = lerp(s.m_fOffset, o.m_fOffset);
		r.m_fMidpoint = lerp(s.m_fMidpoint, o.m_fMidpoint);
		r.m_fAlpha = lerp(s.m_fAlpha, o.m_fAlpha);
		out->m_AlphaStops.push_back(r);
	}
	return out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Ease resolution: what AE reports (and interpolates with) for each side.                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

sEaseList Constant(u32 count, f64 speed, f64 influence)
{
	sEaseList list;
	list.m_uCount = u8(std::min(count, sEaseList::MAX));
	for (u32 i = 0; i < list.m_uCount; i++)
	{
		list.m_Eases[i] = { speed, influence };
	}
	return list;
}

/** Auto-bezier speeds: in and out. False when a key's value is not numeric. */
bool AutoTemporalSpeeds(const std::vector<sKeyframe>& keys, size_t index, sVec& in, sVec& out)
{
	for (const sKeyframe& k : keys)
	{
		if (!k.m_Value.IsNumeric())
		{
			return false;
		}
	}
	const sVec here = AsVec(keys[index].m_Value);
	sVec zero;
	zero.m_uCount = here.m_uCount;
	if (keys.size() < 2)
	{
		in = out = zero;
		return true;
	}
	const auto slope = [&](size_t lo, size_t hi) {
		const f64 span = keys[hi].m_fLayerTime - keys[lo].m_fLayerTime;
		if (span <= 0)
		{
			return zero;
		}
		const sVec h = AsVec(keys[hi].m_Value);
		const sVec l = AsVec(keys[lo].m_Value);
		sVec s;
		s.m_uCount = here.m_uCount;
		for (u32 d = 0; d < s.m_uCount; d++)
		{
			s.m_V[d] = (h.At(d) - l.At(d)) / span;
		}
		return s;
	};
	if (index == 0)
	{
		in = zero;
		out = slope(0, 1);
	}
	else if (index == keys.size() - 1)
	{
		in = slope(index - 1, index);
		out = zero;
	}
	else
	{
		in = out = slope(index - 1, index + 1);
	}
	return true;
}

sVec SegmentSpeed(const sKeyframe& a, const sKeyframe& b, bool motionPath)
{
	sVec zero;
	zero.m_uCount = 1;
	const f64 span = b.m_fLayerTime - a.m_fLayerTime;
	if (span == 0 || !a.m_Value.IsNumeric() || !b.m_Value.IsNumeric())
	{
		return zero;
	}
	const sVec va = AsVec(a.m_Value);
	const sVec vb = AsVec(b.m_Value);
	sVec s;
	if (a.m_Value.IsNumber())
	{
		s.m_uCount = 1;
		s.m_V[0] = (vb.At(0) - va.At(0)) / span;
		return s;
	}
	if (motionPath)
	{
		f64 delta[4];
		for (u32 d = 0; d < va.m_uCount; d++)
		{
			delta[d] = vb.At(d) - va.m_V[d];
		}
		s.m_uCount = 1;
		s.m_V[0] = Hypot(delta, va.m_uCount) / span;
		return s;
	}
	s.m_uCount = va.m_uCount;
	for (u32 d = 0; d < va.m_uCount; d++)
	{
		s.m_V[d] = (vb.At(d) - va.m_V[d]) / span;
	}
	return s;
}

sEaseList ResolveEase(const std::vector<sKeyframe>& keys, size_t index, bool in, bool motionPath, bool hasKind)
{
	const sKeyframe& kf = keys[index];
	const u32 rawCount = in ? kf.m_uInEaseCount : kf.m_uOutEaseCount;
	const sEase* raw = in ? kf.m_InEase : kf.m_OutEase;
	if (!rawCount)
	{
		return Constant(1, 0, 0);
	}
	if (kf.m_bTemporalAutoBezier)
	{
		sVec autoIn, autoOut;
		if (AutoTemporalSpeeds(keys, index, autoIn, autoOut))
		{
			const sVec& chosen = in ? autoIn : autoOut;
			if (chosen.m_uCount == rawCount)
			{
				sEaseList list;
				list.m_uCount = u8(rawCount);
				for (u32 i = 0; i < rawCount; i++)
				{
					list.m_Eases[i] = { chosen.m_V[i], DEFAULT_INFLUENCE };
				}
				return list;
			}
		}
	}
	const u32 interp = in ? kf.m_uInInterpolation : kf.m_uOutInterpolation;
	const sKeyframe* other = nullptr;
	if (!in && index + 1 < keys.size())
	{
		other = &keys[index + 1];
	}
	else if (in && index > 0)
	{
		other = &keys[index - 1];
	}
	if (interp == INTERP_LINEAR)
	{
		if (!other)
		{
			return Constant(rawCount, 0, DEFAULT_INFLUENCE);
		}
		const u32 adjacent = in ? other->m_uOutInterpolation : other->m_uInInterpolation;
		if (adjacent == INTERP_HOLD)
		{
			return Constant(rawCount, 0, DEFAULT_INFLUENCE);
		}
		if (hasKind)
		{
			return Constant(rawCount, 1, DEFAULT_INFLUENCE);
		}
		const sVec speeds = in ? SegmentSpeed(*other, kf, motionPath) : SegmentSpeed(kf, *other, motionPath);
		sEaseList list;
		list.m_uCount = u8(speeds.m_uCount);
		for (u32 i = 0; i < speeds.m_uCount; i++)
		{
			list.m_Eases[i] = { speeds.m_V[i], DEFAULT_INFLUENCE };
		}
		return list;
	}
	if (interp == INTERP_HOLD)
	{
		return Constant(rawCount, 0, DEFAULT_INFLUENCE);
	}
	sEaseList list;
	list.m_uCount = u8(std::min(rawCount, sEaseList::MAX));
	for (u32 i = 0; i < list.m_uCount; i++)
	{
		list.m_Eases[i] = other ? raw[i] : sEase{ 0, raw[i].m_fInfluence };
	}
	return list;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Prepared property and interpolation                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

const sPrepared& Prepare(const CPropertyNode& prop, const CLayer& layer)
{
	if (prop.m_pPrepared)
	{
		return *prop.m_pPrepared;
	}
	auto p = std::make_unique<sPrepared>();
	const std::vector<sKeyframe>& keys = prop.m_Keyframes;
	if (prop.m_uValueType == PVT_SHAPE)
	{
		p->m_eKind = sPrepared::KIND_SHAPE;
	}
	else if (prop.m_MatchName == "ADBE Orientation")
	{
		p->m_eKind = sPrepared::KIND_ORIENTATION;
	}
	else if (!keys.empty() && keys[0].m_Value.IsGradient())
	{
		p->m_eKind = sPrepared::KIND_GRADIENT;
	}
	const bool color = prop.m_uValueType == PVT_COLOR;
	p->m_bMotionPath = !color &&
		(prop.m_bSpatial || prop.m_uValueType == PVT_THREE_D_SPATIAL || prop.m_uValueType == PVT_TWO_D_SPATIAL) &&
		p->m_eKind == sPrepared::KIND_PLAIN;
	const bool hasKind = p->m_eKind != sPrepared::KIND_PLAIN;
	for (size_t i = 0; i < keys.size(); i++)
	{
		p->m_InEase.push_back(ResolveEase(keys, i, true, p->m_bMotionPath, hasKind));
		p->m_OutEase.push_back(ResolveEase(keys, i, false, p->m_bMotionPath, hasKind));
	}
	p->m_iInert = prop.m_MatchName == "ADBE Scale" && !layer.m_bThreeD ? 2 : -1;
	prop.m_pPrepared = std::move(p);
	return *prop.m_pPrepared;
}

sVec SpatialTangent(const sKeyframe& kf, bool in, u32 dims)
{
	sVec t;
	if (kf.m_uSpatialCount)
	{
		t.m_uCount = kf.m_uSpatialCount;
		for (u32 i = 0; i < t.m_uCount; i++)
		{
			t.m_V[i] = in ? kf.m_InSpatial[i] : kf.m_OutSpatial[i];
		}
	}
	else
	{
		t.m_uCount = dims;
	}
	return t;
}

sVec InterpolateSpatial(const sPrepared& p, const std::vector<sKeyframe>& keys, f64 t, size_t i0, size_t i1)
{
	const sKeyframe& k0 = keys[i0];
	const sKeyframe& k1 = keys[i1];
	const sVec v0 = AsVec(k0.m_Value);
	const sVec v1 = AsVec(k1.m_Value);
	const f64 dt = k1.m_fLayerTime - k0.m_fLayerTime;
	if (dt == 0)
	{
		return v0;
	}
	const sVec outTan = SpatialTangent(k0, false, v0.m_uCount);
	const sVec inTan = SpatialTangent(k1, true, v1.m_uCount);
	const bool straight = IsZero(outTan) && IsZero(inTan);
	const sEase& out = p.m_OutEase[i0].m_Eases[0];
	const sEase& inn = p.m_InEase[i1].m_Eases[0];
	const bool isExplicit = out.m_fInfluence > 0 || inn.m_fInfluence > 0;
	std::unique_ptr<CBezierPath> path;
	f64 arc;
	if (!straight)
	{
		path = std::make_unique<CBezierPath>(v0, v1, outTan, inTan);
		arc = path->Length();
	}
	else
	{
		f64 delta[4];
		for (u32 d = 0; d < v0.m_uCount; d++)
		{
			delta[d] = v1.At(d) - v0.m_V[d];
		}
		arc = Hypot(delta, v0.m_uCount);
	}
	CBezierEasing easing(0, 0, 0, 0);
	const bool eased = isExplicit && SpatialProgressEasing(dt, arc, out, inn, k0.m_uOutInterpolation == INTERP_LINEAR,
		k1.m_uInInterpolation == INTERP_LINEAR, easing);
	const f64 x = (t - k0.m_fLayerTime) / dt;
	const f64 perc = eased ? easing.Get(x) : x;
	if (path)
	{
		return path->PointAt(perc);
	}
	sVec r;
	r.m_uCount = v0.m_uCount;
	for (u32 d = 0; d < v0.m_uCount; d++)
	{
		r.m_V[d] = v0.m_V[d] + (v1.At(d) - v0.m_V[d]) * perc;
	}
	return r;
}

/** A roving run is eased once across its enclosing anchors and read along the joined path. */
bool InterpolateRoving(const sPrepared& p, const std::vector<sKeyframe>& keys, f64 t, size_t start, size_t end, sVec& out)
{
	for (size_t i = start; i <= end; i++)
	{
		if (!keys[i].m_Value.IsVector())
		{
			return false;
		}
	}
	std::vector<std::unique_ptr<CBezierPath>> paths;
	f64 total = 0;
	for (size_t i = start; i < end; i++)
	{
		const sVec a = AsVec(keys[i].m_Value);
		const sVec b = AsVec(keys[i + 1].m_Value);
		paths.push_back(std::make_unique<CBezierPath>(a, b, SpatialTangent(keys[i], false, a.m_uCount),
			SpatialTangent(keys[i + 1], true, b.m_uCount)));
		total += paths.back()->Length();
	}
	if (!(total > 0))
	{
		return false;
	}
	const f64 spanStart = keys[start].m_fLayerTime;
	const f64 span = keys[end].m_fLayerTime - spanStart;
	if (span <= 0)
	{
		out = AsVec(keys[start].m_Value);
		return true;
	}
	CBezierEasing easing(0, 0, 0, 0);
	const bool eased = SpatialProgressEasing(span, total, p.m_OutEase[start].m_Eases[0], p.m_InEase[end].m_Eases[0],
		keys[start].m_uOutInterpolation == INTERP_LINEAR, keys[end].m_uInInterpolation == INTERP_LINEAR, easing);
	const f64 x = (t - spanStart) / span;
	const f64 target = (eased ? easing.Get(x) : x) * total;
	f64 travelled = 0;
	for (size_t i = 0; i < paths.size(); i++)
	{
		const CBezierPath& path = *paths[i];
		if (travelled + path.Length() >= target || i == paths.size() - 1)
		{
			out = path.PointAt(std::min(std::max((target - travelled) / path.Length(), 0.0), 1.0));
			return true;
		}
		travelled += path.Length();
	}
	return false;
}

CValue Interpolate(const sPrepared& p, const std::vector<sKeyframe>& keys, f64 t)
{
	const size_t n = keys.size();
	if (n == 1 || t <= keys[0].m_fLayerTime)
	{
		return keys[0].m_Value;
	}
	if (t >= keys[n - 1].m_fLayerTime)
	{
		return keys[n - 1].m_Value;
	}
	size_t i1 = 1;
	while (i1 < n - 1 && keys[i1].m_fLayerTime < t)
	{
		i1++;
	}
	const size_t i0 = i1 - 1;
	const sKeyframe& k0 = keys[i0];
	const sKeyframe& k1 = keys[i1];
	const f64 t0 = k0.m_fLayerTime;
	const f64 t1 = k1.m_fLayerTime;
	if (std::fabs(t - t0) < 1e-12)
	{
		return k0.m_Value;
	}
	if (std::fabs(t - t1) < 1e-12)
	{
		return k1.m_Value;
	}

	if (p.m_bMotionPath && (k0.m_bRoving || k1.m_bRoving))
	{
		size_t start = i0;
		while (start > 0 && keys[start].m_bRoving)
		{
			start--;
		}
		size_t end = i1;
		while (end < n - 1 && keys[end].m_bRoving)
		{
			end++;
		}
		sVec roving;
		if (InterpolateRoving(p, keys, t, start, end, roving))
		{
			return ToValue(roving);
		}
	}

	const u32 outType = k0.m_uOutInterpolation;
	const u32 inType = k1.m_uInInterpolation;
	if (outType == INTERP_HOLD)
	{
		return k0.m_Value;
	}
	if (inType == INTERP_HOLD)
	{
		return k1.m_Value;
	}
	const CValue& v0 = k0.m_Value;
	const CValue& v1 = k1.m_Value;

	if (p.m_eKind != sPrepared::KIND_PLAIN)
	{
		/** Paths and Orientation blend as one eased quantity; a stored ease speed is dimensionless here. */
		CBezierEasing easing(0, 0, 0, 0);
		const bool eased = SpatialProgressEasing(1, 1, p.m_OutEase[i0].m_Eases[0], p.m_InEase[i1].m_Eases[0],
			outType == INTERP_LINEAR, inType == INTERP_LINEAR, easing);
		const f64 x = (t - t0) / (t1 - t0);
		const f64 progress = eased ? easing.Get(x) : x;
		if (p.m_eKind == sPrepared::KIND_SHAPE && v0.IsShape() && v1.IsShape())
		{
			auto shape = std::make_shared<sShape>();
			if (InterpolateShapes(*v0.m_pShape, *v1.m_pShape, progress, *shape))
			{
				return CValue::Shape(shape);
			}
			return v0;
		}
		if (p.m_eKind == sPrepared::KIND_ORIENTATION && v0.IsVector() && v1.IsVector())
		{
			return ToValue(SlerpOrientation(AsVec(v0), AsVec(v1), progress));
		}
		if (p.m_eKind == sPrepared::KIND_GRADIENT && v0.IsGradient() && v1.IsGradient())
		{
			return CValue::Gradient(InterpolateGradients(v0.m_pGradient, v1.m_pGradient, progress));
		}
	}

	if (p.m_bMotionPath && v0.IsVector() && v1.IsVector())
	{
		return ToValue(InterpolateSpatial(p, keys, t, i0, i1));
	}

	if (v0.IsVector() && v1.IsVector())
	{
		const sEaseList& outE = p.m_OutEase[i0];
		const sEaseList& inE = p.m_InEase[i1];
		const sVec a = AsVec(v0);
		const sVec b = AsVec(v1);
		sVec r;
		r.m_uCount = a.m_uCount;
		/** A single ease on a multi-dimensional value (a color) drives every channel with one progress. */
		if (std::min(outE.m_uCount, inE.m_uCount) == 1)
		{
			const f64 progress = CBezierEasing(outE.m_Eases[0].m_fInfluence / 100, 0, 1 - inE.m_Eases[0].m_fInfluence / 100, 1)
				.Get((t - t0) / (t1 - t0));
			for (u32 d = 0; d < a.m_uCount; d++)
			{
				r.m_V[d] = a.m_V[d] + (b.At(d) - a.m_V[d]) * progress;
			}
			return ToValue(r);
		}
		for (u32 d = 0; d < a.m_uCount; d++)
		{
			r.m_V[d] = s32(d) == p.m_iInert ? a.m_V[d] : InterpolateBezier1d(t, t0, t1, a.m_V[d], b.At(d), outE.At(d), inE.At(d));
		}
		return ToValue(r);
	}

	if (v0.IsNumber() && v1.IsNumber())
	{
		return CValue::Number(InterpolateBezier1d(t, t0, t1, v0.m_V[0], v1.m_V[0], p.m_OutEase[i0].m_Eases[0],
			p.m_InEase[i1].m_Eases[0]));
	}
	return v0;
}

} /** namespace */

f64 Hypot(const f64* values, u32 count)
{
	f64 max = 0;
	bool nan = false;
	for (u32 i = 0; i < count; i++)
	{
		const f64 a = std::fabs(values[i]);
		if (std::isinf(a))
		{
			return std::numeric_limits<f64>::infinity();
		}
		if (std::isnan(a))
		{
			nan = true;
		}
		else if (a > max)
		{
			max = a;
		}
	}
	if (nan)
	{
		return NaN;
	}
	if (max == 0)
	{
		return 0;
	}
	f64 sum = 0;
	f64 compensation = 0;
	for (u32 i = 0; i < count; i++)
	{
		const f64 n = std::fabs(values[i]) / max;
		const f64 summand = n * n - compensation;
		const f64 preliminary = sum + summand;
		compensation = (preliminary - sum) - summand;
		sum = preliminary;
	}
	return std::sqrt(sum) * max;
}

f64 Hypot2(f64 x, f64 y)
{
	const f64 v[2] = { x, y };
	return Hypot(v, 2);
}

f64 JsRound(f64 v)
{
	if (!std::isfinite(v))
	{
		return v;
	}
	const f64 r = std::floor(v);
	return v - r >= 0.5 ? r + 1 : r;
}

f64 LayerTimeAt(const CLayer& layer, f64 compTime)
{
	const f64 stretch = layer.m_fStretch != 0 ? layer.m_fStretch / 100 : 1;
	const f64 offset = stretch >= 0 ? layer.m_fStartTime : layer.m_fStartTime - std::fabs(stretch) / 3000;
	return (compTime - offset) / stretch;
}

CValue ValueAtTime(const CPropertyNode& prop, f64 compTime, const CLayer& layer, const CPropertyNode* siblings)
{
	if (siblings && prop.m_bDimensionsSeparated && prop.m_MatchName == "ADBE Position")
	{
		const char* names[3] = { "ADBE Position_0", "ADBE Position_1", "ADBE Position_2" };
		const CPropertyNode* followers[3];
		bool all = true;
		for (s32 i = 0; i < 3; i++)
		{
			followers[i] = siblings->FindProperty(names[i]);
			all = all && followers[i];
		}
		if (all)
		{
			f64 parts[3];
			bool numbers = true;
			for (s32 i = 0; i < 3 && numbers; i++)
			{
				const CValue v = ValueAtTime(*followers[i], compTime, layer);
				numbers = v.IsNumber();
				parts[i] = v.m_V[0];
			}
			if (numbers)
			{
				return CValue::Vector(parts, 3);
			}
		}
	}
	if (prop.m_Keyframes.empty())
	{
		return prop.m_Value;
	}
	return Interpolate(Prepare(prop, layer), prop.m_Keyframes, LayerTimeAt(layer, compTime));
}

} /** namespace aep */
