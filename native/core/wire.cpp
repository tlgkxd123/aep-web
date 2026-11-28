/**
 * Port of src/native/wire.ts encodePlan.
 */
#include "wire.h"

#include <cstring>

namespace aep
{

namespace
{

class CWriter
{
public:
	void U32(u32 v)
	{
		const u8 b[4] = { u8(v), u8(v >> 8), u8(v >> 16), u8(v >> 24) };
		m_Bytes.insert(m_Bytes.end(), b, b + 4);
	}

	void F32(float v)
	{
		u32 bits;
		std::memcpy(&bits, &v, 4);
		U32(bits);
	}

	void Raw(const std::vector<u8>& data) { m_Bytes.insert(m_Bytes.end(), data.begin(), data.end()); }

	std::vector<u8> m_Bytes;
};

void WriteLayer(CWriter& w, const aevk::Layer& layer);

void WriteComp(CWriter& w, const aevk::Comp& comp)
{
	w.U32(comp.width);
	w.U32(comp.height);
	w.U32(u32(comp.layers.size()));
	for (const aevk::Layer& layer : comp.layers)
	{
		WriteLayer(w, layer);
	}
}

void WritePaint(CWriter& w, const aevk::ShapePaint& paint)
{
	w.U32((paint.stroke ? 1u : 0u) | (paint.evenOdd ? 2u : 0u));
	for (const float v : paint.matrix)
	{
		w.F32(v);
	}
	w.F32(paint.width);
	w.U32(paint.cap);
	w.U32(paint.join);
	w.F32(paint.miterLimit);
	for (const float c : paint.color)
	{
		w.F32(c);
	}
	w.U32(paint.gradient);
	if (paint.gradient)
	{
		for (const float v : paint.start)
		{
			w.F32(v);
		}
		for (const float v : paint.end)
		{
			w.F32(v);
		}
		for (const float v : paint.focus)
		{
			w.F32(v);
		}
		w.U32(u32(paint.ramp.size() / 4));
		for (const float v : paint.ramp)
		{
			w.F32(v);
		}
	}
	w.U32(u32(paint.paths.size()));
	for (const aevk::ShapePath& path : paint.paths)
	{
		w.U32(path.closed ? 1 : 0);
		w.U32(u32(path.vertices.size() / 6));
		for (const float v : path.vertices)
		{
			w.F32(v);
		}
	}
}

void WriteContent(CWriter& w, const aevk::Content& content)
{
	w.U32(u32(content.kind));
	w.U32(content.width);
	w.U32(content.height);
	w.F32(content.originX);
	w.F32(content.originY);
	w.F32(content.scale);
	switch (content.kind)
	{
	case aevk::ContentKind::Solid:
		for (const float c : content.color)
		{
			w.F32(c);
		}
		break;
	case aevk::ContentKind::Comp:
		WriteComp(w, *content.comp);
		break;
	case aevk::ContentKind::Image:
		w.U32(content.image);
		break;
	case aevk::ContentKind::Shape:
		w.U32(u32(content.paints.size()));
		for (const aevk::ShapePaint& paint : content.paints)
		{
			WritePaint(w, paint);
		}
		break;
	}
}

void WriteMask(CWriter& w, const aevk::Mask& mask)
{
	w.U32(mask.mode);
	w.U32(mask.inverted ? 1 : 0);
	w.F32(mask.opacity);
	w.F32(mask.feather);
	w.F32(mask.expansion);
	w.U32(mask.closed ? 1 : 0);
	w.U32(u32(mask.vertices.size() / 6));
	for (const float v : mask.vertices)
	{
		w.F32(v);
	}
}

void WriteLayer(CWriter& w, const aevk::Layer& layer)
{
	w.U32(layer.adjustment ? 1 : 0);
	w.U32(layer.blendMode);
	w.F32(layer.opacity);
	for (const float v : layer.matrix)
	{
		w.F32(v);
	}
	w.F32(layer.zoom);
	WriteContent(w, layer.content);
	w.U32(u32(layer.masks.size()));
	for (const aevk::Mask& mask : layer.masks)
	{
		WriteMask(w, mask);
	}
	w.U32(layer.matteMode);
	if (layer.matteMode != aevk::matte::None)
	{
		w.F32(layer.matteOpacity);
		w.U32(layer.matte ? 1 : 0);
		if (layer.matte)
		{
			WriteLayer(w, *layer.matte);
		}
	}
}

} /** namespace */

std::vector<u8> EncodePlan(const aevk::Plan& plan)
{
	CWriter w;
	w.U32(aevk::kPlanMagic);
	w.U32(aevk::kPlanVersion);
	WriteComp(w, plan.root);
	w.U32(u32(plan.images.size()));
	for (const aevk::Image& image : plan.images)
	{
		w.U32(image.width);
		w.U32(image.height);
		w.Raw(image.pixels);
	}
	return w.m_Bytes;
}

} /** namespace aep */
