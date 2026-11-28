/**
 * Project parser (src/aep/parse.ts, decode.ts, footage.ts, and the Transform part of synthesize.ts). Chunk offsets
 * follow py-aep's chunk definitions (MIT, https://github.com/forticheprod/py-aep).
 */
#include "parse.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <map>
#include <regex>

namespace aep
{

namespace
{

/** Big-endian reads of a chunk body; reads past the end give 0, as decode.ts's Bytes does. */
class CBytes
{
public:
	CBytes(const u8* data, size_t size) : m_pData(data), m_uSize(size) {}
	explicit CBytes(const CChunk& chunk) : m_pData(chunk.m_pData), m_uSize(chunk.m_uSize) {}

	size_t Size() const { return m_uSize; }
	bool Has(size_t offset, size_t size) const { return offset + size <= m_uSize; }

	u8 U8(size_t o) const { return Has(o, 1) ? m_pData[o] : 0; }

	u16 U16(size_t o) const { return Has(o, 2) ? u16((u16(m_pData[o]) << 8) | m_pData[o + 1]) : 0; }

	u32 U32(size_t o) const
	{
		if (!Has(o, 4))
		{
			return 0;
		}
		return (u32(m_pData[o]) << 24) | (u32(m_pData[o + 1]) << 16) | (u32(m_pData[o + 2]) << 8) | u32(m_pData[o + 3]);
	}

	s32 S32(size_t o) const { return s32(U32(o)); }

	f32 F32(size_t o) const
	{
		const u32 bits = U32(o);
		f32 v;
		std::memcpy(&v, &bits, 4);
		return v;
	}

	f64 F64(size_t o, bool littleEndian = false) const
	{
		if (!Has(o, 8))
		{
			return 0;
		}
		u64 bits = 0;
		for (s32 i = 0; i < 8; i++)
		{
			const u8 b = littleEndian ? m_pData[o + 7 - i] : m_pData[o + i];
			bits = (bits << 8) | b;
		}
		f64 v;
		std::memcpy(&v, &bits, 8);
		return v;
	}

	bool Bit(size_t o, s32 bit) const { return ((U8(o) >> bit) & 1) == 1; }

