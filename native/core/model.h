/**
 * The project model the native core evaluates: items, compositions, layers and property trees, as src/aep/model.ts
 * describes them. Field meanings and enum values follow the After Effects ExtendScript API.
 */
#pragma once

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "riff.h"
#include "types.h"

namespace aep
{

/** ExtendScript PropertyValueType. */
enum ePropertyValueType : u32
{
	PVT_NO_VALUE = 6412,
	PVT_THREE_D_SPATIAL = 6413,
	PVT_THREE_D = 6414,
	PVT_TWO_D_SPATIAL = 6415,
	PVT_TWO_D = 6416,
	PVT_ONE_D = 6417,
	PVT_COLOR = 6418,
	PVT_CUSTOM_VALUE = 6419,
	PVT_MARKER = 6420,
	PVT_LAYER_INDEX = 6421,
	PVT_MASK_INDEX = 6422,
	PVT_SHAPE = 6423,
	PVT_TEXT_DOCUMENT = 6424,
};

/** PF_ParamType: the control an effect parameter declares (EffectControlType in src/aep/model.ts). */
enum eEffectControl : u32
{
	CONTROL_LAYER = 0,
	CONTROL_INTEGER = 1,
	CONTROL_SCALAR = 2,
	CONTROL_ANGLE = 3,
	CONTROL_CHECKBOX = 4,
	CONTROL_COLOR = 5,
	CONTROL_POINT = 6,
	CONTROL_POPUP = 7,
	CONTROL_NO_DATA = 9,
	CONTROL_FLOAT_SLIDER = 10,
	CONTROL_ARBITRARY = 11,
	CONTROL_PATH = 12,
	CONTROL_GROUP_START = 13,
	CONTROL_GROUP_END = 14,
	CONTROL_BUTTON = 15,
	CONTROL_POINT_3D = 18,
	/** Not an effect parameter, or one its effect does not declare. */
	CONTROL_NONE = 0xffffffffu,
};

/** ExtendScript KeyframeInterpolationType. */
enum eInterpolation : u32
{
	INTERP_LINEAR = 6612,
	INTERP_BEZIER = 6613,
	INTERP_HOLD = 6614,
};

/** ExtendScript TrackMatteType. */
enum eTrackMatte : u32
{
	TRACK_MATTE_NONE = 5012,
	TRACK_MATTE_ALPHA = 5013,
	TRACK_MATTE_ALPHA_INVERTED = 5014,
	TRACK_MATTE_LUMA = 5015,
	TRACK_MATTE_LUMA_INVERTED = 5016,
};

/** ExtendScript AutoOrientType. */
enum eAutoOrient : u32
{
	AUTO_ORIENT_NONE = 4212,
	AUTO_ORIENT_ALONG_PATH = 4213,
	AUTO_ORIENT_CAMERA_OR_POINT_OF_INTEREST = 4214,
	AUTO_ORIENT_CHARACTERS_TOWARD_CAMERA = 4215,
};

struct sVec2
{
	f64 x = 0;
	f64 y = 0;
};

/** A bezier path: per vertex a point and its in and out tangents, relative to the point. */
struct sShape
{
	bool m_bClosed = false;
	std::vector<sVec2> m_Vertices;
	std::vector<sVec2> m_InTangents;
	std::vector<sVec2> m_OutTangents;
};

struct sGradientColorStop
{
	/** Position along the ramp, 0-1. */
	f64 m_fOffset = 0;
	/** Where between this stop and the next the blend reaches 50%, 0-1. */
	f64 m_fMidpoint = 0.5;
	f64 m_Color[3] = { 0, 0, 0 };
};

struct sGradientAlphaStop
{
	f64 m_fOffset = 0;
	f64 m_fMidpoint = 0.5;
	f64 m_fAlpha = 1;
};

/** A shape layer gradient ramp ("Colors" of a gradient fill or stroke). */
struct sGradient
{
	std::vector<sGradientColorStop> m_ColorStops;
	std::vector<sGradientAlphaStop> m_AlphaStops;
};

/**
 * A property value: nothing, a number, a vector of up to four numbers (points, colors), a path or a gradient. A
 * number and a one-element vector are different values, as `number` and `number[]` are in TypeScript.
 */
class CValue
{
public:
	enum eKind : u8
	{
		KIND_NONE,
		KIND_NUMBER,
		KIND_VECTOR,
		KIND_SHAPE,
		KIND_GRADIENT,
	};

	static const u32 MAX_COMPONENTS = 4;

	eKind m_eKind = KIND_NONE;
	u8 m_uCount = 0;
	f64 m_V[MAX_COMPONENTS] = { 0, 0, 0, 0 };
	std::shared_ptr<const sShape> m_pShape;
	std::shared_ptr<const sGradient> m_pGradient;

