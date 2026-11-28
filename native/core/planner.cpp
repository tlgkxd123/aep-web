/**
 * Port of src/native/plan.ts and the draw order of src/render/composition.ts.
 */
#include "planner.h"

#include <algorithm>
#include <cmath>

#include "evaluate.h"
#include "shapes.h"

namespace aep
{

namespace
{

const u32 MASK_NONE = 6812;
const u32 NO_MATTE = TRACK_MATTE_NONE;
const u32 NORMAL = 5212;
/** Comps nested deeper than this render empty. */
const s32 MAX_DEPTH = 16;
const f64 PAD = aevk::kPad;

bool IsRenderable(const CLayer& layer)
{
	return layer.m_eType == LAYER_AV || layer.m_eType == LAYER_SHAPE || layer.m_eType == LAYER_TEXT;
}

bool IsActive(const CLayer& layer, f64 time)
{
	/** A time-reversed layer (negative stretch) has its in point after its out point. */
	return time >= std::min(layer.m_fInPoint, layer.m_fOutPoint) && time < std::max(layer.m_fInPoint, layer.m_fOutPoint);
}

/** The layer's track matte layer; none when it names no layer of the comp, and then the layer renders unmatted. */
const CLayer* MatteLayerOf(const CLayer& layer, const CItem& comp)
{
	if (!layer.m_uTrackMatteLayerId)
	{
		return nullptr;
	}
	for (const auto& l : comp.m_Layers)
	{
		if (l->m_uId == layer.m_uTrackMatteLayerId && l.get() != &layer)
		{
			return l.get();
		}
	}
	return nullptr;
}

bool AnySolo(const CItem& comp)
{
	for (const auto& l : comp.m_Layers)
	{
		if (l->m_bSolo && IsRenderable(*l))
		{
			return true;
		}
	}
	return false;
}

/** Layers to composite, bottom first; runs of adjacent 3D layers are sorted back to front. */
std::vector<const CLayer*> DrawOrder(const CItem& comp, f64 time, const sCamera* camera, bool solo)
{
	std::vector<const CLayer*> candidates;
	for (auto it = comp.m_Layers.rbegin(); it != comp.m_Layers.rend(); ++it)
	{
		const CLayer& l = **it;
		if (IsRenderable(l) && l.m_bEnabled && (!solo || l.m_bSolo) && !l.m_bNull && !l.m_bGuide && IsActive(l, time))
		{
			candidates.push_back(&l);
		}
	}
	if (!camera)
	{
		return candidates;
	}
	CMat4 viewInverse;
	camera->m_Rotation.Inverse(viewInverse);
	const auto depthOf = [&](const CLayer& layer) {
		const sLocalTransform t = LocalTransform(layer, time);
		const sVec3 world = WorldMatrix(layer, comp, time).TransformPoint(t.m_Anchor);
		const sVec3 rel = { world.x - camera->m_Position.x, world.y - camera->m_Position.y, world.z - camera->m_Position.z };
		return viewInverse.TransformVector(rel).z;
	};
	struct sEntry
	{
		const CLayer* m_pLayer;
		f64 m_fDepth;
	};
	std::vector<const CLayer*> result;
	std::vector<sEntry> run;
	const auto flush = [&] {
		/** Back to front; ties keep stack order (lower layers first). */
		std::stable_sort(run.begin(), run.end(), [](const sEntry& a, const sEntry& b) { return b.m_fDepth - a.m_fDepth < 0; });
		for (const sEntry& e : run)
		{
			result.push_back(e.m_pLayer);
		}
		run.clear();
	};
	for (const CLayer* layer : candidates)
	{
		if (layer->m_bThreeD)
		{
			run.push_back({ layer, depthOf(*layer) });
		}
		else
		{
			flush();
			result.push_back(layer);
		}
	}
	flush();
	return result;
}

std::vector<const CPropertyNode*> EnabledEffects(const CLayer& layer)
{
	std::vector<const CPropertyNode*> effects;
	if (!layer.m_bEffectsActive)
	{
		return effects;
	}
	const CPropertyNode* parade = layer.m_Properties.FindGroup("ADBE Effect Parade");
	if (!parade)
	{
		return effects;
	}
	for (const auto& e : parade->m_Children)
	{
		if (e->m_bGroup && e->m_bEnabled)
		{
			effects.push_back(e.get());
		}
	}
	return effects;
}

/** An effect the native engine renders (src/native/effects.ts nativeEffect). */
struct sNativeEffect
{
	const char* m_pMatchName;
	bool m_bScalable;
	bool m_bPassThrough;
};

/** The declared index `n` of a parameter named "<effect>-000n" (src/native/wire.ts paramIndex), or 0. */
u32 ParamIndex(const std::string& effect, const std::string& matchName)
{
	if (matchName.size() != effect.size() + 5 || matchName.compare(0, effect.size(), effect) != 0 || matchName[effect.size()] != '-')
	{
		return 0;
	}
	u32 index = 0;
	for (size_t i = effect.size() + 1; i < matchName.size(); i++)
	{
		const char c = matchName[i];
		if (c < '0' || c > '9')
		{
			return 0;
		}
		index = index * 10 + u32(c - '0');
	}
	return index;
}

const sNativeEffect* NativeEffect(const std::string& matchName)
{
	static const sNativeEffect s_Effects[] = {
#define AEVK_EFFECT(name, scalable, passThrough) { name, scalable, passThrough },
#include "../src/effects/list.inc"
#undef AEVK_EFFECT
	};
	static const sNativeEffect s_Pseudo = { "Pseudo/", true, true };
	for (const sNativeEffect& effect : s_Effects)
	{
		if (matchName == effect.m_pMatchName)
		{
			return &effect;
		}
	}
	return matchName.rfind("Pseudo/", 0) == 0 ? &s_Pseudo : nullptr;
}

f64 NumberAt(const CPropertyNode* prop, f64 time, const CLayer& layer, f64 fallback)
{
	if (!prop)
	{
		return fallback;
	}
	const CValue v = CurrentValue(*prop, time, layer);
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

/** The ratio of the source's pixel aspect to the comp's (src/render/footage.ts sourcePixelAspect). */
f64 SourcePixelAspect(const CLayer& layer, const CItem& comp, const CProject& project)
{
	const CItem* item = layer.m_uSourceId ? project.Item(layer.m_uSourceId) : nullptr;
	if (!item || item->m_eKind == ITEM_FOLDER)
	{
		return 1;
	}
	const f64 source = item->m_fPixelAspect != 0 && !std::isnan(item->m_fPixelAspect) ? item->m_fPixelAspect : 1;
	const f64 target = comp.m_fPixelAspect != 0 && !std::isnan(comp.m_fPixelAspect) ? comp.m_fPixelAspect : 1;
	return source / target;
}

u32 MatteMode(u32 trackMatteType)
{
	switch (trackMatteType)
	{
	case TRACK_MATTE_ALPHA: return aevk::matte::Alpha;
	case TRACK_MATTE_ALPHA_INVERTED: return aevk::matte::AlphaInverted;
	case TRACK_MATTE_LUMA: return aevk::matte::Luma;
	case TRACK_MATTE_LUMA_INVERTED: return aevk::matte::LumaInverted;
	default: return aevk::matte::None;
	}
}

void StoreMatrix(const CMat4& m, std::array<float, 16>& out)
{
	for (s32 i = 0; i < 16; i++)
	{
		out[size_t(i)] = float(m.m[i]);
	}
}

/** JavaScript's ToUint32, as the wire writer applies it to sizes. */
u32 ToUint32(f64 v)
{
	if (!std::isfinite(v))
	{
		return 0;
	}
	const f64 m = std::fmod(std::trunc(v), 4294967296.0);
	return u32(s64(m < 0 ? m + 4294967296.0 : m));
}

bool HasExpressions(const CPropertyNode& node)
{
	if (!node.m_bGroup)
	{
		return node.m_bExpressionEnabled;
	}
	for (const auto& child : node.m_Children)
	{
		if (HasExpressions(*child))
		{
			return true;
		}
	}
	return false;
}

} /** namespace */

f64 ScaledSize(f64 size, f64 scale)
{
	return scale == 1 ? size : std::max(1.0, std::ceil(size * scale - 1e-6));
}

sFramePlan CFramePlanner::Build(const CItem& comp, f64 time, f64 scale)
{
	sFramePlan out;
	m_pOut = &out;
	IExpressionEvaluator* previous = nullptr;
	if (m_pExpressions)
	{
		m_pExpressions->BeginFrame();
		previous = SetExpressionEvaluator(m_pExpressions);
	}
	PlanComp(comp, time, 0, scale, out.m_Plan.root);
	if (m_pExpressions)
	{
		SetExpressionEvaluator(previous);
		m_pExpressions->TakeWarnings(out.m_Warnings);
	}
	m_pOut = nullptr;
	return out;
}

void CFramePlanner::Unsupported(const std::string& what)
{
	if (std::find(m_pOut->m_Unsupported.begin(), m_pOut->m_Unsupported.end(), what) == m_pOut->m_Unsupported.end())
	{
		m_pOut->m_Unsupported.push_back(what);
	}
}

void CFramePlanner::Warn(const std::string& what)
{
	if (std::find(m_pOut->m_Warnings.begin(), m_pOut->m_Warnings.end(), what) == m_pOut->m_Warnings.end())
	{
		m_pOut->m_Warnings.push_back(what);
	}
}

void CFramePlanner::NoteExpressions(const CLayer& layer)
{
	if (!m_pExpressions && HasExpressions(layer.m_Properties) &&
		std::find(m_pOut->m_Expressions.begin(), m_pOut->m_Expressions.end(), layer.m_Name) == m_pOut->m_Expressions.end())
	{
		m_pOut->m_Expressions.push_back(layer.m_Name);
	}
}

void CFramePlanner::PlanComp(const CItem& comp, f64 time, s32 depth, f64 scale, aevk::Comp& out)
{
	out.width = ToUint32(ScaledSize(comp.m_fWidth, scale));
	out.height = ToUint32(ScaledSize(comp.m_fHeight, scale));
	out.layers.clear();
	if (depth > MAX_DEPTH)
	{
		Warn("compositions nested deeper than " + std::to_string(MAX_DEPTH) + " levels were not rendered");
		return;
	}
	bool any3D = false;
	for (const auto& l : comp.m_Layers)
	{
		any3D = any3D || l->m_bThreeD;
	}
	sCamera camera;
	if (any3D)
	{
		camera = CameraAt(comp, time, ActiveCameraLayer(comp, time));
	}
	const sCamera* cameraPtr = any3D ? &camera : nullptr;
	for (const CLayer* layer : DrawOrder(comp, time, cameraPtr, AnySolo(comp)))
	{
		aevk::Layer placed;
		if (!Placed(*layer, comp, time, cameraPtr, depth, scale, layer->m_bAdjustment, placed))
		{
			continue;
		}
		if (layer->m_bAdjustment && !EnabledEffects(*layer).empty())
		{
			Unsupported("adjustment layer effects (\"" + layer->m_Name + "\")");
		}
		placed.blendMode = layer->m_uBlendMode;
		placed.opacity = float(LocalTransform(*layer, time).m_fOpacity / 100);
		const CLayer* matteLayer = layer->m_uTrackMatteType != NO_MATTE ? MatteLayerOf(*layer, comp) : nullptr;
		if (matteLayer)
		{
			const u32 mode = MatteMode(layer->m_uTrackMatteType);
			/** A matte is used even when its own video is switched off, but only while it is in its time span. */
			auto matte = std::make_unique<aevk::Layer>();
			bool hasMatte = false;
			if (IsActive(*matteLayer, time))
			{
				hasMatte = Placed(*matteLayer, comp, time, cameraPtr, depth, scale, false, *matte);
			}
			const f64 opacity = hasMatte ? LocalTransform(*matteLayer, time).m_fOpacity / 100 : 1;
			if (mode != aevk::matte::None)
			{
				placed.matteMode = mode;
				placed.matteOpacity = float(opacity);
				placed.matte = hasMatte ? std::move(matte) : nullptr;
			}
		}
		out.layers.push_back(std::move(placed));
	}
}

bool CFramePlanner::Placed(const CLayer& layer, const CItem& comp, f64 time, const sCamera* camera, s32 depth, f64 scale,
	bool adjustment, aevk::Layer& out)
{
	if (!adjustment)
	{
		std::string missing;
		bool unscalable = false;
		for (const CPropertyNode* effect : EnabledEffects(layer))
		{
			const sNativeEffect* native = NativeEffect(effect->m_MatchName);
			if (!native)
			{
				missing += (missing.empty() ? "" : ", ") + (effect->m_EffectName.empty() ? effect->m_MatchName : effect->m_EffectName);
			}
			else if (!native->m_bScalable)
			{
				unscalable = true;
			}
		}
		if (!missing.empty())
		{
			Unsupported("effects (" + missing + " on \"" + layer.m_Name + "\")");
		}
		else if (scale != 1 && unscalable)
		{
			Unsupported("effects at a reduced resolution (\"" + layer.m_Name + "\")");
		}
	}
	if (!Content(layer, time, depth, scale, out.content))
	{
		return false;
	}
	NoteExpressions(layer);
	CMat4 matrix;
	f64 zoom = 0;
	if (layer.m_bThreeD && camera)
	{
		/** World -> camera space: R^T (p - eye). */
		CMat4 rotationInverse;
		camera->m_Rotation.Inverse(rotationInverse);
		const CMat4 view = rotationInverse * CMat4::Translation(-camera->m_Position.x, -camera->m_Position.y, -camera->m_Position.z);
		matrix = view * WorldMatrix(layer, comp, time);
		zoom = camera->m_fZoom * scale;
	}
	else
	{
		CMat4 world = WorldMatrix(layer, comp, time);
		const f64 aspect = SourcePixelAspect(layer, comp, m_Project);
		if (aspect != 1)
		{
			/** Non-square source pixels stretch the layer horizontally about its anchor point. */
			const sVec3 anchor = LocalTransform(layer, time).m_Anchor;
			world = world * (CMat4::Translation(anchor.x, anchor.y, 0) * CMat4::Scale(aspect, 1, 1) * CMat4::Translation(-anchor.x, -anchor.y, 0));
		}
		const CMat4 toTarget = scale == 1 ? CMat4::Translation(PAD, PAD, 0) : CMat4::Translation(PAD, PAD, 0) * CMat4::Scale(scale, scale, 1);
		matrix = toTarget * world;
	}
	out.adjustment = adjustment;
	out.blendMode = NORMAL;
	out.opacity = 1;
	StoreMatrix(matrix, out.matrix);
	out.zoom = float(zoom);
	Masks(layer, time, scale, out.masks);
	out.effects.clear();
	if (!adjustment)
	{
		Effects(layer, time, out.effects);
	}
	if (!out.effects.empty())
	{
		aevk::EffectLayer& info = out.effectLayer;
		info.time = time;
		info.startTime = layer.m_fStartTime;
		info.width = float(layer.m_fWidth);
		info.height = float(layer.m_fHeight);
		info.kind = layer.m_eType == LAYER_AV ? 0 : layer.m_eType == LAYER_SHAPE ? 1 : 2;
	}
	return true;
}

void CFramePlanner::Effects(const CLayer& layer, f64 time, std::vector<aevk::Effect>& out)
{
	for (const CPropertyNode* effect : EnabledEffects(layer))
	{
		const sNativeEffect* native = NativeEffect(effect->m_MatchName);
		if (!native || native->m_bPassThrough)
		{
			continue;
		}
		aevk::Effect planned;
		planned.matchName = effect->m_MatchName;
		for (const auto& child : effect->m_Children)
		{
			const CPropertyNode& node = *child;
			if (node.m_bGroup)
			{
				continue;
			}
			const CValue value = CurrentValue(node, time, layer, effect);
			if (!value.IsNumeric())
			{
				continue;
			}
			aevk::EffectParam param;
			param.index = ParamIndex(effect->m_MatchName, node.m_MatchName);
			if (!param.index)
			{
				param.matchName = node.m_MatchName;
			}
			for (u32 i = 0; i < value.Count(); i++)
			{
				param.value.push_back(value.m_V[i]);
			}
			for (const std::string& option : node.m_Options)
			{
				param.menu.push_back(option.rfind("(-", 0) == 0 ? 1 : 0);
			}
			planned.params.push_back(std::move(param));
		}
		out.push_back(std::move(planned));
	}
}

bool CFramePlanner::Content(const CLayer& layer, f64 time, s32 depth, f64 scale, aevk::Content& out)
{
	const CItem* source = layer.m_uSourceId ? m_Project.Item(layer.m_uSourceId) : nullptr;
	out.scale = float(scale);
	out.originX = 0;
	out.originY = 0;
	if (layer.m_eType == LAYER_SHAPE)
	{
		sShapeLayerPlan shape;
		if (!PlanShapeLayer(layer, time, scale, PAD, shape))
		{
			return false;
		}
		if (shape.m_bDashed)
		{
			Unsupported("dashed strokes (\"" + layer.m_Name + "\")");
		}
		out.kind = aevk::ContentKind::Shape;
		out.width = ToUint32(shape.m_fWidth);
		out.height = ToUint32(shape.m_fHeight);
		out.originX = float(shape.m_fOriginX);
		out.originY = float(shape.m_fOriginY);
		out.paints = std::move(shape.m_Paints);
		return true;
	}
	if (layer.m_eType != LAYER_AV)
	{
		Unsupported("text layers (\"" + layer.m_Name + "\")");
		return false;
	}
	if (source && source->m_eKind == ITEM_FOOTAGE && source->m_eSource == SOURCE_SOLID)
	{
		out.kind = aevk::ContentKind::Solid;
		out.width = ToUint32(ScaledSize(source->m_fWidth, scale));
		out.height = ToUint32(ScaledSize(source->m_fHeight, scale));
		out.color = { float(source->m_SolidColor[0]), float(source->m_SolidColor[1]), float(source->m_SolidColor[2]) };
		return true;
	}
	if (source && source->m_eKind == ITEM_COMP)
	{
		f64 sourceTime = LayerTimeAt(layer, time);
		if (layer.m_bTimeRemapEnabled)
		{
			if (const CPropertyNode* remap = layer.m_Properties.FindProperty("ADBE Time Remapping"))
			{
				const CValue value = CurrentValue(*remap, time, layer);
				if (value.IsNumber())
				{
					sourceTime = value.m_V[0];
				}
			}
		}
		auto comp = std::make_unique<aevk::Comp>();
		PlanComp(*source, sourceTime, depth + 1, scale, *comp);
		out.kind = aevk::ContentKind::Comp;
		out.width = comp->width;
		out.height = comp->height;
		out.comp = std::move(comp);
		return true;
	}
	if (source && source->m_eKind == ITEM_FOOTAGE)
	{
		Unsupported("footage (\"" + source->m_Name + "\")");
	}
	return false;
}

void CFramePlanner::Masks(const CLayer& layer, f64 time, f64 scale, std::vector<aevk::Mask>& out)
{
	out.clear();
	const CPropertyNode* parade = layer.m_Properties.FindGroup("ADBE Mask Parade");
	if (!parade)
	{
		return;
	}
	for (const auto& node : parade->m_Children)
	{
		const CPropertyNode& mask = *node;
		if (!mask.m_bGroup || !mask.m_bHasMask || !mask.m_bEnabled || mask.m_Mask.m_uMode == MASK_NONE)
		{
			continue;
		}
		aevk::Mask m;
		const CPropertyNode* shapeProp = mask.FindProperty("ADBE Mask Shape");
		const CValue shape = shapeProp ? CurrentValue(*shapeProp, time, layer) : CValue();
		const CPropertyNode* featherProp = mask.FindProperty("ADBE Mask Feather");
		const CValue feather = featherProp ? CurrentValue(*featherProp, time, layer) : CValue();
		if (shape.IsShape())
		{
			const sShape& s = *shape.m_pShape;
			m.closed = s.m_bClosed;
			for (size_t i = 0; i < s.m_Vertices.size(); i++)
			{
				const sVec2 in = i < s.m_InTangents.size() ? s.m_InTangents[i] : sVec2{};
				const sVec2 o = i < s.m_OutTangents.size() ? s.m_OutTangents[i] : sVec2{};
				const f64 v[6] = { s.m_Vertices[i].x, s.m_Vertices[i].y, in.x, in.y, o.x, o.y };
				for (const f64 x : v)
				{
					m.vertices.push_back(float(x));
				}
			}
		}
		m.mode = mask.m_Mask.m_uMode;
		m.inverted = mask.m_Mask.m_bInverted;
		m.opacity = float(NumberAt(mask.FindProperty("ADBE Mask Opacity"), time, layer, 100) / 100);
		f64 featherRadius = 0;
		if (feather.IsVector())
		{
			const f64 fx = feather.m_uCount > 0 ? feather.m_V[0] : 0;
			const f64 fy = feather.m_uCount > 1 ? feather.m_V[1] : 0;
			featherRadius = std::isnan(fx) || std::isnan(fy) ? fx + fy : std::max(fx, fy);
		}
		m.feather = float(featherRadius * scale);
		m.expansion = float(NumberAt(mask.FindProperty("ADBE Mask Offset"), time, layer, 0));
		out.push_back(std::move(m));
	}
}

} /** namespace aep */