	/** Text of up to `size` bytes at `o`, up to the first NUL. */
	std::string CStr(size_t o, size_t size) const
	{
		if (o >= m_uSize)
		{
			return std::string();
		}
		const size_t end = std::min(o + size, m_uSize);
		size_t n = 0;
		while (o + n < end && m_pData[o + n] != 0)
		{
			n++;
		}
		return std::string(reinterpret_cast<const char*>(m_pData + o), n);
	}

private:
	const u8* m_pData;
	size_t m_uSize;
};

f64 Ratio(f64 dividend, f64 divisor)
{
	return divisor != 0 ? dividend / divisor : 0;
}

constexpr FourCC FCC(const char (&text)[5])
{
	return MakeFourCC(text);
}

std::string TextOf(const CChunk* chunk)
{
	if (!chunk)
	{
		return std::string();
	}
	return std::string(reinterpret_cast<const char*>(chunk->m_pData), chunk->m_uSize);
}

/** `tdmn`: a NUL-padded match name. */
std::string MatchNameOf(const CChunk& chunk)
{
	return CBytes(chunk).CStr(0, chunk.m_uSize);
}

/** Text of the Utf8 child of a container chunk (`tdsn`, `fnam`), and whether there is one. */
bool ContainerText(const CChunk* chunk, std::string& text)
{
	const CChunk* inner = FindChild(chunk, FCC("Utf8"));
	if (!inner)
	{
		return false;
	}
	text = TextOf(inner);
	return true;
}

/** The ExtendScript BlendingMode of each stored blend mode byte. */
u32 BlendingMode(u32 raw)
{
	static const std::map<u32, u32> s_Modes = {
		{ 0, 5212 }, { 2, 5212 }, { 3, 5213 }, { 4, 5220 }, { 5, 5216 }, { 6, 5222 }, { 7, 5226 }, { 8, 5227 },
		{ 9, 5228 }, { 10, 5215 }, { 11, 5221 }, { 12, 5234 }, { 13, 5236 }, { 14, 5237 }, { 15, 5238 },
		{ 16, 5239 }, { 17, 5240 }, { 18, 5241 }, { 19, 5242 }, { 20, 5243 }, { 21, 5245 }, { 22, 5244 },
		{ 23, 5225 }, { 24, 5219 }, { 25, 5235 }, { 26, 5233 }, { 27, 5224 }, { 28, 5218 }, { 29, 5223 },
		{ 30, 5217 }, { 31, 5229 }, { 32, 5230 }, { 33, 5231 }, { 34, 5232 }, { 35, 5246 }, { 36, 5247 },
		{ 37, 5248 }, { 38, 5249 },
	};
	const auto found = s_Modes.find(raw);
	return found != s_Modes.end() ? found->second : 5212;
}

const u32 DANCING_DISSOLVE = 5214;

/** `tdb4`: a property's flags. */
struct sTdb4
{
	u32 m_uDimensions = 1;
	bool m_bSpatial = false;
	bool m_bNoValue = false;
	bool m_bVector = false;
	bool m_bInteger = false;
	bool m_bColor = false;
	bool m_bExpressionDisabled = false;
};

sTdb4 DecodeTdb4(const CChunk& chunk)
{
	const CBytes b(chunk);
	sTdb4 t;
	t.m_uDimensions = b.U16(2);
	t.m_bSpatial = b.Bit(5, 3);
	t.m_bNoValue = b.Bit(57, 0);
	t.m_bVector = b.Bit(59, 3);
	t.m_bInteger = b.Bit(59, 2);
	t.m_bColor = b.Bit(59, 0);
	t.m_bExpressionDisabled = b.Bit(119, 0);
	return t;
}

u32 ValueTypeFromFlags(const sTdb4& t)
{
	if (t.m_bColor)
	{
		return PVT_COLOR;
	}
	if (t.m_bInteger && t.m_uDimensions <= 1)
	{
		return PVT_ONE_D;
	}
	if (t.m_bVector || (t.m_bInteger && t.m_uDimensions > 1))
	{
		if (t.m_uDimensions == 2)
		{
			return t.m_bSpatial ? PVT_TWO_D_SPATIAL : PVT_TWO_D;
		}
		if (t.m_uDimensions == 3)
		{
			return t.m_bSpatial ? PVT_THREE_D_SPATIAL : PVT_THREE_D;
		}
		return PVT_ONE_D;
	}
	if (t.m_bNoValue)
	{
		return PVT_NO_VALUE;
	}
	if (t.m_uDimensions == 1)
	{
		return PVT_ONE_D;
	}
	return PVT_NO_VALUE;
}

/** Keyframe item layouts, from `lhd3`'s item type and size. */
enum eLdatKind
{
	LDAT_UNKNOWN,
	LDAT_COLOR,
	LDAT_THREE_D_SPATIAL,
	LDAT_THREE_D,
	LDAT_TWO_D_SPATIAL,
	LDAT_TWO_D,
	LDAT_ONE_D,
	LDAT_NO_VALUE,
	LDAT_ORIENTATION,
	LDAT_SHAPE,
	LDAT_MARKER,
	LDAT_OTHER,
};

struct sLhd3
{
	u32 m_uCount = 0;
	u32 m_uItemSize = 0;
	eLdatKind m_eKind = LDAT_UNKNOWN;
};

sLhd3 DecodeLhd3(const CChunk& chunk)
{
	const CBytes b(chunk);
	sLhd3 h;
	h.m_uCount = b.U16(10);
	h.m_uItemSize = b.U16(18);
	const u32 type = b.U8(23);
	const u32 size = h.m_uItemSize;
	if (type == 4)
	{
		switch (size)
		{
		case 152: h.m_eKind = LDAT_COLOR; break;
		case 128: h.m_eKind = LDAT_THREE_D; break;
		case 104: h.m_eKind = LDAT_TWO_D_SPATIAL; break;
		case 88: h.m_eKind = LDAT_TWO_D; break;
		case 80: h.m_eKind = LDAT_ORIENTATION; break;
		case 64: h.m_eKind = LDAT_NO_VALUE; break;
		case 48: h.m_eKind = LDAT_ONE_D; break;
		case 16: h.m_eKind = LDAT_MARKER; break;
		case 8: h.m_eKind = LDAT_SHAPE; break;
		default: break;
		}
	}
	else if ((type == 1 && (size == 2246 || size == 128)) || (type == 2 && size == 16))
	{
		h.m_eKind = LDAT_OTHER;
	}
	return h;
}

u32 KindDimensions(eLdatKind kind)
{
	switch (kind)
	{
	case LDAT_THREE_D:
	case LDAT_THREE_D_SPATIAL: return 3;
	case LDAT_TWO_D:
	case LDAT_TWO_D_SPATIAL: return 2;
	case LDAT_ONE_D: return 1;
	default: return 0;
	}
}

/** A keyframe as stored (raw units; color is ARGB 0-255). */
struct sRawKeyframe
{
	s32 m_iTimeUnits = 0;
	u32 m_uIn = 1;
	u32 m_uOut = 1;
	bool m_bRoving = false;
	bool m_bTemporalAutoBezier = false;
	bool m_bTemporalContinuous = false;
	bool m_bSpatialAutoBezier = false;
	bool m_bSpatialContinuous = false;
	u32 m_uValueCount = 0;
	f64 m_Value[4] = { 0, 0, 0, 0 };
	u32 m_uInEaseCount = 0;
	u32 m_uOutEaseCount = 0;
	sEase m_InEase[3];
	sEase m_OutEase[3];
	u32 m_uSpatialCount = 0;
	f64 m_InSpatial[3] = { 0, 0, 0 };
	f64 m_OutSpatial[3] = { 0, 0, 0 };
};

sRawKeyframe DecodeKeyframe(const CBytes& item, eLdatKind kind)
{
	sRawKeyframe kf;
	const u8 flags = item.U8(7);
	kf.m_iTimeUnits = item.S32(0);
	kf.m_uIn = item.U8(4);
	kf.m_uOut = item.U8(5);
	kf.m_bRoving = ((flags >> 5) & 1) == 1;
	kf.m_bTemporalAutoBezier = ((flags >> 4) & 1) == 1;
	kf.m_bTemporalContinuous = ((flags >> 3) & 1) == 1;
	const size_t p = 8;
	const u32 n = KindDimensions(kind);
	if (kind == LDAT_COLOR)
	{
		kf.m_uInEaseCount = kf.m_uOutEaseCount = 1;
		kf.m_InEase[0] = { item.F64(p + 16), item.F64(p + 24) };
		kf.m_OutEase[0] = { item.F64(p + 32), item.F64(p + 40) };
		kf.m_uValueCount = 4;
		for (u32 i = 0; i < 4; i++)
		{
			kf.m_Value[i] = item.F64(p + 48 + i * 8);
		}
	}
	else if (kind == LDAT_NO_VALUE || kind == LDAT_ORIENTATION || kind == LDAT_SHAPE)
	{
		if (item.Has(p, 48))
		{
			kf.m_uInEaseCount = kf.m_uOutEaseCount = 1;
			kf.m_InEase[0] = { item.F64(p + 16), item.F64(p + 24) };
			kf.m_OutEase[0] = { item.F64(p + 32), item.F64(p + 40) };
		}
	}
	else if ((kind == LDAT_THREE_D_SPATIAL || kind == LDAT_TWO_D_SPATIAL) && n)
	{
		const u8 spatialFlags = item.U8(p + 3);
		kf.m_bSpatialAutoBezier = ((spatialFlags >> 1) & 1) == 1;
		kf.m_bSpatialContinuous = (spatialFlags & 1) == 1;
		const size_t d = p + 8;
		kf.m_uInEaseCount = kf.m_uOutEaseCount = 1;
		kf.m_InEase[0] = { item.F64(d + 8), item.F64(d + 16) };
		kf.m_OutEase[0] = { item.F64(d + 24), item.F64(d + 32) };
		const size_t v = d + 40;
		kf.m_uValueCount = n;
		kf.m_uSpatialCount = n;
		for (u32 i = 0; i < n; i++)
		{
			kf.m_Value[i] = item.F64(v + i * 8);
			kf.m_InSpatial[i] = item.F64(v + (n + i) * 8);
			kf.m_OutSpatial[i] = item.F64(v + (2 * n + i) * 8);
		}
	}
	else if (n)
	{
		kf.m_uValueCount = n;
		kf.m_uInEaseCount = kf.m_uOutEaseCount = n;
		for (u32 i = 0; i < n; i++)
		{
			kf.m_Value[i] = item.F64(p + (0 * n + i) * 8);
			kf.m_InEase[i] = { item.F64(p + (1 * n + i) * 8), item.F64(p + (2 * n + i) * 8) };
			kf.m_OutEase[i] = { item.F64(p + (3 * n + i) * 8), item.F64(p + (4 * n + i) * 8) };
		}
	}
	return kf;
}

/** Splits an `ldat` body into fixed-size items. */
std::vector<CBytes> LdatItems(const CChunk& ldat, const sLhd3& lhd3)
{
	std::vector<CBytes> items;
	if (!lhd3.m_uItemSize)
	{
		return items;
	}
	for (u32 i = 0; i < lhd3.m_uCount; i++)
	{
		const size_t start = size_t(i) * lhd3.m_uItemSize;
		if (start + lhd3.m_uItemSize > ldat.m_uSize)
		{
			break;
		}
		items.emplace_back(ldat.m_pData + start, lhd3.m_uItemSize);
	}
	return items;
}

/** `ldta`: a layer's settings. */
struct sLdta
{
	u32 m_uId = 0;
	f64 m_fStretch = 0;
	f64 m_fStartTime = 0;
	f64 m_fRawInPoint = 0;
	f64 m_fRawOutPoint = 0;
	bool m_bCharactersTowardCamera = false;
	bool m_bThreeDPerChar = false;
	bool m_bGuide = false;
	bool m_bNull = false;
	bool m_bPoiAutoOrient = false;
	bool m_bCameraOrPoiAutoOrient = false;
	bool m_bSolo = false;
	bool m_bThreeD = false;
	bool m_bAdjustment = false;
	bool m_bAutoOrientAlongPath = false;
	bool m_bEffectsActive = false;
	bool m_bAudioEnabled = false;
	bool m_bEnabled = false;
	u32 m_uSourceId = 0;
	std::string m_Name;
	u32 m_uBlendingModeRaw = 0;
	bool m_bDancingDissolve = false;
	u32 m_uTrackMatteTypeRaw = 0;
	u32 m_uLayerType = 0;
	u32 m_uParentId = 0;
	bool m_bHasMatteLayerId = false;
	u32 m_uMatteLayerId = 0;
};

sLdta DecodeLdta(const CChunk& chunk)
{
	const CBytes b(chunk);
	sLdta l;
	const u32 stretchDivisor = b.U32(108);
	l.m_uId = b.U32(0);
	l.m_fStretch = stretchDivisor ? (f64(b.S32(8)) * 100) / stretchDivisor : 0;
	l.m_fStartTime = Ratio(b.S32(12), b.U32(16));
	l.m_fRawInPoint = Ratio(b.S32(20), b.U32(24));
	l.m_fRawOutPoint = Ratio(b.S32(28), b.U32(32));
	l.m_bCharactersTowardCamera = b.Bit(37, 4);
	l.m_bThreeDPerChar = b.Bit(37, 3);
	l.m_bGuide = b.Bit(37, 1);
	l.m_bNull = b.Bit(38, 7);
	l.m_bPoiAutoOrient = b.Bit(38, 6);
	l.m_bCameraOrPoiAutoOrient = b.Bit(38, 5);
	l.m_bSolo = b.Bit(38, 3);
	l.m_bThreeD = b.Bit(38, 2);
	l.m_bAdjustment = b.Bit(38, 1);
	l.m_bAutoOrientAlongPath = b.Bit(38, 0);
	l.m_bEffectsActive = b.Bit(39, 2);
	l.m_bAudioEnabled = b.Bit(39, 1);
	l.m_bEnabled = b.Bit(39, 0);
	l.m_uSourceId = b.U32(40);
	l.m_Name = b.CStr(64, 32);
	l.m_uBlendingModeRaw = b.U8(99);
	l.m_bDancingDissolve = b.Bit(103, 1);
	l.m_uTrackMatteTypeRaw = b.U8(107);
	l.m_uLayerType = b.U8(131);
	l.m_uParentId = b.U32(132);
	l.m_bHasMatteLayerId = b.Has(160, 4);
	l.m_uMatteLayerId = b.U32(160);
	return l;
}

/** `cdta`: a comp's settings. */
struct sCdta
{
	u32 m_uInternalTimebase = 0;
	f64 m_fDuration = 0;
	f64 m_BgColor[3] = { 0, 0, 0 };
	f64 m_fWidth = 0;
	f64 m_fHeight = 0;
	f64 m_fPixelAspect = 1;
	f64 m_fFrameRate = 0;
};

sCdta DecodeCdta(const CChunk& chunk)
{
	const CBytes b(chunk);
	sCdta c;
	c.m_uInternalTimebase = b.U32(8);
	c.m_fDuration = Ratio(b.U32(44), b.U32(48));
	for (s32 i = 0; i < 3; i++)
	{
		c.m_BgColor[i] = b.U8(52 + i) / 255.0;
	}
	c.m_fWidth = b.U16(140);
	c.m_fHeight = b.U16(142);
	c.m_fPixelAspect = Ratio(b.U32(144), b.U32(148));
	if (c.m_fPixelAspect == 0)
	{
		c.m_fPixelAspect = 1;
	}
	c.m_fFrameRate = b.U16(156) + b.U16(158) / 65536.0;
	return c;
}

/** The value type a declared effect control gives its parameter (EFFECT_VALUE_TYPES); 0 when it gives none. */
u32 EffectValueType(u32 controlType)
{
	switch (controlType)
	{
	case CONTROL_LAYER:
		return PVT_LAYER_INDEX;
	case CONTROL_INTEGER:
	case CONTROL_SCALAR:
	case CONTROL_ANGLE:
	case CONTROL_CHECKBOX:
	case CONTROL_POPUP:
	case CONTROL_FLOAT_SLIDER:
		return PVT_ONE_D;
	case CONTROL_COLOR:
		return PVT_COLOR;
	case CONTROL_POINT:
		return PVT_TWO_D_SPATIAL;
	case CONTROL_NO_DATA:
	case CONTROL_GROUP_START:
	case CONTROL_GROUP_END:
	case CONTROL_BUTTON:
		return PVT_NO_VALUE;
	case CONTROL_ARBITRARY:
		return PVT_CUSTOM_VALUE;
	case CONTROL_PATH:
		return PVT_MASK_INDEX;
	case CONTROL_POINT_3D:
		return PVT_THREE_D_SPATIAL;
	default:
		return 0;
	}
}

/** `pard`: an effect parameter's declaration (decodePard). Values a control type does not store are left out. */
struct sPard
{
	u32 m_uControlType = 0;
	std::string m_Name;
	bool m_bCanVaryOverTime = true;
	u32 m_uLastCount = 0;
	f64 m_Last[4] = {};
	u32 m_uDefaultCount = 0;
	f64 m_Default[4] = {};
};

sPard DecodePard(const CChunk& chunk)
{
	const CBytes b(chunk);
	sPard pard;
	pard.m_uControlType = b.U8(15);
	pard.m_Name = b.CStr(16, 32);
	pard.m_bCanVaryOverTime = (b.U8(51) & 0x02) == 0;
	const size_t body = 56;
	const auto last = [&pard](std::initializer_list<f64> values)
	{
		pard.m_uLastCount = 0;
		for (f64 v : values)
		{
			pard.m_Last[pard.m_uLastCount++] = v;
		}
	};
	const auto fallback = [&pard](std::initializer_list<f64> values)
	{
		pard.m_uDefaultCount = 0;
		for (f64 v : values)
		{
			pard.m_Default[pard.m_uDefaultCount++] = v;
		}
	};
	const auto argb = [&b](size_t o, f64* out)
	{
		out[0] = b.U8(o + 1) / 255.0;
		out[1] = b.U8(o + 2) / 255.0;
		out[2] = b.U8(o + 3) / 255.0;
		out[3] = b.U8(o) / 255.0;
	};
	switch (pard.m_uControlType)
	{
	case 1:
		last({ f64(b.S32(body)) });
		if (b.Has(body + 76, 12))
		{
			fallback({ f64(b.S32(body + 84)) });
		}
		break;
	case 2:
		last({ b.S32(body) / 65536.0 });
		if (b.Has(body + 84, 4))
		{
			fallback({ b.S32(body + 84) / 65536.0 });
		}
		break;
	case 3:
		last({ b.S32(body) / 65536.0 });
		if (b.Has(body + 4, 4))
		{
			fallback({ b.S32(body + 4) / 65536.0 });
		}
		break;
	case 4:
		last({ f64(b.U32(body)) });
		fallback({ f64(b.U8(body + 4)) });
		break;
	case 5:
		argb(body, pard.m_Last);
		pard.m_uLastCount = 4;
		argb(body + 4, pard.m_Default);
		pard.m_uDefaultCount = 4;
		break;
	case 6:
		last({ b.S32(body) / 128.0, b.S32(body + 4) / 128.0 });
		break;
	case 7:
		last({ f64(b.U32(body)) });
		fallback({ f64(b.U16(body + 6)) });
		break;
	case 10:
		last({ b.F64(body) });
		if (b.Has(body + 64, 4))
		{
			fallback({ f64(b.F32(body + 64)) });
		}
		break;
	case 18:
		last({ b.F64(body) * 512, b.F64(body + 8) * 512, b.F64(body + 16) * 512 });
		break;
	default:
		break;
	}
	return pard;
}

/** An effect parameter as its effect declares it (ParamDef). */
struct sParamDef
{
	std::string m_MatchName;
	sPard m_Pard;
	std::string m_Name;
	bool m_bHasOptions = false;
	std::vector<std::string> m_Options;
};

/** The parameter declarations a property parse is inside (LeafOptions). */
struct sLeafOptions
{
	bool m_bInEffect = false;
	const std::map<std::string, const sParamDef*>* m_pDefs = nullptr;