	static CValue Number(f64 v);
	static CValue Vector(const f64* v, u32 count);
	static CValue Shape(std::shared_ptr<const sShape> shape);
	static CValue Gradient(std::shared_ptr<const sGradient> gradient);

	bool IsNone() const { return m_eKind == KIND_NONE; }
	bool IsNumber() const { return m_eKind == KIND_NUMBER; }
	bool IsVector() const { return m_eKind == KIND_VECTOR; }
	bool IsNumeric() const { return m_eKind == KIND_NUMBER || m_eKind == KIND_VECTOR; }
	bool IsShape() const { return m_eKind == KIND_SHAPE && m_pShape; }
	bool IsGradient() const { return m_eKind == KIND_GRADIENT && m_pGradient; }

	/** Components as `asVector` reads them: a number is one component. */
	u32 Count() const { return IsNumeric() ? m_uCount : 0; }
	/** Component `i`, or `fallback` past the end. */
	f64 At(u32 i, f64 fallback = 0) const { return IsNumeric() && i < m_uCount ? m_V[i] : fallback; }
};

struct sEase
{
	f64 m_fSpeed = 0;
	/** Percent, 0-100. */
	f64 m_fInfluence = 0;
};

struct sKeyframe
{
	static const u32 MAX_EASES = 3;

	/** Composition seconds. */
	f64 m_fTime = 0;
	/** The owning layer's own seconds, the axis eases are defined on. */
	f64 m_fLayerTime = 0;
	CValue m_Value;
	u32 m_uInInterpolation = INTERP_LINEAR;
	u32 m_uOutInterpolation = INTERP_LINEAR;
	u8 m_uInEaseCount = 0;
	u8 m_uOutEaseCount = 0;
	sEase m_InEase[MAX_EASES];
	sEase m_OutEase[MAX_EASES];
	/** Spatial tangents (components as many as the value), when the keyframe has them. */
	u8 m_uSpatialCount = 0;
	f64 m_InSpatial[3] = { 0, 0, 0 };
	f64 m_OutSpatial[3] = { 0, 0, 0 };
	bool m_bSpatialAutoBezier = false;
	bool m_bSpatialContinuous = false;
	bool m_bTemporalAutoBezier = false;
	bool m_bTemporalContinuous = false;
	bool m_bRoving = false;
};

/** ExtendScript MaskMode and the mask flags stored in `mkif`. */
struct sMaskInfo
{
	bool m_bInverted = false;
	u32 m_uMode = 6812;
};

struct sPrepared;

/** A property or a property group. */
class CPropertyNode
{
public:
	CPropertyNode();
	~CPropertyNode();
	CPropertyNode(const CPropertyNode&) = delete;
	CPropertyNode& operator=(const CPropertyNode&) = delete;

	bool m_bGroup = false;
	std::string m_MatchName;
	bool m_bEnabled = true;

	/** Group: children in file order. */
	std::vector<std::unique_ptr<CPropertyNode>> m_Children;
	bool m_bEffect = false;
	std::string m_EffectName;
	bool m_bHasMask = false;
	sMaskInfo m_Mask;

	/** Property. */
	u32 m_uValueType = PVT_NO_VALUE;
	CValue m_Value;
	std::vector<sKeyframe> m_Keyframes;
	std::string m_Expression;
	bool m_bExpressionEnabled = false;
	bool m_bDimensionsSeparated = false;
	bool m_bSpatial = false;
	/** Created with a default because After Effects did not store it. */
	bool m_bSynthesized = false;
	/** Effect parameter: the control its effect declares for it, and a popup's choices. */
	u32 m_uControlType = CONTROL_NONE;
	std::vector<std::string> m_Options;

	/** Eases resolved for interpolation, built on first use (evaluate.cpp). */
	mutable std::unique_ptr<sPrepared> m_pPrepared;

