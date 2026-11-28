/**
 * Port of the geometry half of src/render/shapes.ts. Geometry conventions (path start points, directions, roundness
 * handles, transform order) follow After Effects as reproduced by lottie-web.
 */
#include "shapes.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <map>
#include <regex>

#include "evaluate.h"

namespace aep
{

namespace
{

const f64 PI = 3.14159265358979323846;
const f64 DEG = PI / 180;
/** Bezier handle length for a quarter circle, as AE draws ellipses and round corners. */
const f64 ROUND_CORNER = 0.5519;
const s32 SAMPLES = 64;
const f64 MAX_RASTER = 8192;
/** Steps of a gradient ramp. */
const s32 GRADIENT_STOPS = 64;
const f64 NaN = std::numeric_limits<f64>::quiet_NaN();

inline bool Truthy(f64 v) { return v != 0 && !std::isnan(v); }

/** `Math.min` / `Math.max`: NaN wins. */
inline f64 JsMin(f64 a, f64 b) { return std::isnan(a) || std::isnan(b) ? NaN : std::min(a, b); }
inline f64 JsMax(f64 a, f64 b) { return std::isnan(a) || std::isnan(b) ? NaN : std::max(a, b); }

/** JavaScript's ToUint32 (`v >>> 0`), as the wire writer applies it. */
u32 ToUint32(f64 v)
{
	if (!std::isfinite(v))
	{
		return 0;
	}
	const f64 t = std::trunc(v);
	const f64 m = std::fmod(t, 4294967296.0);
	return u32(s64(m < 0 ? m + 4294967296.0 : m));
}

/** 2D affine [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
struct sAffine
{
	f64 v[6] = { 1, 0, 0, 1, 0, 0 };
};

sAffine Mul(const sAffine& m, const sAffine& n)
{
	return { {
		m.v[0] * n.v[0] + m.v[2] * n.v[1],
		m.v[1] * n.v[0] + m.v[3] * n.v[1],
		m.v[0] * n.v[2] + m.v[2] * n.v[3],
		m.v[1] * n.v[2] + m.v[3] * n.v[3],
		m.v[0] * n.v[4] + m.v[2] * n.v[5] + m.v[4],
		m.v[1] * n.v[4] + m.v[3] * n.v[5] + m.v[5],
	} };
}

sAffine Translate(f64 x, f64 y) { return { { 1, 0, 0, 1, x, y } }; }
sAffine Scale(f64 x, f64 y) { return { { x, 0, 0, y, 0, 0 } }; }
sAffine Rotate(f64 rad) { return { { std::cos(rad), std::sin(rad), -std::sin(rad), std::cos(rad), 0, 0 } }; }

inline sVec2 ApplyPoint(const sAffine& m, const sVec2& p)
{
	return { m.v[0] * p.x + m.v[2] * p.y + m.v[4], m.v[1] * p.x + m.v[3] * p.y + m.v[5] };
}

inline sVec2 ApplyVector(const sAffine& m, const sVec2& p)
{
	return { m.v[0] * p.x + m.v[2] * p.y, m.v[1] * p.x + m.v[3] * p.y };
}

sShape TransformShape(const sShape& shape, const sAffine& m)
{
	sShape out;
	out.m_bClosed = shape.m_bClosed;
	out.m_Vertices.reserve(shape.m_Vertices.size());
	for (const sVec2& v : shape.m_Vertices)
	{
		out.m_Vertices.push_back(ApplyPoint(m, v));
	}
	for (const sVec2& t : shape.m_InTangents)
	{
		out.m_InTangents.push_back(ApplyVector(m, t));
	}
	for (const sVec2& t : shape.m_OutTangents)
	{
		out.m_OutTangents.push_back(ApplyVector(m, t));
	}
	return out;
}

sShape ReverseShape(const sShape& shape)
{
	const size_t n = shape.m_Vertices.size();
	if (n < 2)
	{
		return shape;
	}
	std::vector<size_t> order;
	if (shape.m_bClosed)
	{
		order.push_back(0);
		for (size_t i = 0; i + 1 < n; i++)
		{
			order.push_back(n - 1 - i);
		}
	}
	else
	{
		for (size_t i = 0; i < n; i++)
		{
			order.push_back(n - 1 - i);
		}
	}
	sShape out;
	out.m_bClosed = shape.m_bClosed;
	for (const size_t i : order)
	{
		out.m_Vertices.push_back(shape.m_Vertices[i]);
		out.m_InTangents.push_back(i < shape.m_OutTangents.size() ? shape.m_OutTangents[i] : sVec2{ NaN, NaN });
		out.m_OutTangents.push_back(i < shape.m_InTangents.size() ? shape.m_InTangents[i] : sVec2{ NaN, NaN });
	}
	return out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Property access                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

struct sVecValue
{
	u32 m_uCount = 0;
	f64 m_V[4] = { 0, 0, 0, 0 };

	f64 At(u32 i) const { return i < m_uCount ? m_V[i] : NaN; }
};

class CReader
{
public:
	CReader(const CLayer& layer, f64 time) : m_Layer(layer), m_fTime(time) {}

	const CPropertyNode* Group(const CPropertyNode& group, const char* matchName) const { return group.FindGroup(matchName); }

	f64 Num(const CPropertyNode& group, const char* matchName, f64 fallback) const
	{
		const CPropertyNode* p = group.FindProperty(matchName);
		if (!p)
		{
			return fallback;
		}
		const CValue v = CurrentValue(*p, m_fTime, m_Layer);
		if (v.IsNumber())
		{
			return v.m_V[0];
		}
		if (v.IsVector())
		{
			return v.m_uCount ? v.m_V[0] : fallback;
		}
		return fallback;
	}

	sVecValue Vec(const CPropertyNode& group, const char* matchName, std::initializer_list<f64> fallback) const
	{
		const CPropertyNode* p = group.FindProperty(matchName);
		sVecValue out;
		if (p)
		{
			const CValue v = CurrentValue(*p, m_fTime, m_Layer);
			if (v.IsVector())
			{
				out.m_uCount = v.m_uCount;
				for (u32 i = 0; i < out.m_uCount; i++)
				{
					out.m_V[i] = v.m_V[i];
				}
				return out;
			}
		}
		for (const f64 f : fallback)
		{
			out.m_V[out.m_uCount++] = f;
		}
		return out;
	}

	std::shared_ptr<const sShape> Shape(const CPropertyNode& group, const char* matchName) const
	{
		const CPropertyNode* p = group.FindProperty(matchName);
		if (!p)
		{
			return nullptr;
		}
		const CValue v = CurrentValue(*p, m_fTime, m_Layer);
		return v.IsShape() ? v.m_pShape : nullptr;
	}

	std::shared_ptr<const sGradient> Gradient(const CPropertyNode& group, const char* matchName) const
	{
		const CPropertyNode* p = group.FindProperty(matchName);
		if (!p)
		{
			return nullptr;
		}
		const CValue v = CurrentValue(*p, m_fTime, m_Layer);
		return v.IsGradient() ? v.m_pGradient : nullptr;
	}

private:
	const CLayer& m_Layer;
	f64 m_fTime;
};

/* ------------------------------------------------------------------------------------------------------------------ */
/* Path generators                                                                                                    */
/* ------------------------------------------------------------------------------------------------------------------ */

sShape MakeShape(bool closed, std::initializer_list<sVec2> vertices, std::initializer_list<sVec2> in, std::initializer_list<sVec2> out)
{
	sShape s;
	s.m_bClosed = closed;
	s.m_Vertices = vertices;
	s.m_InTangents = in;
	s.m_OutTangents = out;
	return s;
}

sShape RectPath(const CReader& r, const CPropertyNode& item)
{
	const sVecValue pos = r.Vec(item, "ADBE Vector Rect Position", { 0, 0 });
	const sVecValue size = r.Vec(item, "ADBE Vector Rect Size", { 100, 100 });
	const f64 px = pos.At(0), py = pos.At(1);
	const f64 w = size.At(0) / 2;
	const f64 h = size.At(1) / 2;
	const f64 round = JsMin(JsMin(w, h), r.Num(item, "ADBE Vector Rect Roundness", 0));
	const f64 k = round * ROUND_CORNER;
	sShape shape;
	if (round <= 0)
	{
		shape = MakeShape(true, { { px + w, py - h }, { px + w, py + h }, { px - w, py + h }, { px - w, py - h } },
			{ { 0, 0 }, { 0, 0 }, { 0, 0 }, { 0, 0 } }, { { 0, 0 }, { 0, 0 }, { 0, 0 }, { 0, 0 } });
	}
	else
	{
		shape = MakeShape(true,
			{ { px + w, py - h + round }, { px + w, py + h - round }, { px + w - round, py + h }, { px - w + round, py + h },
				{ px - w, py + h - round }, { px - w, py - h + round }, { px - w + round, py - h }, { px + w - round, py - h } },
			{ { 0, -k }, { 0, 0 }, { k, 0 }, { 0, 0 }, { 0, k }, { 0, 0 }, { -k, 0 }, { 0, 0 } },
			{ { 0, 0 }, { 0, k }, { 0, 0 }, { -k, 0 }, { 0, 0 }, { 0, -k }, { 0, 0 }, { k, 0 } });
	}
	return r.Num(item, "ADBE Vector Shape Direction", 1) == 3 ? ReverseShape(shape) : shape;
}

sShape EllipsePath(const CReader& r, const CPropertyNode& item)
{
	const sVecValue pos = r.Vec(item, "ADBE Vector Ellipse Position", { 0, 0 });
	const sVecValue size = r.Vec(item, "ADBE Vector Ellipse Size", { 100, 100 });
	const f64 px = pos.At(0), py = pos.At(1);
	const f64 w = size.At(0) / 2;
	const f64 h = size.At(1) / 2;
	const f64 kx = w * ROUND_CORNER;
	const f64 ky = h * ROUND_CORNER;
	const sShape shape = MakeShape(true, { { px, py - h }, { px + w, py }, { px, py + h }, { px - w, py } },
		{ { -kx, 0 }, { 0, -ky }, { kx, 0 }, { 0, ky } }, { { kx, 0 }, { 0, ky }, { -kx, 0 }, { 0, -ky } });
	return r.Num(item, "ADBE Vector Shape Direction", 1) == 3 ? ReverseShape(shape) : shape;
}

sShape StarPath(const CReader& r, const CPropertyNode& item)
{
	const sVecValue pos = r.Vec(item, "ADBE Vector Star Position", { 0, 0 });
	const f64 px = pos.At(0), py = pos.At(1);
	const bool polygon = r.Num(item, "ADBE Vector Star Type", 1) == 2;
	const f64 points = std::floor(r.Num(item, "ADBE Vector Star Points", 5));
	const f64 rotation = r.Num(item, "ADBE Vector Star Rotation", 0) * DEG;
	const f64 outer = r.Num(item, "ADBE Vector Star Outer Radius", 100);
	const f64 inner = r.Num(item, "ADBE Vector Star Inner Radius", 50);
	const f64 outerRound = r.Num(item, "ADBE Vector Star Outer Roundess", 0) / 100;
	const f64 innerRound = r.Num(item, "ADBE Vector Star Inner Roundess", 0) / 100;
	const f64 dir = r.Num(item, "ADBE Vector Shape Direction", 1) == 3 ? -1 : 1;
	const f64 count = polygon ? points : points * 2;
	const f64 step = (2 * PI) / count;
	sShape shape;
	shape.m_bClosed = true;
	f64 angle = -PI / 2 + rotation;
	for (s64 i = 0; f64(i) < count; i++)
	{
		const bool isOuter = polygon || i % 2 == 0;
		const f64 radius = isOuter ? outer : inner;
		const f64 roundness = isOuter ? outerRound : innerRound;
		const f64 perimeter = (2 * PI * radius) / (polygon ? count * 4 : count * 2);
		const f64 x = radius * std::cos(angle);
		const f64 y = radius * std::sin(angle);
		const f64 len = Hypot2(x, y);
		const f64 ox = Truthy(len) ? y / len : 0;
		const f64 oy = Truthy(len) ? -x / len : 0;
		const f64 handle = perimeter * roundness * dir;
		shape.m_Vertices.push_back({ x + px, y + py });
		shape.m_OutTangents.push_back({ -ox * handle, -oy * handle });
		shape.m_InTangents.push_back({ ox * handle, oy * handle });
		angle += step * dir;
	}
	return shape;
}

bool FreePath(const CReader& r, const CPropertyNode& item, sShape& out)
{
	const std::shared_ptr<const sShape> shape = r.Shape(item, "ADBE Vector Shape");
	if (!shape)
	{
		return false;
	}
	out = r.Num(item, "ADBE Vector Shape Direction", 1) == 3 ? ReverseShape(*shape) : *shape;
	return true;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Path measurement and trimming                                                                                      */
/* ------------------------------------------------------------------------------------------------------------------ */

struct sCubic
{
	sVec2 m_P[4];
};

std::vector<sCubic> Segments(const sShape& shape)
{
	const s64 n = s64(shape.m_Vertices.size());
	const s64 count = shape.m_bClosed ? n : n - 1;
	std::vector<sCubic> out;
	for (s64 i = 0; i < count; i++)
	{
		const size_t j = size_t((i + 1) % n);
		const sVec2 a = shape.m_Vertices[size_t(i)];
		const sVec2 b = shape.m_Vertices[j];
		const sVec2 o = shape.m_OutTangents[size_t(i)];
		const sVec2 in = shape.m_InTangents[j];
		out.push_back({ { a, { a.x + o.x, a.y + o.y }, { b.x + in.x, b.y + in.y }, b } });
	}
	return out;
}

sVec2 CubicPoint(const sCubic& c, f64 t)
{
	const f64 u = 1 - t;
	const auto at = [&](f64 p0, f64 p1, f64 p2, f64 p3) { return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3; };
	return { at(c.m_P[0].x, c.m_P[1].x, c.m_P[2].x, c.m_P[3].x), at(c.m_P[0].y, c.m_P[1].y, c.m_P[2].y, c.m_P[3].y) };
}

/** Cumulative arc length at SAMPLES+1 evenly spaced parameters. */
struct sArcTable
{
	f64 m_Length[SAMPLES + 1];

	f64 Total() const { return m_Length[SAMPLES]; }
};

sArcTable ArcTable(const sCubic& c)
{
	sArcTable table;
	table.m_Length[0] = 0;
	sVec2 prev = c.m_P[0];
	for (s32 k = 1; k <= SAMPLES; k++)
	{
		const sVec2 p = CubicPoint(c, f64(k) / SAMPLES);
		table.m_Length[k] = table.m_Length[k - 1] + Hypot2(p.x - prev.x, p.y - prev.y);
		prev = p;
	}
	return table;
}

f64 ParamAtLength(const sArcTable& table, f64 length)
{
	const f64 total = table.Total();
	if (length <= 0 || total <= 0)
	{
		return 0;
	}
	if (length >= total)
	{
		return 1;
	}
	s32 k = 1;
	while (table.m_Length[k] < length)
	{
		k++;
	}
	const f64 span = table.m_Length[k] - table.m_Length[k - 1];
	return (k - 1 + (span > 0 ? (length - table.m_Length[k - 1]) / span : 0)) / SAMPLES;
}

void SplitCubic(const sCubic& c, f64 t, sCubic& left, sCubic& right)
{
	const auto lerp = [t](const sVec2& a, const sVec2& b) { return sVec2{ a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t }; };
	const sVec2 a = lerp(c.m_P[0], c.m_P[1]);
	const sVec2 b = lerp(c.m_P[1], c.m_P[2]);
	const sVec2 d = lerp(c.m_P[2], c.m_P[3]);
	const sVec2 e = lerp(a, b);
	const sVec2 f = lerp(b, d);
	const sVec2 g = lerp(e, f);
	left = { { c.m_P[0], a, e, g } };
	right = { { g, f, d, c.m_P[3] } };
}

sCubic SubCubic(const sCubic& c, f64 t0, f64 t1)
{
	sCubic left, right;
	SplitCubic(c, t0, left, right);
	if (t0 >= 1)
	{
		return { { c.m_P[3], c.m_P[3], c.m_P[3], c.m_P[3] } };
	}
	sCubic l2, r2;
	SplitCubic(right, (t1 - t0) / (1 - t0), l2, r2);
	return l2;
}

sShape CubicsToShape(const std::vector<sCubic>& cubics)
{
	sShape shape;
	for (size_t i = 0; i < cubics.size(); i++)
	{
		const sCubic& c = cubics[i];
		if (i == 0)
		{
			shape.m_Vertices.push_back(c.m_P[0]);
			shape.m_InTangents.push_back({ 0, 0 });
		}
		shape.m_OutTangents.push_back({ c.m_P[1].x - c.m_P[0].x, c.m_P[1].y - c.m_P[0].y });
		shape.m_Vertices.push_back(c.m_P[3]);
		shape.m_InTangents.push_back({ c.m_P[2].x - c.m_P[3].x, c.m_P[2].y - c.m_P[3].y });
	}
	if (!shape.m_Vertices.empty())
	{
		shape.m_OutTangents.push_back({ 0, 0 });
	}
	return shape;
}

struct sMeasured
{
	std::vector<sCubic> m_Cubics;
	std::vector<sArcTable> m_Tables;
	f64 m_fTotal = 0;
};

sMeasured Measure(const sShape& shape)
{
	sMeasured m;
	m.m_Cubics = Segments(shape);
	for (const sCubic& c : m.m_Cubics)
	{
		m.m_Tables.push_back(ArcTable(c));
		m.m_fTotal += m.m_Tables.back().Total();
	}
	return m;
}

/** The part of a measured path between two lengths along it. */
std::vector<sCubic> Extract(const sMeasured& m, f64 from, f64 to)
{
	std::vector<sCubic> out;
	f64 start = 0;
	for (size_t i = 0; i < m.m_Cubics.size(); i++)
	{
		const f64 length = m.m_Tables[i].Total();
		const f64 end = start + length;
		const f64 a = JsMax(from, start);
		const f64 b = JsMin(to, end);
		if (b > a || (length == 0 && from <= start && to >= end))
		{
			out.push_back(SubCubic(m.m_Cubics[i], ParamAtLength(m.m_Tables[i], a - start), ParamAtLength(m.m_Tables[i], b - start)));
		}
		start = end;
	}
	return out;
}

/** Pieces of one path covered by the trim window [s, e] (fractions, already offset; may wrap). */
std::vector<sShape> TrimPath(const sShape& shape, f64 s, f64 e)
{
	const sMeasured m = Measure(shape);
	if (!(m.m_fTotal > 0))
	{
		return {};
	}
	if (e - s >= 1 - 1e-9)
	{
		return { shape };
	}
	std::vector<std::vector<sCubic>> pieces;
	const auto window = [&](f64 a, f64 b) { pieces.push_back(Extract(m, a * m.m_fTotal, b * m.m_fTotal)); };
	const f64 a = s - std::floor(s);
	const f64 b = a + (e - s);
	if (b <= 1)
	{
		window(a, b);
	}
	else
	{
		window(a, 1);
		window(0, b - 1);
	}
	/** A window that wraps over a closed path's start joins into one piece. */
	if (pieces.size() == 2 && shape.m_bClosed)
	{
		std::vector<sCubic> joined = pieces[0];
		joined.insert(joined.end(), pieces[1].begin(), pieces[1].end());
		return { CubicsToShape(joined) };
	}
	std::vector<sShape> out;
	for (const std::vector<sCubic>& p : pieces)
	{
		if (!p.empty())
		{
			out.push_back(CubicsToShape(p));
		}
	}
	return out;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Gradients                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

/** AE-style midpoint blend between two stops: at the midpoint the mix is 50%. */
f64 MidpointCurve(f64 t, f64 midpoint)
{
	const f64 m = JsMin(0.99, JsMax(0.01, midpoint));
	return std::pow(t, std::log(0.5) / std::log(m));
}

/** A ramp's stops as offset, midpoint and up to three values, for sampling. */
struct sStop
{
	f64 m_fOffset;
	f64 m_fMidpoint;
	f64 m_V[3];
};

void SampleStops(std::vector<sStop> stops, u32 count, f64 at, f64* out)
{
	if (stops.empty())
	{
		for (u32 k = 0; k < count; k++)
		{
			out[k] = NaN;
		}
		return;
	}
	std::stable_sort(stops.begin(), stops.end(), [](const sStop& a, const sStop& b) { return a.m_fOffset < b.m_fOffset; });
	if (at <= stops[0].m_fOffset)
	{
		std::copy(stops[0].m_V, stops[0].m_V + count, out);
		return;
	}
	for (size_t i = 0; i + 1 < stops.size(); i++)
	{
		const sStop& a = stops[i];
		const sStop& b = stops[i + 1];
		if (at <= b.m_fOffset)
		{
			const f64 span = b.m_fOffset - a.m_fOffset;
			const f64 t = span > 0 ? MidpointCurve((at - a.m_fOffset) / span, a.m_fMidpoint) : 1;
			for (u32 k = 0; k < count; k++)
			{
				out[k] = a.m_V[k] + (b.m_V[k] - a.m_V[k]) * t;
			}
			return;
		}
	}
	std::copy(stops.back().m_V, stops.back().m_V + count, out);
}

const sGradient& DefaultRamp()
{
	static const sGradient s_Ramp = [] {
		sGradient g;
		sGradientColorStop c0, c1;
		c0.m_fOffset = 0;
		c0.m_Color[0] = c0.m_Color[1] = c0.m_Color[2] = 1;
		c1.m_fOffset = 1;
		g.m_ColorStops = { c0, c1 };
		sGradientAlphaStop a0, a1;
		a0.m_fOffset = 0;
		a1.m_fOffset = 1;
		g.m_AlphaStops = { a0, a1 };
		return g;
	}();
	return s_Ramp;
}

inline f64 Unorm8(f64 v)
{
	return JsRound(JsMin(1, JsMax(0, v)) * 255) / 255;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Content evaluation                                                                                                 */
/* ------------------------------------------------------------------------------------------------------------------ */

/** A path whose geometry later modifiers may replace in place. */
struct sPathRecord
{
	std::vector<sShape> m_Pieces;
};

struct sPaintTarget
{
	std::shared_ptr<sPathRecord> m_pPath;
	/** Path space -> paint space. */
	sAffine m_ToPaint;
};

struct sDraw
{
	const CPropertyNode* m_pPaint = nullptr;
	std::vector<sPaintTarget> m_Targets;
	/** Paint space -> the evaluated group's space. */
	sAffine m_ToGroup;
	f64 m_fOpacity = 1;
};

struct sEvaluated
{
	std::vector<sPaintTarget> m_Paths;
	std::vector<sDraw> m_Draws;
};

bool IsPaint(const std::string& matchName)
{
	return matchName == "ADBE Vector Graphic - Fill" || matchName == "ADBE Vector Graphic - Stroke" ||
		matchName == "ADBE Vector Graphic - G-Fill" || matchName == "ADBE Vector Graphic - G-Stroke";
}

void GroupMatrix(const CReader& r, const CPropertyNode* transform, sAffine& matrix, f64& opacity)
{
	if (!transform)
	{
		matrix = sAffine();
		opacity = 1;
		return;
	}
	const sVecValue anchor = r.Vec(*transform, "ADBE Vector Anchor", { 0, 0 });
	const sVecValue position = r.Vec(*transform, "ADBE Vector Position", { 0, 0 });
	const sVecValue scale = r.Vec(*transform, "ADBE Vector Scale", { 100, 100 });
	const f64 skew = r.Num(*transform, "ADBE Vector Skew", 0) * DEG;
	const f64 axis = r.Num(*transform, "ADBE Vector Skew Axis", 0) * DEG;
	const f64 rotation = r.Num(*transform, "ADBE Vector Rotation", 0) * DEG;
	/** Skew shears along the axis direction: rotate the axis onto x, shear, rotate back. */
	const sAffine skewM = Truthy(skew) ? Mul(Rotate(-axis), Mul({ { 1, 0, std::tan(-skew), 1, 0, 0 } }, Rotate(axis))) : sAffine();
	matrix = Mul(Translate(position.At(0), position.At(1)),
		Mul(Rotate(rotation), Mul(skewM, Mul(Scale(scale.At(0) / 100, scale.At(1) / 100), Translate(-anchor.At(0), -anchor.At(1))))));
	opacity = r.Num(*transform, "ADBE Vector Group Opacity", 100) / 100;
}

sDraw LiftDraw(const sDraw& d, const sAffine& m, f64 opacity)
{
	sDraw out = d;
	out.m_ToGroup = Mul(m, d.m_ToGroup);
	out.m_fOpacity = d.m_fOpacity * opacity;
	return out;
}

std::shared_ptr<sPathRecord> NewRecord(sShape shape)
{
	auto record = std::make_shared<sPathRecord>();
	record->m_Pieces.push_back(std::move(shape));
	return record;
}

void ApplyTrim(const CReader& r, const CPropertyNode& item, std::vector<sPaintTarget>& paths)
{
	f64 s = r.Num(item, "ADBE Vector Trim Start", 0) / 100;
	f64 e = r.Num(item, "ADBE Vector Trim End", 100) / 100;
	if (s > e)
	{
		std::swap(s, e);
	}
	const f64 offset = r.Num(item, "ADBE Vector Trim Offset", 0) / 360;
	const bool individually = r.Num(item, "ADBE Vector Trim Type", 1) == 2;
	if (!individually)
	{
		for (sPaintTarget& p : paths)
		{
			std::vector<sShape> pieces;
			for (const sShape& shape : p.m_pPath->m_Pieces)
			{
				for (sShape& piece : TrimPath(shape, s + offset, e + offset))
				{
					pieces.push_back(std::move(piece));
				}
			}
			p.m_pPath->m_Pieces = std::move(pieces);
		}
		return;
	}
	/** Individually: the paths are trimmed as one, in stacking order. */
	std::vector<f64> lengths;
	f64 total = 0;
	for (const sPaintTarget& p : paths)
	{
		f64 sum = 0;
		for (const sShape& shape : p.m_pPath->m_Pieces)
		{
			sum += Measure(shape).m_fTotal;
		}
		lengths.push_back(sum);
		total += sum;
	}
	if (!(total > 0))
	{
		return;
	}
	f64 from = (s + offset) * total;
	from -= std::floor(from / total) * total;
	const f64 span = (e - s) * total;
	f64 start = 0;
	for (size_t i = 0; i < paths.size(); i++)
	{
		sPaintTarget& p = paths[i];
		const f64 len = lengths[i];
		std::vector<sShape> pieces;
		const f64 windows[2][2] = { { from, from + span }, { from - total, from + span - total } };
		for (const auto& window : windows)
		{
			const f64 a = JsMax(window[0], start) - start;
			const f64 b = JsMin(window[1], start + len) - start;
			if (b > a && len > 0)
			{
				for (const sShape& shape : p.m_pPath->m_Pieces)
				{
					for (sShape& piece : TrimPath(shape, a / len, b / len))
					{
						pieces.push_back(std::move(piece));
					}
				}
			}
		}
		p.m_pPath->m_Pieces = std::move(pieces);
		start += len;
	}
}

void ApplyRepeater(const CReader& r, const CPropertyNode& item, std::vector<sPaintTarget>& paths, std::vector<sDraw>& draws)
{
	const f64 copiesValue = JsRound(r.Num(item, "ADBE Vector Repeater Copies", 3));
	const s64 copies = copiesValue > 0 ? s64(copiesValue) : 0;
	const f64 offset = r.Num(item, "ADBE Vector Repeater Offset", 0);
	const bool above = r.Num(item, "ADBE Vector Repeater Order", 1) == 2;
	const CPropertyNode* t = r.Group(item, "ADBE Vector Repeater Transform");
	sVecValue anchor, position, scale;
	anchor.m_uCount = position.m_uCount = scale.m_uCount = 2;
	scale.m_V[0] = scale.m_V[1] = 100;
	f64 rotation = 0, startOpacity = 1, endOpacity = 1;
	if (t)
	{
		anchor = r.Vec(*t, "ADBE Vector Repeater Anchor", { 0, 0 });
		position = r.Vec(*t, "ADBE Vector Repeater Position", { 0, 0 });
		scale = r.Vec(*t, "ADBE Vector Repeater Scale", { 100, 100 });
		rotation = r.Num(*t, "ADBE Vector Repeater Rotation", 0) * DEG;
		startOpacity = r.Num(*t, "ADBE Vector Repeater Opacity 1", 100) / 100;
		endOpacity = r.Num(*t, "ADBE Vector Repeater Opacity 2", 100) / 100;
	}
	const f64 ax = anchor.At(0), ay = anchor.At(1);
	std::vector<sPaintTarget> basePaths;
	basePaths.swap(paths);
	std::vector<sDraw> baseDraws;
	baseDraws.swap(draws);
	std::vector<sEvaluated> copyLayers;
	for (s64 i = 0; i < copies; i++)
	{
		const f64 k = f64(i) + offset;
		const sAffine matrix = Mul(Translate(ax + position.At(0) * k, ay + position.At(1) * k),
			Mul(Rotate(rotation * k), Mul(Scale(std::pow(scale.At(0) / 100, k), std::pow(scale.At(1) / 100, k)), Translate(-ax, -ay))));
		/** AE steps opacity by 1/copies per copy, so the last copy stops short of the end opacity. */
		const f64 opacity = startOpacity + ((endOpacity - startOpacity) * f64(i)) / f64(std::max<s64>(1, copies));
		std::map<const sPathRecord*, std::shared_ptr<sPathRecord>> cloned;
		const auto clone = [&cloned](const std::shared_ptr<sPathRecord>& p) {
			auto& c = cloned[p.get()];
			if (!c)
			{
				c = std::make_shared<sPathRecord>(*p);
			}
			return c;
		};
		sEvaluated layer;
		for (const sPaintTarget& p : basePaths)
		{
			layer.m_Paths.push_back({ clone(p.m_pPath), Mul(matrix, p.m_ToPaint) });
		}
		for (const sDraw& d : baseDraws)
		{
			sDraw lifted = LiftDraw(d, matrix, opacity);
			for (sPaintTarget& target : lifted.m_Targets)
			{
				target.m_pPath = clone(target.m_pPath);
			}
			layer.m_Draws.push_back(std::move(lifted));
		}
		copyLayers.push_back(std::move(layer));
	}
	/** Draws are stored top first; "Below" stacks each copy under the previous one. */
	if (above)
	{
		std::reverse(copyLayers.begin(), copyLayers.end());
	}
	for (sEvaluated& c : copyLayers)
	{
		paths.insert(paths.end(), c.m_Paths.begin(), c.m_Paths.end());
		draws.insert(draws.end(), c.m_Draws.begin(), c.m_Draws.end());
	}
}

sEvaluated EvaluateItems(const CReader& r, const std::vector<std::unique_ptr<CPropertyNode>>& items)
{
	sEvaluated result;
	for (const auto& node : items)
	{
		const CPropertyNode& item = *node;
		if (!item.m_bGroup || !item.m_bEnabled)
		{
			continue;
		}
		const std::string& name = item.m_MatchName;
		if (name == "ADBE Vector Shape - Rect")
		{
			result.m_Paths.push_back({ NewRecord(RectPath(r, item)), sAffine() });
		}
		else if (name == "ADBE Vector Shape - Ellipse")
		{
			result.m_Paths.push_back({ NewRecord(EllipsePath(r, item)), sAffine() });
		}
		else if (name == "ADBE Vector Shape - Star")
		{
			result.m_Paths.push_back({ NewRecord(StarPath(r, item)), sAffine() });
		}
		else if (name == "ADBE Vector Shape - Group")
		{
			sShape shape;
			if (FreePath(r, item, shape))
			{
				result.m_Paths.push_back({ NewRecord(std::move(shape)), sAffine() });
			}
		}
		else if (name == "ADBE Vector Group")
		{
			const CPropertyNode* contents = r.Group(item, "ADBE Vectors Group");
			static const std::vector<std::unique_ptr<CPropertyNode>> s_Empty;
			const sEvaluated sub = EvaluateItems(r, contents ? contents->m_Children : s_Empty);
			sAffine matrix;
			f64 opacity;
			GroupMatrix(r, r.Group(item, "ADBE Vector Transform Group"), matrix, opacity);
			for (const sPaintTarget& p : sub.m_Paths)
			{
				result.m_Paths.push_back({ p.m_pPath, Mul(matrix, p.m_ToPaint) });
			}
			for (const sDraw& d : sub.m_Draws)
			{
				result.m_Draws.push_back(LiftDraw(d, matrix, opacity));
			}
		}
		else if (name == "ADBE Vector Filter - Trim")
		{
			ApplyTrim(r, item, result.m_Paths);
		}
		else if (name == "ADBE Vector Filter - Repeater")
		{
			ApplyRepeater(r, item, result.m_Paths, result.m_Draws);
		}
		else if (IsPaint(name))
		{
			sDraw draw;
			draw.m_pPaint = &item;
			draw.m_Targets = result.m_Paths;
			/** "Above Previous in Same Group" draws over the paint before it. */
			if (r.Num(item, "ADBE Vector Composite Order", 1) == 2 && !result.m_Draws.empty())
			{
				result.m_Draws.insert(result.m_Draws.end() - 1, std::move(draw));
			}
			else
			{
				result.m_Draws.push_back(std::move(draw));
			}
		}
	}
	return result;
}

bool DrawBounds(const std::vector<const sDraw*>& draws, const CReader& r, f64 (&bounds)[4])
{
	f64 x0 = std::numeric_limits<f64>::infinity();
	f64 y0 = x0;
	f64 x1 = -x0;
	f64 y1 = -x0;
	for (const sDraw* d : draws)
	{
		const bool stroked = d->m_pPaint->m_MatchName.find("Stroke") != std::string::npos;
		const f64 width = stroked ? r.Num(*d->m_pPaint, "ADBE Vector Stroke Width", 2) : 0;
		const f64 miter = stroked ? JsMax(1, r.Num(*d->m_pPaint, "ADBE Vector Stroke Miter Limit", 4)) : 1;
		const sAffine& g = d->m_ToGroup;
		const f64 scaleFactor = Hypot2(g.v[0], g.v[1]) + Hypot2(g.v[2], g.v[3]);
		const f64 grow = (width / 2) * miter * scaleFactor + 1;
		const auto add = [&](const sVec2& c) {
			x0 = JsMin(x0, c.x - grow);
			y0 = JsMin(y0, c.y - grow);
			x1 = JsMax(x1, c.x + grow);
			y1 = JsMax(y1, c.y + grow);
		};
		for (const sPaintTarget& t : d->m_Targets)
		{
			const sAffine m = Mul(g, t.m_ToPaint);
			for (const sShape& piece : t.m_pPath->m_Pieces)
			{
				const sShape s = TransformShape(piece, m);
				for (const sCubic& c : Segments(s))
				{
					for (const sVec2& p : c.m_P)
					{
						add(p);
					}
				}
				for (const sVec2& v : s.m_Vertices)
				{
					add(v);
				}
			}
		}
	}
	if (!std::isfinite(x0))
	{
		return false;
	}
	bounds[0] = x0;
	bounds[1] = y0;
	bounds[2] = x1;
	bounds[3] = y1;
	return true;
}

std::array<float, 2> F2(f64 x, f64 y)
{
	return { float(x), float(y) };
}

} /** namespace */

bool PlanShapeLayer(const CLayer& layer, f64 time, f64 imageScale, f64 pad, sShapeLayerPlan& out)
{
	const CPropertyNode* root = layer.m_Properties.FindGroup("ADBE Root Vectors Group");
	if (!root)
	{
		return false;
	}
	const CReader r(layer, time);
	const sEvaluated evaluated = EvaluateItems(r, root->m_Children);
	std::vector<const sDraw*> visible;
	for (const sDraw& d : evaluated.m_Draws)
	{
		bool any = false;
		for (const sPaintTarget& t : d.m_Targets)
		{
			any = any || !t.m_pPath->m_Pieces.empty();
		}
		if (d.m_fOpacity > 0 && any)
		{
			visible.push_back(&d);
		}
	}
	f64 bounds[4];
	if (!DrawBounds(visible, r, bounds))
	{
		return false;
	}
	const f64 x0 = std::floor(bounds[0] * imageScale);
	const f64 y0 = std::floor(bounds[1] * imageScale);
	const f64 width = JsMin(MAX_RASTER, std::ceil(bounds[2] * imageScale) - x0);
	const f64 height = JsMin(MAX_RASTER, std::ceil(bounds[3] * imageScale) - y0);
	if (!(width > 0) || !(height > 0))
	{
		return false;
	}
	const sAffine toImage = Mul(Translate(pad - x0, pad - y0), Scale(imageScale, imageScale));
	out = sShapeLayerPlan();
	for (auto it = visible.rbegin(); it != visible.rend(); ++it)
	{
		const sDraw& d = **it;
		const CPropertyNode& paintNode = *d.m_pPaint;
		const std::string& kind = paintNode.m_MatchName;
		const bool stroke = kind == "ADBE Vector Graphic - Stroke" || kind == "ADBE Vector Graphic - G-Stroke";
		const f64 strokeWidth = stroke ? r.Num(paintNode, "ADBE Vector Stroke Width", 2) : 0;
		if (stroke && strokeWidth <= 0)
		{
			continue;
		}
		if (stroke)
		{
			/** dashPattern: any Dash or Gap property stored in the file marks the stroke as dashed. */
			if (const CPropertyNode* dashes = r.Group(paintNode, "ADBE Vector Stroke Dashes"))
			{
				for (const auto& node : dashes->m_Children)
				{
					const std::string& m = node->m_MatchName;
					if (node->m_bGroup || node->m_bSynthesized || m == "ADBE Vector Stroke Offset")
					{
						continue;
					}
					static const std::regex s_Dash("Dash \\d|Gap \\d");
					if (std::regex_search(m, s_Dash))
					{
						out.m_bDashed = true;
					}
				}
			}
		}
		aevk::ShapePaint paint;
		paint.stroke = stroke;
		const sAffine matrix = Mul(toImage, d.m_ToGroup);
		for (s32 i = 0; i < 6; i++)
		{
			paint.matrix[size_t(i)] = float(matrix.v[i]);
		}
		for (const sPaintTarget& t : d.m_Targets)
		{
			for (const sShape& piece : t.m_pPath->m_Pieces)
			{
				const sShape s = TransformShape(piece, t.m_ToPaint);
				if (s.m_Vertices.empty())
				{
					continue;
				}
				aevk::ShapePath path;
				path.closed = s.m_bClosed;
				for (size_t i = 0; i < s.m_Vertices.size(); i++)
				{
					const sVec2 in = i < s.m_InTangents.size() ? s.m_InTangents[i] : sVec2{ NaN, NaN };
					const sVec2 o = i < s.m_OutTangents.size() ? s.m_OutTangents[i] : sVec2{ NaN, NaN };
					const f64 v[6] = { s.m_Vertices[i].x, s.m_Vertices[i].y, in.x, in.y, o.x, o.y };
					for (const f64 x : v)
					{
						path.vertices.push_back(float(x));
					}
				}
				paint.paths.push_back(std::move(path));
			}
		}
		paint.evenOdd = !stroke && r.Num(paintNode, "ADBE Vector Fill Rule", 1) == 2;
		paint.width = float(strokeWidth);
		paint.cap = stroke ? ToUint32(r.Num(paintNode, "ADBE Vector Stroke Line Cap", 1)) : 1;
		paint.join = stroke ? ToUint32(r.Num(paintNode, "ADBE Vector Stroke Line Join", 1)) : 1;
		paint.miterLimit = float(stroke ? r.Num(paintNode, "ADBE Vector Stroke Miter Limit", 4) : 4);
		if (kind == "ADBE Vector Graphic - Fill" || kind == "ADBE Vector Graphic - Stroke")
		{
			const sVecValue c = r.Vec(paintNode, stroke ? "ADBE Vector Stroke Color" : "ADBE Vector Fill Color", { 1, 1, 1, 1 });
			const f64 a = (r.Num(paintNode, stroke ? "ADBE Vector Stroke Opacity" : "ADBE Vector Fill Opacity", 100) / 100) * d.m_fOpacity;
			paint.color = { float(Unorm8(c.At(0))), float(Unorm8(c.At(1))), float(Unorm8(c.At(2))), float(Unorm8(a)) };
		}
		else
		{
			const sVecValue start = r.Vec(paintNode, "ADBE Vector Grad Start Pt", { 0, 0 });
			const sVecValue end = r.Vec(paintNode, "ADBE Vector Grad End Pt", { 100, 0 });
			const f64 sx = start.At(0), sy = start.At(1), ex = end.At(0), ey = end.At(1);
			const std::shared_ptr<const sGradient> found = r.Gradient(paintNode, "ADBE Vector Grad Colors");
			const sGradient& ramp = found ? *found : DefaultRamp();
			const f64 opacity =
				(r.Num(paintNode, "ADBE Vector Fill Opacity", r.Num(paintNode, "ADBE Vector Stroke Opacity", 100)) / 100) * d.m_fOpacity;
			const bool radial = r.Num(paintNode, "ADBE Vector Grad Type", 1) == 2;
			f64 fx = sx, fy = sy;
			if (radial)
			{
				const f64 radius = Hypot2(ex - sx, ey - sy);
				const f64 length = JsMax(-0.99, JsMin(0.99, r.Num(paintNode, "ADBE Vector Grad HiLite Length", 0) / 100));
				const f64 angle = std::atan2(ey - sy, ex - sx) + r.Num(paintNode, "ADBE Vector Grad HiLite Angle", 0) * DEG;
				fx = sx + std::cos(angle) * radius * length;
				fy = sy + std::sin(angle) * radius * length;
			}
			std::vector<sStop> colorStops, alphaStops;
			for (const sGradientColorStop& s : ramp.m_ColorStops)
			{
				colorStops.push_back({ s.m_fOffset, s.m_fMidpoint, { s.m_Color[0], s.m_Color[1], s.m_Color[2] } });
			}
			for (const sGradientAlphaStop& s : ramp.m_AlphaStops)
			{
				alphaStops.push_back({ s.m_fOffset, s.m_fMidpoint, { s.m_fAlpha, 0, 0 } });
			}
			for (s32 i = 0; i <= GRADIENT_STOPS; i++)
			{
				const f64 at = f64(i) / GRADIENT_STOPS;
				f64 c[3];
				f64 a = 1;
				SampleStops(colorStops, 3, at, c);
				if (!alphaStops.empty())
				{
					SampleStops(alphaStops, 1, at, &a);
				}
				paint.ramp.push_back(float(Unorm8(c[0])));
				paint.ramp.push_back(float(Unorm8(c[1])));
				paint.ramp.push_back(float(Unorm8(c[2])));
				paint.ramp.push_back(float(Unorm8(a * opacity)));
			}
			paint.gradient = radial ? 2 : 1;
			paint.start = F2(sx, sy);
			paint.end = F2(ex, ey);
			paint.focus = F2(fx, fy);
		}
		out.m_Paints.push_back(std::move(paint));
	}
	out.m_fOriginX = x0;
	out.m_fOriginY = y0;
	out.m_fWidth = width;
	out.m_fHeight = height;
	return true;
}

} /** namespace aep */