	const sParamDef* Def(const std::string& matchName) const
	{
		if (!m_pDefs)
		{
			return nullptr;
		}
		const auto found = m_pDefs->find(matchName);
		return found != m_pDefs->end() ? found->second : nullptr;
	}
};

/** Per-layer state the property parser needs. */
struct sLayerContext
{
	const sLdta* m_pLdta = nullptr;
	u32 m_uInternalTimebase = 0;
	f64 m_fStretchFactor = 1;
	bool m_bHasSource = false;
	f64 m_fWidth = 0;
	f64 m_fHeight = 0;
	bool m_bThreeD = false;
	const std::map<u32, s32>* m_pLayerIndexById = nullptr;
	std::vector<std::string>* m_pWarnings = nullptr;

	/** Keyframe time units per layer second. */
	f64 TimeBase() const
	{
		const f64 base = std::floor(m_uInternalTimebase * std::max(1.0, std::fabs(m_fStretchFactor)));
		return base != 0 ? base : 1;
	}

	/** Layer seconds to comp seconds: `layerTime * stretch + offset`. */
	f64 Offset() const
	{
		return m_fStretchFactor >= 0 ? m_pLdta->m_fStartTime : m_pLdta->m_fStartTime - std::fabs(m_fStretchFactor) / 3000;
	}
};

/** Converts stored units to the units ExtendScript reports (ValueResolver). */
class CValueResolver
{
public:
	CValueResolver(const std::string& matchName, const sTdb4* tdb4, const sLayerContext& ctx, bool inEffect = false,
		u32 controlType = CONTROL_NONE)
	{
		m_bPercent = matchName == "ADBE Opacity" || matchName == "ADBE Scale" || matchName == "ADBE Mask Opacity";
		m_bColor = controlType == CONTROL_COLOR || (tdb4 && tdb4->m_bColor);
		m_uDimensions = tdb4 ? tdb4->m_uDimensions : 1;
		m_bFlattenScaleZ = matchName == "ADBE Scale" && !ctx.m_bThreeD;
		/** Values an effect creates without declaring them (a puppet pin) count as points by their flags. */
		const bool flaggedPoint = controlType == CONTROL_NONE && tdb4 && tdb4->m_bVector &&
			(tdb4->m_uDimensions == 2 || tdb4->m_uDimensions == 3);
		const bool point = controlType == CONTROL_POINT || controlType == CONTROL_POINT_3D || flaggedPoint;
		if (matchName == "ADBE Anchor Point" && ctx.m_bHasSource)
		{
			if (ctx.m_fWidth != 0 && ctx.m_fHeight != 0)
			{
				m_bScale = true;
				m_Scale[0] = ctx.m_fWidth;
				m_Scale[1] = ctx.m_fHeight;
				m_Scale[2] = 1;
			}
		}
		else if (inEffect && ctx.m_fWidth != 0 && ctx.m_fHeight != 0 && point)
		{
			/** Effect points are stored as fractions of the layer; Z shares the height divisor. */
			m_bScale = true;
			m_Scale[0] = ctx.m_fWidth;
			m_Scale[1] = ctx.m_fHeight;
			m_Scale[2] = ctx.m_fHeight;
			m_fSpeedFactor = ctx.m_fHeight;
		}
	}

	CValue Value(const f64* raw, u32 count) const
	{
		if (!count)
		{
			return CValue();
		}
		f64 v[CValue::MAX_COMPONENTS];
		u32 n = std::min(count, std::max(m_uDimensions, m_bColor ? 4u : 1u));
		n = std::min(n, CValue::MAX_COMPONENTS);
		for (u32 i = 0; i < n; i++)
		{
			v[i] = m_bPercent ? raw[i] * 100 : raw[i];
		}
		if (m_bFlattenScaleZ && n >= 3)
		{
			v[2] = 100;
		}
		if (m_bColor && n == 4)
		{
			const f64 a = v[0], r = v[1], g = v[2], b = v[3];
			v[0] = r / 255;
			v[1] = g / 255;
			v[2] = b / 255;
			v[3] = a / 255;
		}
		Scale(v, n);
		if (n == 1 && !m_bColor)
		{
			return CValue::Number(v[0]);
		}
		return CValue::Vector(v, n);
	}

	void Scale(f64* v, u32 n) const
	{
		if (!m_bScale)
		{
			return;
		}
		for (u32 i = 0; i < n && i < 3; i++)
		{
			v[i] *= m_Scale[i];
		}
	}