	/** The child with `matchName`, or null. */
	const CPropertyNode* Find(const char* matchName) const;
	/** The child with `matchName` when it is a property / a group. */
	const CPropertyNode* FindProperty(const char* matchName) const;
	const CPropertyNode* FindGroup(const char* matchName) const;
	CPropertyNode* FindMutable(const char* matchName);
};

enum eLayerType : u8
{
	LAYER_AV,
	LAYER_LIGHT,
	LAYER_CAMERA,
	LAYER_TEXT,
	LAYER_SHAPE,
	LAYER_THREE_D_MODEL,
	LAYER_PARAMETRIC_MESH,
};

class CLayer
{
public:
	u32 m_uId = 0;
	/** 1-based, top first. */
	s32 m_iIndex = 0;
	std::string m_Name;
	eLayerType m_eType = LAYER_AV;
	u32 m_uSourceId = 0;
	f64 m_fStartTime = 0;
	f64 m_fInPoint = 0;
	f64 m_fOutPoint = 0;
	/** Percent; 100 is none, 0 when the file stores none. */
	f64 m_fStretch = 100;
	bool m_bEnabled = true;
	bool m_bSolo = false;
	bool m_bThreeD = false;
	bool m_bAdjustment = false;
	bool m_bNull = false;
	bool m_bGuide = false;
	bool m_bEffectsActive = true;
	bool m_bAudioEnabled = true;
	bool m_bTimeRemapEnabled = false;
	u32 m_uBlendMode = 5212;
	u32 m_uTrackMatteType = TRACK_MATTE_NONE;
	u32 m_uTrackMatteLayerId = 0;
	u32 m_uParentId = 0;
	u32 m_uAutoOrient = AUTO_ORIENT_NONE;
	/** The source's size, or the comp's for a layer without one. */
	f64 m_fWidth = 0;
	f64 m_fHeight = 0;
	/** The layer's top-level properties (Transform, Masks, Effects, Contents...). */
	CPropertyNode m_Properties;
};

enum eItemKind : u8
{
	ITEM_FOLDER,
	ITEM_FOOTAGE,
	ITEM_COMP,
};

enum eSourceType : u8
{
	SOURCE_SOLID,
	SOURCE_PLACEHOLDER,
	SOURCE_FILE,
};

/** Interpret Footage alpha modes (ExtendScript AlphaMode). */
enum eAlphaMode : u32
{
	ALPHA_STRAIGHT = 5412,
	ALPHA_IGNORE = 5413,
	ALPHA_PREMULTIPLIED = 5414,
};

/** A footage file's frames and how they are interpreted (FootageInterpretation and ImageSequence in src/aep/model.ts). */
struct sFootageSource
{
	bool m_bHasAlpha = false;
	/** eAlphaMode; footage without alpha reports Straight. */
	u32 m_uAlphaMode = ALPHA_STRAIGHT;
	bool m_bInvertAlpha = false;
	f64 m_PremulColor[3] = { 0, 0, 0 };
	/** No duration of its own (a still image). */
	bool m_bIsStill = true;
	u32 m_uLoop = 1;
	/** The project records a folder of numbered frames: the fields below are set. */
	bool m_bSequence = false;
	std::string m_SequencePrefix;
	std::string m_SequenceExtension;
	u32 m_uStartFrame = 0;
	u32 m_uEndFrame = 0;
	u32 m_uFramePadding = 0;
	/** Frame file names the project lists (StVc), when it lists them. */
	std::vector<std::string> m_FileNames;

	/** The file name of sequence frame number `frame` (sequenceFrameName in src/aep/footage.ts). */
	std::string FrameName(u32 frame) const;
};

class CItem
{
public:
	eItemKind m_eKind = ITEM_FOLDER;
	u32 m_uId = 0;
	std::string m_Name;
	u32 m_uParentFolderId = 0;

	/** Footage and comps. */
	f64 m_fWidth = 0;
	f64 m_fHeight = 0;
	f64 m_fDuration = 0;
	f64 m_fFrameRate = 0;
	f64 m_fPixelAspect = 1;

	/** Footage. */
	eSourceType m_eSource = SOURCE_FILE;
	f64 m_SolidColor[3] = { 0, 0, 0 };
	std::string m_File;
	sFootageSource m_Footage;
	/** Whether the footage has sound (an audio sample rate; the proxy's when "use proxy" is on). */
	bool m_bHasAudio = false;

	/** Comps. */
	f64 m_BgColor[3] = { 0, 0, 0 };
	std::vector<std::unique_ptr<CLayer>> m_Layers;

	/** Folders. */
	std::vector<u32> m_ChildIds;

	/** The layer with `id`, or null. */
	const CLayer* LayerById(u32 id) const;
};

class CProject
{
public:
	/** The file's bytes, which the chunk tree points into. */
	std::vector<u8> m_Bytes;
	sRifxFile m_File;
	std::string m_Version;
	std::string m_ExpressionEngine;
	std::map<u32, std::unique_ptr<CItem>> m_Items;
	std::vector<u32> m_RootItems;
	/** Effect match name to display name. */
	std::map<std::string, std::string> m_EffectTypes;
	std::vector<std::string> m_Warnings;

	const CItem* Item(u32 id) const;
	/** The first comp named `name`, or null. */
	const CItem* CompByName(const std::string& name) const;
};

} /** namespace aep */