	/** Ease speeds of effect points are stored against the layer height. */
	f64 Speed(f64 raw) const { return (m_bPercent ? raw * 100 : raw) * m_fSpeedFactor; }

private:
	bool m_bPercent = false;
	bool m_bColor = false;
	u32 m_uDimensions = 1;
	bool m_bFlattenScaleZ = false;
	bool m_bScale = false;
	f64 m_Scale[3] = { 1, 1, 1 };
	f64 m_fSpeedFactor = 1;
};

u32 InterpolationType(u32 raw)
{
	return raw >= 1 && raw <= 3 ? raw + 6611 : INTERP_LINEAR;
}

/**
 * AE ignores the stored tangents of a spatial auto-bezier keyframe and derives them: one sixth of the chord between
 * its neighbours, mirrored for the in side.
 */
void ApplyAutoSpatialTangents(std::vector<sKeyframe>& keys)
{
	const size_t count = keys.size();
	for (size_t i = 0; i < count; i++)
	{
		sKeyframe& kf = keys[i];
		if (!kf.m_bSpatialAutoBezier || !kf.m_uSpatialCount || !kf.m_Value.IsVector())
		{
			continue;
		}
		const CValue& here = kf.m_Value;
		const CValue* prev = i > 0 ? &keys[i - 1].m_Value : nullptr;
		const CValue* next = i + 1 < count ? &keys[i + 1].m_Value : nullptr;
		const CValue& low = prev && prev->IsVector() ? *prev : here;
		const CValue& high = next && next->IsVector() ? *next : here;
		const u32 n = std::min<u32>(here.m_uCount, 3);
		kf.m_uSpatialCount = u8(n);
		for (u32 d = 0; d < n; d++)
		{
			if (count < 2)
			{
				kf.m_OutSpatial[d] = 0;
				kf.m_InSpatial[d] = 0;
			}
			else
			{
				/** A missing component of a neighbour reads as undefined, NaN, as in TypeScript. */
				const f64 h = d < high.m_uCount ? high.m_V[d] : std::numeric_limits<f64>::quiet_NaN();
				const f64 l = d < low.m_uCount ? low.m_V[d] : std::numeric_limits<f64>::quiet_NaN();
				kf.m_OutSpatial[d] = (h - l) / 6;
				kf.m_InSpatial[d] = -kf.m_OutSpatial[d];
			}
		}
	}
}

/** A separated Position's static value: its followers' values, when all are numbers. */
void ComposeSeparatedPosition(CPropertyNode& group)
{
	CPropertyNode* position = group.FindMutable("ADBE Position");
	if (!position || position->m_bGroup || !position->m_bDimensionsSeparated)
	{
		return;
	}
	const char* names[3] = { "ADBE Position_0", "ADBE Position_1", "ADBE Position_2" };
	f64 parts[3];
	for (s32 i = 0; i < 3; i++)
	{
		const CPropertyNode* f = group.FindProperty(names[i]);
		if (!f)
		{
			return;
		}
		const CValue& v = f->m_Keyframes.empty() ? f->m_Value : f->m_Keyframes[0].m_Value;
		if (!v.IsNumber())
		{
			return;
		}
		parts[i] = v.m_V[0];
	}
	position->m_Value = CValue::Vector(parts, 3);
}

/** Reads AE's gradient `prop.map` XML: an alpha-stop list and a color-stop list, each sized by "Stops Size". */
std::shared_ptr<sGradient> ParseGradientXml(const std::string& xml)
{
	const auto section = [&xml](const std::string& key) -> std::string {
		const size_t start = xml.find("<key>" + key + "</key>");
		if (start == std::string::npos)
		{
			return std::string();
		}
		const std::string nextKey = key == "Alpha Stops" ? "<key>Color Stops</key>" : "<key>Alpha Stops</key>";
		const size_t end = xml.find(nextKey, start);
		return end != std::string::npos && end > start ? xml.substr(start, end - start) : xml.substr(start);
	};
	const auto stops = [](const std::string& text, const std::string& kind) {
		static const std::regex s_Size(R"(<key>Stops Size</key>\s*<int[^>]*>(\d+)</int>)");
		static const std::regex s_Float(R"(<float>([^<]*)</float>)");
		size_t size = std::numeric_limits<size_t>::max();
		std::smatch m;
		if (std::regex_search(text, m, s_Size))
		{
			size = size_t(std::stoull(m[1].str()));
		}
		const std::regex stop("<key>Stop-(\\d+)</key>\\s*<prop\\.list>\\s*<prop\\.pair>\\s*<key>Stops " + kind +
			"</key>\\s*<array>([\\s\\S]*?)</array>");
		std::vector<std::pair<f64, std::vector<f64>>> found;
		for (auto it = std::sregex_iterator(text.begin(), text.end(), stop); it != std::sregex_iterator(); ++it)
		{
			std::vector<f64> values;
			const std::string body = (*it)[2].str();
			for (auto f = std::sregex_iterator(body.begin(), body.end(), s_Float); f != std::sregex_iterator(); ++f)
			{
				const std::string number = (*f)[1].str();
				char* end = nullptr;
				const f64 v = std::strtod(number.c_str(), &end);
				values.push_back(end && *end == 0 && !number.empty() ? v : std::numeric_limits<f64>::quiet_NaN());
			}
			found.emplace_back(std::stod((*it)[1].str()), std::move(values));
		}
		std::stable_sort(found.begin(), found.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
		if (found.size() > size)
		{
			found.resize(size);
		}
		return found;
	};
	auto gradient = std::make_shared<sGradient>();
	for (const auto& f : stops(section("Color Stops"), "Color"))
	{
		if (f.second.size() >= 5)
		{
			sGradientColorStop s;
			s.m_fOffset = f.second[0];
			s.m_fMidpoint = f.second[1];
			s.m_Color[0] = f.second[2];
			s.m_Color[1] = f.second[3];
			s.m_Color[2] = f.second[4];
			gradient->m_ColorStops.push_back(s);
		}
	}
	for (const auto& f : stops(section("Alpha Stops"), "Alpha"))
	{
		if (f.second.size() >= 3)
		{
			sGradientAlphaStop s;
			s.m_fOffset = f.second[0];
			s.m_fMidpoint = f.second[1];
			s.m_fAlpha = f.second[2];
			gradient->m_AlphaStops.push_back(s);
		}
	}
	if (gradient->m_ColorStops.empty())
	{
		return nullptr;
	}
	return gradient;
}

/** One `shap`: the path stored as points in a box (`shph`), each vertex with its two handles. */
std::shared_ptr<sShape> DecodeShape(const CChunk& shap, bool maskScaled, f64 sx, f64 sy)
{
	bool open = false;
	f32 tlx = 0, tly = 0, brx = 0, bry = 0;
	if (const CChunk* shph = shap.Child(FCC("shph")))
	{
		const CBytes b(*shph);
		open = b.Bit(3, 3);
		tlx = b.F32(4);
		tly = b.F32(8);
		brx = b.F32(12);
		bry = b.F32(16);
	}
	std::vector<sVec2> points;
	const CChunk* list = shap.List(FCC("list"));
	const CChunk* lhd3 = FindChild(list, FCC("lhd3"));
	const CChunk* ldat = FindChild(list, FCC("ldat"));
	if (lhd3 && ldat)
	{
		for (const CBytes& item : LdatItems(*ldat, DecodeLhd3(*lhd3)))
		{
			points.push_back({ f64(item.F32(0)), f64(item.F32(4)) });
		}
	}
	if (!maskScaled)
	{
		sx = 1;
		sy = 1;
	}
	auto shape = std::make_shared<sShape>();
	shape->m_bClosed = !open;
	const s64 n = s64(points.size());
	const auto at = [&](s64 i) -> sVec2 {
		const sVec2& p = points[size_t(((i % n) + n) % n)];
		return { (tlx * (1 - p.x) + brx * p.x) * sx, (tly * (1 - p.y) + bry * p.y) * sy };
	};
	for (s64 i = 0; i < n; i += 3)
	{
		const sVec2 v = at(i);
		const sVec2 out = at(i + 1);
		const sVec2 in = at(i - 1);
		shape->m_Vertices.push_back(v);
		shape->m_OutTangents.push_back({ out.x - v.x, out.y - v.y });
		shape->m_InTangents.push_back({ in.x - v.x, in.y - v.y });
	}
	return shape;
}

/** A run of chunks under one match name (matchNameRuns). */
struct sRun
{
	std::string m_MatchName;
	std::vector<const CChunk*> m_Chunks;
};

std::vector<sRun> MatchNameRuns(const CChunk* group)
{
	std::vector<sRun> runs;
	if (!group)
	{
		return runs;
	}
	bool skipping = true;
	for (const CChunk& chunk : group->m_Children)
	{
		if (chunk.m_uType == FCC("tdmn"))
		{
			const std::string matchName = MatchNameOf(chunk);
			if (matchName == "ADBE Group End")
			{
				skipping = true;
				continue;
			}
			skipping = false;
			if (runs.empty() || runs.back().m_MatchName != matchName)
			{
				runs.push_back({ matchName, {} });
			}
			runs.back().m_Chunks.push_back(&chunk);
		}
		else if (!skipping && chunk.m_uType != FCC("engv") && chunk.m_uType != FCC("aRbs"))
		{
			runs.back().m_Chunks.push_back(&chunk);
		}
	}
	return runs;
}

class CParser
{
public:
	explicit CParser(CProject& project) : m_Project(project) {}

	/** Parameter declarations by effect match name: the project's (EfdG), then those met on layers. */
	std::map<std::string, std::vector<sParamDef>> m_EffectDefs;

	void ParseEffectNames(const CChunk& root)
	{
		const CChunk* efdg = root.List(FCC("EfdG"));
		if (!efdg)
		{
			return;
		}
		for (const CChunk* efdf : efdg->Lists(FCC("EfDf")))
		{
			const CChunk* tdmn = efdf->Child(FCC("tdmn"));
			const CChunk* sspc = efdf->List(FCC("sspc"));
			if (!tdmn || !sspc)
			{
				continue;
			}
			const std::string matchName = MatchNameOf(*tdmn);
			std::vector<sParamDef> defs = ParamDefs(*sspc);
			if (!defs.empty())
			{
				m_EffectDefs[matchName] = std::move(defs);
			}
			std::string display;
			if (ContainerText(sspc->Child(FCC("fnam")), display) && !display.empty())
			{
				m_Project.m_EffectTypes[matchName] = display;
			}
		}
	}

	/** An effect's parameter declarations (`parT`), in order, without the first entry (the effect itself). */
	static std::vector<sParamDef> ParamDefs(const CChunk& sspc)
	{
		std::vector<sParamDef> defs;
		const CChunk* part = sspc.List(FCC("parT"));
		if (!part)
		{
			return defs;
		}
		/** Runs of one match name are merged, in the order each name first appears. */
		std::vector<std::pair<std::string, std::vector<const CChunk*>>> merged;
		for (const sRun& run : MatchNameRuns(part))
		{
			auto existing = std::find_if(merged.begin(), merged.end(), [&run](const auto& m) { return m.first == run.m_MatchName; });
			if (existing != merged.end())
			{
				existing->second.insert(existing->second.end(), run.m_Chunks.begin(), run.m_Chunks.end());
			}
			else
			{
				merged.push_back({ run.m_MatchName, run.m_Chunks });
			}
		}
		for (size_t i = 1; i < merged.size(); i++)
		{
			const CChunk* pardChunk = nullptr;
			const CChunk* pdnm = nullptr;
			for (const CChunk* c : merged[i].second)
			{
				if (!pardChunk && c->m_uType == FCC("pard"))
				{
					pardChunk = c;
				}
				if (!pdnm && c->m_uType == FCC("pdnm"))
				{
					pdnm = c;
				}
			}
			if (!pardChunk)
			{
				continue;
			}
			sParamDef def;
			def.m_MatchName = merged[i].first;
			def.m_Pard = DecodePard(*pardChunk);
			def.m_Name = def.m_Pard.m_Name;
			std::string text;
			if (ContainerText(pdnm, text))
			{
				if (def.m_Pard.m_uControlType == CONTROL_POPUP)
				{
					def.m_bHasOptions = true;
					size_t start = 0;
					for (;;)
					{
						const size_t bar = text.find('|', start);
						def.m_Options.push_back(text.substr(start, bar == std::string::npos ? std::string::npos : bar - start));
						if (bar == std::string::npos)
						{
							break;
						}
						start = bar + 1;
					}
				}
				else if (!text.empty() && def.m_Pard.m_uControlType != CONTROL_BUTTON)
				{
					/** A button's pdnm is the label drawn on the button, not the parameter name. */
					def.m_Name = text;
				}
			}
			defs.push_back(std::move(def));
		}
		return defs;
	}

	const CItem* ParseItemList(const CChunk& list, u32 parentFolderId)
	{
		const CChunk* idta = list.Child(FCC("idta"));
		if (!idta)
		{
			Warn("item list at " + std::to_string(list.m_uOffset) + " has no idta chunk");
			return nullptr;
		}
		const CBytes b(*idta);
		auto item = std::make_unique<CItem>();
		item->m_uId = b.U32(16);
		item->m_Name = TextOf(list.Child(FCC("Utf8")));
		item->m_uParentFolderId = parentFolderId;
		const u32 type = b.U16(0);
		if (type == 1)
		{
			item->m_eKind = ITEM_FOLDER;
			if (const CChunk* sfdr = list.List(FCC("Sfdr")))
			{
				for (const CChunk* child : sfdr->Lists(FCC("Item")))
				{
					if (const CItem* parsed = ParseItemList(*child, item->m_uId))
					{
						item->m_ChildIds.push_back(parsed->m_uId);
					}
				}
			}
		}
		else if (type == 4)
		{
			const CChunk* cdta = list.Child(FCC("cdta"));
			if (!cdta)
			{
				Warn("composition \"" + item->m_Name + "\" has no cdta chunk");
				return nullptr;
			}
			const sCdta c = DecodeCdta(*cdta);
			item->m_eKind = ITEM_COMP;
			item->m_fWidth = c.m_fWidth;
			item->m_fHeight = c.m_fHeight;
			item->m_fDuration = c.m_fDuration;
			item->m_fFrameRate = c.m_fFrameRate;
			item->m_fPixelAspect = c.m_fPixelAspect;
			std::copy(c.m_BgColor, c.m_BgColor + 3, item->m_BgColor);
			m_CompChunks.emplace_back(item.get(), &list);
		}
		else if (type == 7)
		{
			ParseFootage(list, *item);
		}
		else
		{
			Warn("unknown item type " + std::to_string(type) + " for \"" + item->m_Name + "\"");
			return nullptr;
		}
		const CItem* result = item.get();
		m_Project.m_Items[item->m_uId] = std::move(item);
		return result;
	}

	void ParseLayers()
	{
		for (auto& entry : m_CompChunks)
		{
			CItem& comp = *entry.first;
			const CChunk& list = *entry.second;
			const std::vector<const CChunk*> layerLists = list.Lists(FCC("Layr"));
			std::vector<sLdta> ldtas;
			std::map<u32, s32> layerIndexById;
			for (const CChunk* layerList : layerLists)
			{
				const CChunk* ldta = layerList->Child(FCC("ldta"));
				ldtas.push_back(ldta ? DecodeLdta(*ldta) : sLdta());
				if (!ldta)
				{
					Warn("a layer in \"" + comp.m_Name + "\" has no ldta chunk");
				}
				layerIndexById[ldtas.back().m_uId] = s32(ldtas.size());
			}
			const u32 internalTimebase = DecodeCdta(*list.Child(FCC("cdta"))).m_uInternalTimebase;
			comp.m_Layers.clear();
			for (size_t i = 0; i < layerLists.size(); i++)
			{
				comp.m_Layers.push_back(ParseLayer(*layerLists[i], ldtas[i], s32(i + 1), comp, internalTimebase, layerIndexById));
			}
			/**
			 * Files before AE 23 store no matte layer: it is always the layer above. Later files name it, and a matte
			 * naming no layer (0 included) leaves the layer unmatted.
			 */
			for (size_t i = 0; i < comp.m_Layers.size(); i++)
			{
				CLayer& layer = *comp.m_Layers[i];
				if (!ldtas[i].m_bHasMatteLayerId && layer.m_uTrackMatteType != TRACK_MATTE_NONE)
				{
					layer.m_uTrackMatteLayerId = i > 0 ? comp.m_Layers[i - 1]->m_uId : 0;
				}
			}
		}
	}

private:
	CProject& m_Project;
	std::vector<std::pair<CItem*, const CChunk*>> m_CompChunks;

	void Warn(const std::string& message) { m_Project.m_Warnings.push_back(message); }

	void ParseFootage(const CChunk& list, CItem& item)
	{
		item.m_eKind = ITEM_FOOTAGE;
		const CChunk* pin = list.List(FCC("Pin "));
		const CChunk* sspc = FindChild(pin, FCC("sspc"));
		const CChunk* opti = FindChild(pin, FCC("opti"));
		f64 displayFrameRate = 0;
		if (sspc)
		{
			const CBytes b(*sspc);
			item.m_fWidth = b.U16(32);
			item.m_fHeight = b.U16(36);
			const f64 duration = Ratio(b.U32(38), b.U32(42));
			const f64 nativeFrameRate = b.U32(56) + b.U16(60) / 65536.0;
			const u32 loop = b.U32(126);
			item.m_fPixelAspect = Ratio(b.U32(136), b.U32(140));
			if (item.m_fPixelAspect == 0)
			{
				item.m_fPixelAspect = 1;
			}
			const f64 conformFrameRate = b.U16(148) + b.U16(150) / 65536.0;
			displayFrameRate = b.U16(152) + b.U16(154) / 65536.0;
			const f64 conformFactor = conformFrameRate != 0 ? nativeFrameRate / conformFrameRate : 1;
			item.m_fDuration = duration * conformFactor * (loop ? loop : 1);
			/** Interpret Footage (footage.ts interpretation): alpha mode byte 3 marks footage without alpha. */
			sFootageSource& footage = item.m_Footage;
			const u8 alphaMode = b.U8(73);
			footage.m_bHasAlpha = alphaMode != 3;
			footage.m_uAlphaMode = !footage.m_bHasAlpha ? ALPHA_STRAIGHT
				: alphaMode == 0 ? ALPHA_STRAIGHT
				: alphaMode == 1 ? ALPHA_PREMULTIPLIED
				: ALPHA_IGNORE;
			footage.m_bInvertAlpha = b.Bit(69, 1);
			for (s32 i = 0; i < 3; i++)
			{
				footage.m_PremulColor[i] = b.U8(70 + i) / 255.0;
			}
			footage.m_bIsStill = duration == 0;
			footage.m_uLoop = loop ? loop : 1;
		}
		item.m_fFrameRate = displayFrameRate;
		/** With "use proxy" on (idta byte 22, bit 0), AE reports the proxy's audio (footage.ts). */
		const CChunk* idta = list.Child(FCC("idta"));
		const std::vector<const CChunk*> pins = list.Lists(FCC("Pin "));
		const bool useProxy = idta && (CBytes(*idta).U8(22) & 1) != 0;
		const CChunk* proxy = useProxy && pins.size() > 1 ? FindChild(pins[1], FCC("sspc")) : nullptr;
		const CChunk* audio = proxy ? proxy : sspc;
		item.m_bHasAudio = audio && audio->m_uSize >= 168 && CBytes(*audio).F64(160) > 0;
		item.m_eSource = SOURCE_FILE;
		if (opti)
		{
			const CBytes b(*opti);
			const std::string assetType = b.CStr(0, 4);
			if (assetType.empty() && b.U16(4) == 2)
			{
				item.m_eSource = SOURCE_PLACEHOLDER;
				if (item.m_Name.empty())
				{
					item.m_Name = b.CStr(10, 256);
				}
			}
			else if (assetType.compare(0, 4, "Soli") == 0)
			{
				item.m_eSource = SOURCE_SOLID;
				item.m_SolidColor[0] = b.F32(14);
				item.m_SolidColor[1] = b.F32(18);
				item.m_SolidColor[2] = b.F32(22);
				if (item.m_Name.empty())
				{
					item.m_Name = b.CStr(26, 256);
				}
			}
		}
		if (item.m_eSource == SOURCE_FILE)
		{
			ParseFileSource(*pin, sspc, opti, item);
		}
	}

	/**
	 * The file a footage item reads and, when the item has no name of its own, the name AE shows for it (footage.ts
	 * fileSource): the file's name, a sequence's range, or a text asset's layer and file. Decoding the footage is M4.
	 */
	void ParseFileSource(const CChunk& pin, const CChunk* sspc, const CChunk* opti, CItem& item)
	{
		static const u32 s_UndefinedFrame = 0xffffffffu;
		const std::string alas = TextOf(FindChild(FindList(&pin, FCC("Als2")), FCC("alas")));
		static const std::regex s_Path(R"re("fullpath"\s*:\s*"((?:[^"\\]|\\.)*)")re");
		static const std::regex s_Folder(R"re("target_is_folder"\s*:\s*true)re");
		std::smatch m;
		const std::string folder = std::regex_search(alas, m, s_Path) ? JsonUnescape(m[1].str()) : std::string();
		const bool targetIsFolder = std::regex_search(alas, s_Folder);

		std::vector<std::string> fileNames;
		if (const CChunk* names = FindList(&pin, FCC("StVc")))
		{
			for (const CChunk& child : names->m_Children)
			{
				if (child.m_uType == FCC("Utf8"))
				{
					fileNames.push_back(TextOf(&child));
				}
			}
		}
		/** A sequence's file-name prefix and extension are the last two Utf8 chunks before `opti`. */
		std::vector<std::string> before;
		for (const CChunk& child : pin.m_Children)
		{
			if (child.m_uType == FCC("opti"))
			{
				break;
			}
			if (child.m_uType == FCC("Utf8"))
			{
				before.push_back(TextOf(&child));
			}
		}
		const bool hasAffixes = before.size() >= 2;
		const std::string prefix = hasAffixes ? before[before.size() - 2] : std::string();
		const std::string extension = hasAffixes ? before.back() : std::string();

		bool sequence = false;
		u32 startFrame = s_UndefinedFrame, endFrame = s_UndefinedFrame, padding = 0;
		if (targetIsFolder && sspc && (hasAffixes || !fileNames.empty()))
		{
			const CBytes b(*sspc);
			sequence = true;
			padding = b.U32(180);
			startFrame = b.U32(172);
			endFrame = b.U32(176);
			if (startFrame == s_UndefinedFrame && !fileNames.empty())
			{
				FrameNumberOf(fileNames.front(), startFrame);
			}
			if (endFrame == s_UndefinedFrame && !fileNames.empty())
			{
				FrameNumberOf(fileNames.back(), endFrame);
			}
	sFootageSource& footage = item.m_Footage;
			footage.m_bSequence = true;
			footage.m_SequencePrefix = prefix;
			footage.m_SequenceExtension = extension;
			footage.m_uStartFrame = startFrame;
			footage.m_uEndFrame = endFrame;
			footage.m_uFramePadding = padding;
			footage.m_FileNames = fileNames;
		}
		const auto pad = [padding](u32 frame)
		{
			std::string digits = std::to_string(frame);
			return digits.size() < padding ? std::string(padding - digits.size(), '0') + digits : digits;
		};

		std::string file = folder;
		if (!fileNames.empty())
		{
			file = JoinPath(folder, fileNames.front());
		}
		else if (sequence && padding > 0 && startFrame != s_UndefinedFrame && (!prefix.empty() || !extension.empty()))
		{
			file = JoinPath(folder, prefix + pad(startFrame) + extension);
		}
		item.m_File = file;
		if (!item.m_Name.empty())
		{
			return;
		}
		const size_t slash = file.find_last_of("/\\");
		const std::string fileName = slash == std::string::npos ? file : file.substr(slash + 1);
		if (sequence && item.m_fDuration != 0 && startFrame != s_UndefinedFrame && endFrame != s_UndefinedFrame &&
			(!prefix.empty() || !extension.empty()))
		{
			item.m_Name = prefix + "[" + pad(startFrame) + "-" + pad(endFrame) + "]" + extension;
			return;
		}
		const CBytes o = opti ? CBytes(*opti) : CBytes(nullptr, 0);
		const std::string layerName = opti && o.CStr(0, 4) == "TEXT" ? o.CStr(68, 256) : std::string();
		item.m_Name = layerName.empty() ? fileName : layerName + "/" + fileName;
	}

	/** The last run of digits in `name` (footage.ts frameNumberOf); `frame` is left alone when there is none. */
	static void FrameNumberOf(const std::string& name, u32& frame)
	{
		static const std::regex s_Number(R"re((\d+)\D*$)re");
		std::smatch m;
		if (std::regex_search(name, m, s_Number))
		{
			frame = u32(std::strtod(m[1].str().c_str(), nullptr));
		}
	}

	static std::string JoinPath(const std::string& folder, const std::string& name)
	{
		const char separator = folder.find('\\') != std::string::npos ? '\\' : '/';
		std::string base = folder;
		if (!base.empty() && (base.back() == '/' || base.back() == '\\'))
		{
			base.pop_back();
		}
		return base + separator + name;
	}

	/** A JSON string's contents with its escapes decoded, \uXXXX as UTF-8. */
	static std::string JsonUnescape(const std::string& text)
	{
		std::string out;
		for (size_t i = 0; i < text.size(); i++)
		{
			if (text[i] != '\\' || i + 1 >= text.size())
			{
				out += text[i];
				continue;
			}
			const char c = text[++i];
			switch (c)
			{
			case 'n': out += '\n'; break;
			case 't': out += '\t'; break;
			case 'r': out += '\r'; break;
			case 'b': out += '\b'; break;
			case 'f': out += '\f'; break;
			case 'u':
				if (i + 4 < text.size())
				{
					const u32 code = u32(std::strtoul(text.substr(i + 1, 4).c_str(), nullptr, 16));
					i += 4;
					if (code < 0x80)
					{
						out += char(code);
					}
					else if (code < 0x800)
					{
						out += char(0xc0 | (code >> 6));
						out += char(0x80 | (code & 0x3f));
					}
					else
					{
						out += char(0xe0 | (code >> 12));
						out += char(0x80 | ((code >> 6) & 0x3f));
						out += char(0x80 | (code & 0x3f));
					}
				}
				break;
			default: out += c; break;
			}
		}
		return out;
	}

	std::unique_ptr<CLayer> ParseLayer(const CChunk& list, const sLdta& ldta, s32 index, const CItem& comp,
		u32 internalTimebase, const std::map<u32, s32>& layerIndexById)
	{
		auto layer = std::make_unique<CLayer>();
		static const eLayerType s_Types[8] = { LAYER_AV, LAYER_LIGHT, LAYER_CAMERA, LAYER_TEXT, LAYER_SHAPE,
			LAYER_THREE_D_MODEL, LAYER_AV, LAYER_PARAMETRIC_MESH };
		const bool knownType = ldta.m_uLayerType <= 7 && ldta.m_uLayerType != 6;
		layer->m_eType = knownType ? s_Types[ldta.m_uLayerType] : LAYER_AV;
		if (!knownType)
		{
			Warn("layer \"" + ldta.m_Name + "\" has unknown type " + std::to_string(ldta.m_uLayerType));
		}
		const CItem* source = ldta.m_uSourceId ? m_Project.Item(ldta.m_uSourceId) : nullptr;
		const CItem* sized = source && source->m_eKind != ITEM_FOLDER ? source : nullptr;
		const f64 width = sized ? sized->m_fWidth : comp.m_fWidth;
		const f64 height = sized ? sized->m_fHeight : comp.m_fHeight;
		const f64 stretchFactor = ldta.m_fStretch != 0 ? ldta.m_fStretch / 100 : 1;
		const bool threeD = ldta.m_bThreeD || layer->m_eType == LAYER_CAMERA || layer->m_eType == LAYER_LIGHT;

		sLayerContext ctx;
		ctx.m_pLdta = &ldta;
		ctx.m_uInternalTimebase = internalTimebase;
		ctx.m_fStretchFactor = stretchFactor;
		ctx.m_bHasSource = sized != nullptr;
		ctx.m_fWidth = width;
		ctx.m_fHeight = height;
		ctx.m_bThreeD = threeD;
		ctx.m_pLayerIndexById = &layerIndexById;
		ctx.m_pWarnings = &m_Project.m_Warnings;

		layer->m_Properties.m_bGroup = true;
		ParseRuns(MatchNameRuns(list.List(FCC("tdgp"))), ctx, layer->m_Properties.m_Children, ldta.m_Name);

		const CPropertyNode* remap = layer->m_Properties.FindProperty("ADBE Time Remapping");
		layer->m_bTimeRemapEnabled = remap && !remap->m_Keyframes.empty();

		f64 inPoint = ldta.m_fStartTime + ldta.m_fRawInPoint * stretchFactor;
		f64 outPoint = ldta.m_fStartTime + ldta.m_fRawOutPoint * stretchFactor;
		const f64 sourceDuration = sized ? sized->m_fDuration : 0;
		if (layer->m_eType == LAYER_AV && !layer->m_bTimeRemapEnabled && sourceDuration > 0 && ldta.m_fStretch >= 0)
		{
			inPoint = std::max(inPoint, ldta.m_fStartTime);
			outPoint = std::min(outPoint, ldta.m_fStartTime + sourceDuration * stretchFactor);
		}

		u32 autoOrient = 0;
		if (ldta.m_bAutoOrientAlongPath)
		{
			autoOrient = 1;
		}
		else if ((ldta.m_bCameraOrPoiAutoOrient || ldta.m_bPoiAutoOrient) && ldta.m_bThreeD)
		{
			autoOrient = 2;
		}
		else if (ldta.m_bCharactersTowardCamera && ldta.m_bThreeDPerChar)
		{
			autoOrient = 3;
		}

		u32 blendMode = BlendingMode(ldta.m_uBlendingModeRaw);
		if (blendMode == 5213 && ldta.m_bDancingDissolve)
		{
			blendMode = DANCING_DISSOLVE;
		}

		layer->m_uId = ldta.m_uId;
		layer->m_iIndex = index;
		layer->m_Name = TextOf(list.Child(FCC("Utf8")));
		if (layer->m_Name.empty())
		{
			layer->m_Name = source && !source->m_Name.empty() ? source->m_Name : ldta.m_Name;
		}
		layer->m_uSourceId = ldta.m_uSourceId;
		layer->m_fStartTime = ldta.m_fStartTime;
		layer->m_fInPoint = inPoint;
		layer->m_fOutPoint = outPoint;
		layer->m_fStretch = ldta.m_fStretch;
		layer->m_bEnabled = ldta.m_bEnabled;
		layer->m_bSolo = ldta.m_bSolo;
		layer->m_bThreeD = ldta.m_bThreeD;
		layer->m_bAdjustment = ldta.m_bAdjustment;
		layer->m_bNull = ldta.m_bNull;
		layer->m_bGuide = ldta.m_bGuide;
		layer->m_bEffectsActive = ldta.m_bEffectsActive;
		layer->m_bAudioEnabled = ldta.m_bAudioEnabled;
		layer->m_uBlendMode = blendMode;
		layer->m_uTrackMatteType = ldta.m_uTrackMatteTypeRaw <= 4 ? ldta.m_uTrackMatteTypeRaw + 5012 : TRACK_MATTE_NONE;
		layer->m_uTrackMatteLayerId = ldta.m_bHasMatteLayerId ? ldta.m_uMatteLayerId : 0;
		layer->m_uParentId = ldta.m_uParentId;
		layer->m_uAutoOrient = AUTO_ORIENT_NONE + autoOrient;
		layer->m_fWidth = width;
		layer->m_fHeight = height;
		FillTransform(*layer, comp);
		return layer;
	}

	/** The Transform defaults AE leaves out of the file (synthesize.ts fillTransform). */
	void FillTransform(CLayer& layer, const CItem& comp)
	{
		CPropertyNode* transform = layer.m_Properties.FindMutable("ADBE Transform Group");
		if (!transform)
		{
			auto group = std::make_unique<CPropertyNode>();
			group->m_bGroup = true;
			group->m_MatchName = "ADBE Transform Group";
			group->m_bSynthesized = true;
			transform = group.get();
			layer.m_Properties.m_Children.push_back(std::move(group));
		}
		if (!transform->m_bGroup)
		{
			return;
		}
		const bool camOrLight = layer.m_eType == LAYER_CAMERA || layer.m_eType == LAYER_LIGHT;
		const bool sourceless = layer.m_eType == LAYER_TEXT || layer.m_eType == LAYER_SHAPE ||
			layer.m_eType == LAYER_PARAMETRIC_MESH || layer.m_eType == LAYER_THREE_D_MODEL || layer.m_bNull;
		f64 anchor[3] = { 0, 0, 0 };
		if (camOrLight)
		{
			anchor[0] = comp.m_fWidth / 2;
			anchor[1] = comp.m_fHeight / 2;
		}
		else if (sourceless)
		{
		}
		else if (layer.m_fWidth == 0 || layer.m_fHeight == 0)
		{
			anchor[0] = 0.5;
			anchor[1] = 0.5;
		}
		else
		{
			anchor[0] = layer.m_fWidth / 2;
			anchor[1] = layer.m_fHeight / 2;
		}
		const f64 cameraZ = layer.m_eType == LAYER_CAMERA ? -DefaultCameraZoomRounded(comp) : 0;
		const f64 position[3] = { comp.m_fWidth / 2, comp.m_fHeight / 2, cameraZ };
		const f64 scale[3] = { 100, 100, 100 };
		const f64 zero3[3] = { 0, 0, 0 };
		const auto add = [transform](const char* matchName, CValue value, u32 valueType, bool spatial) {
			if (transform->Find(matchName))
			{
				return;
			}
			auto node = std::make_unique<CPropertyNode>();
			node->m_MatchName = matchName;
			node->m_Value = value;
			node->m_uValueType = valueType;
			node->m_bSpatial = spatial;
			node->m_bSynthesized = true;
			transform->m_Children.push_back(std::move(node));
		};
		add("ADBE Anchor Point", CValue::Vector(anchor, 3), PVT_THREE_D_SPATIAL, true);
		add("ADBE Position", CValue::Vector(position, 3), PVT_THREE_D_SPATIAL, true);
		add("ADBE Position_0", CValue::Number(0), PVT_ONE_D, false);
		add("ADBE Position_1", CValue::Number(0), PVT_ONE_D, false);
		add("ADBE Position_2", CValue::Number(0), PVT_ONE_D, false);
		add("ADBE Scale", CValue::Vector(scale, 3), PVT_THREE_D, false);
		add("ADBE Orientation", CValue::Vector(zero3, 3), PVT_THREE_D_SPATIAL, false);
		add("ADBE Rotate X", CValue::Number(0), PVT_ONE_D, false);
		add("ADBE Rotate Y", CValue::Number(0), PVT_ONE_D, false);
		add("ADBE Rotate Z", CValue::Number(0), PVT_ONE_D, false);
		add("ADBE Opacity", CValue::Number(100), PVT_ONE_D, false);
		if (layer.m_bNull)
		{
			CPropertyNode* opacity = transform->FindMutable("ADBE Opacity");
			if (opacity && opacity->m_Value.IsNumber() && opacity->m_Value.m_V[0] == 100)
			{
				opacity->m_Value = CValue::Number(0);
			}
		}
		ComposeSeparatedPosition(*transform);
	}

	static f64 DefaultCameraZoomRounded(const CItem& comp)
	{
		return std::round(((comp.m_fWidth * comp.m_fPixelAspect) / 0.72) * 1e8) / 1e8;
	}

	void ParseRuns(const std::vector<sRun>& runs, const sLayerContext& ctx, std::vector<std::unique_ptr<CPropertyNode>>& nodes,
		const std::string& layerName, const sLeafOptions& options = sLeafOptions())
	{
		for (const sRun& run : runs)
		{
			ParseRun(run, ctx, nodes, layerName, options);
		}
	}

	void ParseRun(const sRun& run, const sLayerContext& ctx, std::vector<std::unique_ptr<CPropertyNode>>& nodes,
		const std::string& layerName, const sLeafOptions& options)
	{
		const CChunk* first = nullptr;
		for (const CChunk* c : run.m_Chunks)
		{
			if (c->m_uType == FCC("LIST"))
			{
				first = c;
				break;
			}
		}
		if (!first)
		{
			return;
		}
		const auto lists = [&run](FourCC type) {
			std::vector<const CChunk*> out;
			for (const CChunk* c : run.m_Chunks)
			{
				if (c->IsList(type))
				{
					out.push_back(c);
				}
			}
			return out;
		};
		const FourCC listType = first->m_uListType;
		if (listType == FCC("sspc"))
		{
			for (const CChunk* sspc : lists(FCC("sspc")))
			{
				nodes.push_back(ParseEffect(*sspc, run.m_MatchName, ctx, layerName));
			}
		}
		else if (listType == FCC("tdgp"))
		{
			if (run.m_MatchName == "ADBE Mask Atom")
			{
				std::vector<const CChunk*> mkifs;
				for (const CChunk* c : run.m_Chunks)
				{
					if (c->m_uType == FCC("mkif"))
					{
						mkifs.push_back(c);
					}
				}
				const std::vector<const CChunk*> tdgps = lists(FCC("tdgp"));
				for (size_t i = 0; i < tdgps.size(); i++)
				{
					nodes.push_back(ParseMask(*tdgps[i], i < mkifs.size() ? mkifs[i] : nullptr, ctx, layerName));
				}
			}
			else
			{
				for (const CChunk* tdgp : lists(FCC("tdgp")))
				{
					nodes.push_back(ParseGroup(*tdgp, run.m_MatchName, ctx, layerName, options));
				}
			}
		}
		else if (listType == FCC("tdbs"))
		{
			nodes.push_back(ParseLeaf(*first, run.m_MatchName, ctx, false, options));
		}
		else if (listType == FCC("otst"))
		{
			if (auto node = ParseOrientation(*first, run.m_MatchName, ctx, layerName))
			{
				nodes.push_back(std::move(node));
			}
		}
		else if (listType == FCC("om-s"))
		{
			if (auto node = ParseShape(*first, run.m_MatchName, ctx, run.m_MatchName == "ADBE Mask Shape", layerName))
			{
				nodes.push_back(std::move(node));
			}
		}
		else if (listType == FCC("btds"))
		{
			if (auto node = ParseWrapped(*first, run.m_MatchName, ctx, PVT_TEXT_DOCUMENT, true, layerName))
			{
				nodes.push_back(std::move(node));
			}
		}
		else if (listType == FCC("GCst"))
		{
			if (auto node = ParseGradient(*first, run.m_MatchName, ctx, layerName))
			{
				nodes.push_back(std::move(node));
			}
		}
		else if (listType == FCC("mrst"))
		{
			if (auto node = ParseWrapped(*first, run.m_MatchName, ctx, PVT_MARKER, false, layerName))
			{
				nodes.push_back(std::move(node));
			}
		}
		else if (listType == FCC("OvG2"))
		{
			const std::vector<const CChunk*> tdgps = lists(FCC("tdgp"));
			if (!tdgps.empty())
			{
				nodes.push_back(ParseGroup(*tdgps[0], run.m_MatchName, ctx, layerName, options));
			}
		}
		else
		{
			char type[5] = { char(listType >> 24), char(listType >> 16), char(listType >> 8), char(listType), 0 };
			Warn(std::string("unsupported property container ") + type + " for " + run.m_MatchName);
		}
	}

	std::unique_ptr<CPropertyNode> ParseGroup(const CChunk& tdgp, const std::string& matchName, const sLayerContext& ctx,
		const std::string& layerName, const sLeafOptions& options = sLeafOptions())
	{
		auto group = std::make_unique<CPropertyNode>();
		group->m_bGroup = true;
		group->m_MatchName = matchName;
		const CChunk* tdsb = tdgp.Child(FCC("tdsb"));
		group->m_bEnabled = tdsb ? CBytes(*tdsb).Bit(3, 0) : true;
		ParseRuns(MatchNameRuns(&tdgp), ctx, group->m_Children, layerName, options);
		ComposeSeparatedPosition(*group);
		return group;
	}

	std::unique_ptr<CPropertyNode> ParseMask(const CChunk& tdgp, const CChunk* mkif, const sLayerContext& ctx,
		const std::string& layerName)
	{
		auto group = ParseGroup(tdgp, "ADBE Mask Atom", ctx, layerName);
		if (mkif)
		{
			const CBytes b(*mkif);
			group->m_bHasMask = true;
			group->m_Mask.m_bInverted = b.U8(0) != 0;
			const u32 mode = b.U16(6);
			group->m_Mask.m_uMode = mode <= 6 ? mode + 6812 : 6812;
		}
		return group;
	}

	/**
	 * An effect (parseEffect): its parameters in the order its effect declares them, with the ones After Effects left
	 * out of the file (at their defaults) made from their declarations, then any it stored without declaring.
	 */
	std::unique_ptr<CPropertyNode> ParseEffect(const CChunk& sspc, const std::string& matchName, const sLayerContext& ctx,
		const std::string& layerName)
	{
		auto group = std::make_unique<CPropertyNode>();
		group->m_bGroup = true;
		group->m_bEffect = true;
		group->m_MatchName = matchName;
		std::string name;
		if (ContainerText(sspc.Child(FCC("fnam")), name))
		{
			group->m_EffectName = name;
		}
		else
		{
			const auto known = m_Project.m_EffectTypes.find(matchName);
			group->m_EffectName = known != m_Project.m_EffectTypes.end() ? known->second : matchName;
		}
		if (m_Project.m_EffectTypes.find(matchName) == m_Project.m_EffectTypes.end())
		{
			m_Project.m_EffectTypes[matchName] = group->m_EffectName;
		}
		std::vector<sParamDef> own = ParamDefs(sspc);
		const std::vector<sParamDef>* defs = &own;
		if (own.empty())
		{
			const auto known = m_EffectDefs.find(matchName);
			static const std::vector<sParamDef> s_None;
			defs = known != m_EffectDefs.end() ? &known->second : &s_None;
		}
		else if (m_EffectDefs.find(matchName) == m_EffectDefs.end())
		{
			defs = &(m_EffectDefs[matchName] = std::move(own));
		}

		const CChunk* tdgp = sspc.List(FCC("tdgp"));
		const CChunk* tdsb = FindChild(tdgp, FCC("tdsb"));
		group->m_bEnabled = tdsb ? CBytes(*tdsb).Bit(3, 0) : true;
		std::map<std::string, const sParamDef*> defsByName;
		for (const sParamDef& def : *defs)
		{
			defsByName[def.m_MatchName] = &def;
		}
		sLeafOptions options;
		options.m_bInEffect = true;
		options.m_pDefs = &defsByName;
		std::vector<std::unique_ptr<CPropertyNode>> parsed;
		for (const sRun& run : MatchNameRuns(tdgp))
		{
			if (run.m_MatchName.size() >= 5 && run.m_MatchName.compare(run.m_MatchName.size() - 5, 5, "-0000") == 0)
			{
				continue;
			}
			const auto def = defsByName.find(run.m_MatchName);
			const size_t before = parsed.size();
			ParseRuns({ run }, ctx, parsed, layerName, options);
			for (size_t i = before; i < parsed.size(); i++)
			{
				if (def != defsByName.end() && !parsed[i]->m_bGroup)
				{
					ApplyParamDef(*parsed[i], *def->second);
				}
			}
		}
		/** The last node parsed under a match name answers for it, as a Map built from them does. */
		std::map<std::string, size_t> parsedByName;
		for (size_t i = 0; i < parsed.size(); i++)
		{
			parsedByName[parsed[i]->m_MatchName] = i;
		}
		std::vector<bool> taken(parsed.size(), false);
		for (const sParamDef& def : *defs)
		{
			if (def.m_MatchName == "ADBE Force CPU GPU")
			{
				continue;
			}
			const auto found = parsedByName.find(def.m_MatchName);
			if (found != parsedByName.end() && !taken[found->second])
			{
				taken[found->second] = true;
				group->m_Children.push_back(std::move(parsed[found->second]));
			}
			else if (found != parsedByName.end())
			{
				/** A declaration listed twice takes the same node twice in TypeScript; the copy is made from it. */
				group->m_Children.push_back(SynthesizeParam(def, ctx));
			}
			else
			{
				group->m_Children.push_back(SynthesizeParam(def, ctx));
			}
		}
		for (size_t i = 0; i < parsed.size(); i++)
		{
			if (parsed[i] && defsByName.find(parsed[i]->m_MatchName) == defsByName.end())
			{
				group->m_Children.push_back(std::move(parsed[i]));
			}
		}
		bool builtIn = false;
		for (const auto& child : group->m_Children)
		{
			builtIn = builtIn || child->m_MatchName == "ADBE Effect Built In Params";
		}
		if (!builtIn)
		{
			auto params = std::make_unique<CPropertyNode>();
			params->m_bGroup = true;
			params->m_MatchName = "ADBE Effect Built In Params";
			params->m_bSynthesized = true;
			group->m_Children.push_back(std::move(params));
		}
		return group;
	}

	static void ApplyParamDef(CPropertyNode& prop, const sParamDef& def)
	{
		prop.m_uControlType = def.m_Pard.m_uControlType;
		if (const u32 type = EffectValueType(def.m_Pard.m_uControlType))
		{
			prop.m_uValueType = type;
		}
		if (def.m_bHasOptions)
		{
			prop.m_Options = def.m_Options;
		}
	}

	/**
	 * A parameter After Effects left out of the file while it sat at its default (synthesizeParam): the declared
	 * default wins over the last value, which some plugins leave stale.
	 */
	static std::unique_ptr<CPropertyNode> SynthesizeParam(const sParamDef& def, const sLayerContext& ctx)
	{
		const sPard& pard = def.m_Pard;
		const u32 type = pard.m_uControlType;
		auto prop = std::make_unique<CPropertyNode>();
		prop->m_MatchName = def.m_MatchName;
		prop->m_bSynthesized = true;
		if (type == CONTROL_POPUP || type == CONTROL_CHECKBOX)
		{
			const f64 d = pard.m_uDefaultCount ? pard.m_Default[0] : 0;
			const f64 l = pard.m_uLastCount ? pard.m_Last[0] : 0;
			prop->m_Value = CValue::Number(d != 0 && !std::isnan(d) ? d : l != 0 && !std::isnan(l) ? l : type == CONTROL_POPUP ? 1 : 0);
		}
		else if (type == CONTROL_POINT || type == CONTROL_POINT_3D)
		{
			if (pard.m_uLastCount)
			{
				const bool sized = ctx.m_fWidth != 0 && ctx.m_fHeight != 0;
				const f64 scale[3] = { sized ? ctx.m_fWidth : 512, sized ? ctx.m_fHeight : 512, sized ? ctx.m_fHeight : 512 };
				f64 v[4];
				for (u32 i = 0; i < pard.m_uLastCount; i++)
				{
					v[i] = pard.m_Last[i] / 512 * scale[i];
				}
				prop->m_Value = CValue::Vector(v, pard.m_uLastCount);
			}
		}
		else if (type == CONTROL_LAYER || type == CONTROL_PATH)
		{
			prop->m_Value = CValue::Number(0);
		}
		else if (EffectValueType(type) == PVT_NO_VALUE || type == CONTROL_ARBITRARY)
		{
			prop->m_Value = CValue();
		}
		else
		{
			const f64* v = pard.m_uDefaultCount ? pard.m_Default : pard.m_uLastCount ? pard.m_Last : nullptr;
			const u32 n = pard.m_uDefaultCount ? pard.m_uDefaultCount : pard.m_uLastCount;
			if (v)
			{
				prop->m_Value = n == 1 ? CValue::Number(v[0]) : CValue::Vector(v, n);
			}
		}
		const u32 valueType = EffectValueType(type);
		prop->m_uValueType = valueType ? valueType : PVT_ONE_D;
		prop->m_bSpatial = type == CONTROL_POINT || type == CONTROL_POINT_3D;
		ApplyParamDef(*prop, def);
		return prop;
	}

	std::unique_ptr<CPropertyNode> ParseLeaf(const CChunk& tdbs, const std::string& matchName, const sLayerContext& ctx,
		bool littleEndianValue, const sLeafOptions& options = sLeafOptions())
	{
		const sParamDef* def = options.Def(matchName);
		const u32 controlType = def ? def->m_Pard.m_uControlType : CONTROL_NONE;
		auto prop = std::make_unique<CPropertyNode>();
		prop->m_MatchName = matchName;
		prop->m_uControlType = controlType;
		const CChunk* tdsbChunk = tdbs.Child(FCC("tdsb"));
		const CChunk* tdb4Chunk = tdbs.Child(FCC("tdb4"));
		sTdb4 tdb4;
		if (tdb4Chunk)
		{
			tdb4 = DecodeTdb4(*tdb4Chunk);
		}
		const CValueResolver resolver(matchName, tdb4Chunk ? &tdb4 : nullptr, ctx, options.m_bInEffect, controlType);
		prop->m_Expression = TextOf(tdbs.Child(FCC("Utf8")));
		prop->m_uValueType = tdb4Chunk ? ValueTypeFromFlags(tdb4) : PVT_NO_VALUE;
		if (controlType != CONTROL_NONE)
		{
			if (const u32 type = EffectValueType(controlType))
			{
				prop->m_uValueType = type;
			}
		}
		else if (options.m_bInEffect && tdb4Chunk && tdb4.m_bNoValue)
		{
			/** An undeclared effect-internal slot flagged value-less holds scratch bytes, not a number. */
			prop->m_uValueType = PVT_NO_VALUE;
		}

		const CChunk* tdpi = tdbs.Child(FCC("tdpi"));
		const CChunk* tdli = tdbs.Child(FCC("tdli"));
		const CChunk* cdat = tdbs.Child(FCC("cdat"));
		if (tdpi)
		{
			const s32 id = CBytes(*tdpi).S32(0);
			s32 index = 0;
			if (id != 0)
			{
				const auto found = ctx.m_pLayerIndexById->find(u32(id));
				index = found != ctx.m_pLayerIndexById->end() ? found->second : 0;
			}
			prop->m_Value = CValue::Number(index);
			prop->m_uValueType = PVT_LAYER_INDEX;
		}
		else if (tdli)
		{
			prop->m_Value = CValue::Number(CBytes(*tdli).S32(0));
			prop->m_uValueType = PVT_MASK_INDEX;
		}
		else if (cdat && prop->m_uValueType != PVT_NO_VALUE)
		{
			std::vector<f64> raw = DecodeDoubles(*cdat, littleEndianValue);
			prop->m_Value = resolver.Value(raw.data(), u32(raw.size()));
		}
		const CBytes sb = tdsbChunk ? CBytes(*tdsbChunk) : CBytes(nullptr, 0);
		prop->m_bEnabled = tdsbChunk ? sb.Bit(3, 0) : true;
		prop->m_bDimensionsSeparated = tdsbChunk ? sb.Bit(2, 3) : false;
		prop->m_bSpatial = tdb4Chunk ? tdb4.m_bSpatial : false;
		prop->m_bExpressionEnabled = !prop->m_Expression.empty() && !(tdb4Chunk && tdb4.m_bExpressionDisabled);
		ParseKeyframes(tdbs, tdb4Chunk ? &tdb4 : nullptr, resolver, ctx, prop->m_Keyframes);
		return prop;
	}

	static std::vector<f64> DecodeDoubles(const CChunk& chunk, bool littleEndian)
	{
		const CBytes b(chunk);
		std::vector<f64> values;
		for (size_t o = 0; o + 8 <= b.Size(); o += 8)
		{
			values.push_back(b.F64(o, littleEndian));
		}
		return values;
	}

	void ParseKeyframes(const CChunk& tdbs, const sTdb4* tdb4, const CValueResolver& resolver, const sLayerContext& ctx,
		std::vector<sKeyframe>& keys)
	{
		const CChunk* list = tdbs.List(FCC("list"));
		const CChunk* lhd3Chunk = FindChild(list, FCC("lhd3"));
		const CChunk* ldat = FindChild(list, FCC("ldat"));
		if (!lhd3Chunk || !ldat)
		{
			return;
		}
		const sLhd3 lhd3 = DecodeLhd3(*lhd3Chunk);
		eLdatKind kind = lhd3.m_eKind;
		if (kind == LDAT_THREE_D && tdb4 && tdb4->m_bSpatial)
		{
			kind = LDAT_THREE_D_SPATIAL;
		}
		const f64 base = ctx.TimeBase();
		const f64 offset = ctx.Offset();
		for (const CBytes& item : LdatItems(*ldat, lhd3))
		{
			const sRawKeyframe raw = DecodeKeyframe(item, kind);
			sKeyframe kf;
			kf.m_fLayerTime = raw.m_iTimeUnits / base;
			kf.m_fTime = (raw.m_iTimeUnits / base) * ctx.m_fStretchFactor + offset;
			kf.m_Value = resolver.Value(raw.m_Value, raw.m_uValueCount);
			kf.m_uInInterpolation = InterpolationType(raw.m_uIn);
			kf.m_uOutInterpolation = InterpolationType(raw.m_uOut);
			kf.m_uInEaseCount = u8(raw.m_uInEaseCount);
			kf.m_uOutEaseCount = u8(raw.m_uOutEaseCount);
			for (u32 i = 0; i < raw.m_uInEaseCount; i++)
			{
				kf.m_InEase[i] = { resolver.Speed(raw.m_InEase[i].m_fSpeed), raw.m_InEase[i].m_fInfluence * 100 };
			}
			for (u32 i = 0; i < raw.m_uOutEaseCount; i++)
			{
				kf.m_OutEase[i] = { resolver.Speed(raw.m_OutEase[i].m_fSpeed), raw.m_OutEase[i].m_fInfluence * 100 };
			}
			kf.m_uSpatialCount = u8(raw.m_uSpatialCount);
			for (u32 i = 0; i < raw.m_uSpatialCount; i++)
			{
				kf.m_InSpatial[i] = raw.m_InSpatial[i];
				kf.m_OutSpatial[i] = raw.m_OutSpatial[i];
			}
			resolver.Scale(kf.m_InSpatial, raw.m_uSpatialCount);
			resolver.Scale(kf.m_OutSpatial, raw.m_uSpatialCount);
			kf.m_bSpatialAutoBezier = raw.m_bSpatialAutoBezier;
			kf.m_bSpatialContinuous = raw.m_bSpatialContinuous;
			kf.m_bTemporalAutoBezier = raw.m_bTemporalAutoBezier;
			kf.m_bTemporalContinuous = raw.m_bTemporalContinuous;
			kf.m_bRoving = raw.m_bRoving;
			keys.push_back(kf);
		}
		ApplyAutoSpatialTangents(keys);
	}

	std::unique_ptr<CPropertyNode> ParseOrientation(const CChunk& otst, const std::string& matchName,
		const sLayerContext& ctx, const std::string& layerName)
	{
		const CChunk* tdbs = otst.List(FCC("tdbs"));
		if (!tdbs)
		{
			Warn("layer \"" + layerName + "\": skipped " + matchName + ": orientation has no tdbs");
			return nullptr;
		}
		auto prop = ParseLeaf(*tdbs, matchName, ctx, true);
		prop->m_uValueType = PVT_THREE_D_SPATIAL;
		if (const CChunk* cdat = tdbs->Child(FCC("cdat")))
		{
			std::vector<f64> v = DecodeDoubles(*cdat, true);
			while (v.size() < 3)
			{
				v.push_back(0);
			}
			prop->m_Value = CValue::Vector(v.data(), 3);
		}
		std::vector<const CChunk*> otdas;
		if (const CChunk* otky = otst.List(FCC("otky")))
		{
			for (const CChunk& c : otky->m_Children)
			{
				if (c.m_uType == FCC("otda"))
				{
					otdas.push_back(&c);
				}
			}
		}
		for (size_t i = 0; i < prop->m_Keyframes.size() && i < otdas.size(); i++)
		{
			const std::vector<f64> v = DecodeDoubles(*otdas[i], false);
			prop->m_Keyframes[i].m_Value = CValue::Vector(v.data(), u32(std::min<size_t>(v.size(), 3)));
		}
		return prop;
	}

	std::unique_ptr<CPropertyNode> ParseShape(const CChunk& oms, const std::string& matchName, const sLayerContext& ctx,
		bool isMask, const std::string& layerName)
	{
		const CChunk* tdbs = oms.List(FCC("tdbs"));
		if (!tdbs)
		{
			Warn("layer \"" + layerName + "\": skipped " + matchName + ": shape has no tdbs");
			return nullptr;
		}
		auto prop = ParseLeaf(*tdbs, matchName, ctx, false);
		prop->m_uValueType = PVT_SHAPE;
		/** Masks on layers with a source are stored as fractions of the source size; elsewhere as layer pixels. */
		const f64 sx = ctx.m_bHasSource ? ctx.m_fWidth : 1;
		const f64 sy = ctx.m_bHasSource ? ctx.m_fHeight : 1;
		std::vector<std::shared_ptr<sShape>> shapes;
		if (const CChunk* omks = oms.List(FCC("omks")))
		{
			for (const CChunk* shap : omks->Lists(FCC("shap")))
			{
				shapes.push_back(DecodeShape(*shap, isMask, sx, sy));
			}
		}
		prop->m_Value = shapes.empty() ? CValue() : CValue::Shape(shapes[0]);
		for (size_t i = 0; i < prop->m_Keyframes.size(); i++)
		{
			prop->m_Keyframes[i].m_Value = i < shapes.size() ? CValue::Shape(shapes[i]) : CValue();
		}
		return prop;
	}

	/** Gradient ramps: `GCst` holds the tdbs plus one XML document per keyframe (or one static) in `GCky`. */
	std::unique_ptr<CPropertyNode> ParseGradient(const CChunk& gcst, const std::string& matchName, const sLayerContext& ctx,
		const std::string& layerName)
	{
		auto prop = ParseWrapped(gcst, matchName, ctx, PVT_CUSTOM_VALUE, true, layerName);
		if (!prop)
		{
			return nullptr;
		}
		std::vector<std::shared_ptr<sGradient>> ramps;
		if (const CChunk* gcky = gcst.List(FCC("GCky")))
		{
			for (const CChunk& c : gcky->m_Children)
			{
				if (c.m_uType == FCC("Utf8"))
				{
					ramps.push_back(ParseGradientXml(TextOf(&c)));
				}
			}
		}
		const auto value = [](const std::shared_ptr<sGradient>& g) { return g ? CValue::Gradient(g) : CValue(); };
		prop->m_Value = ramps.empty() ? CValue() : value(ramps[0]);
		for (size_t i = 0; i < prop->m_Keyframes.size(); i++)
		{
			prop->m_Keyframes[i].m_Value = i < ramps.size() ? value(ramps[i]) : CValue();
		}
		return prop;
	}

	std::unique_ptr<CPropertyNode> ParseWrapped(const CChunk& wrapper, const std::string& matchName,
		const sLayerContext& ctx, u32 valueType, bool withKeys, const std::string& layerName)
	{
		const CChunk* tdbs = wrapper.List(FCC("tdbs"));
		if (!tdbs)
		{
			Warn("layer \"" + layerName + "\": skipped " + matchName + ": no tdbs");
			return nullptr;
		}
		auto prop = ParseLeaf(*tdbs, matchName, ctx, false);
		prop->m_uValueType = valueType;
		prop->m_Value = CValue();
		if (!withKeys)
		{
			prop->m_Keyframes.clear();
		}
		else
		{
			for (sKeyframe& kf : prop->m_Keyframes)
			{
				kf.m_Value = CValue();
			}
		}
		return prop;
	}
};

} /** namespace */

bool ReadFileBytes(const std::string& path, std::vector<u8>& bytes, std::string& error)
{
	FILE* file = std::fopen(path.c_str(), "rb");
	if (!file)
	{
		error = "cannot open " + path;
		return false;
	}
	bytes.clear();
	u8 buffer[1 << 16];
	size_t n;
	while ((n = std::fread(buffer, 1, sizeof(buffer), file)) > 0)
	{
		bytes.insert(bytes.end(), buffer, buffer + n);
	}
	const bool ok = !std::ferror(file);
	std::fclose(file);
	if (!ok)
	{
		error = "cannot read " + path;
	}
	return ok;
}

bool ParseProject(std::vector<u8> bytes, CProject& project, std::string& error)
{
	project = CProject();
	project.m_Bytes = std::move(bytes);
	if (!ReadRifx(project.m_Bytes.data(), project.m_Bytes.size(), project.m_File, error))
	{
		return false;
	}
	const CChunk& root = project.m_File.m_Root;
	if (!project.m_File.m_Error.empty())
	{
		project.m_Warnings.push_back(project.m_File.m_Error);
	}
	if (const CChunk* head = root.Child(FCC("head")))
	{
		const u32 word = CBytes(*head).U32(4);
		const u32 major = ((word >> 26) & 0x1f) * 8 + ((word >> 19) & 0x07);
		project.m_Version = std::to_string(major) + "." + std::to_string((word >> 15) & 0x0f) + "x" + std::to_string(word & 0xff);
	}
	project.m_ExpressionEngine = TextOf(FindChild(root.List(FCC("ExEn")), FCC("Utf8")));
	if (project.m_ExpressionEngine.empty())
	{
		/** Projects without an ExEn chunk predate the JavaScript engine and use the legacy one. */
		project.m_ExpressionEngine = "extendscript";
	}
	CParser parser(project);
	parser.ParseEffectNames(root);
	const CChunk* rootList = root.List(FCC("Fold"));
	if (!rootList)
	{
		error = "project has no root folder (LIST:Fold)";
		return false;
	}
	for (const CChunk* itemList : rootList->Lists(FCC("Item")))
	{
		if (const CItem* item = parser.ParseItemList(*itemList, 0))
		{
			project.m_RootItems.push_back(item->m_uId);
		}
	}
	parser.ParseLayers();
	return true;
}

} /** namespace aep */
