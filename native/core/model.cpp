/**
 * Out-of-line parts of the project model.
 */
#include "model.h"

#include <algorithm>
#include <cstring>

#include "evaluate.h"

namespace aep
{

CValue CValue::Number(f64 v)
{
	CValue value;
	value.m_eKind = KIND_NUMBER;
	value.m_uCount = 1;
	value.m_V[0] = v;
	return value;
}

CValue CValue::Vector(const f64* v, u32 count)
{
	CValue value;
	value.m_eKind = KIND_VECTOR;
	value.m_uCount = u8(std::min(count, MAX_COMPONENTS));
	for (u32 i = 0; i < value.m_uCount; i++)
	{
		value.m_V[i] = v[i];
	}
	return value;
}

CValue CValue::Shape(std::shared_ptr<const sShape> shape)
{
	CValue value;
	value.m_eKind = KIND_SHAPE;
	value.m_pShape = std::move(shape);
	return value;
}

CValue CValue::Gradient(std::shared_ptr<const sGradient> gradient)
{
	CValue value;
	value.m_eKind = KIND_GRADIENT;
	value.m_pGradient = std::move(gradient);
	return value;
}

CPropertyNode::CPropertyNode() = default;
CPropertyNode::~CPropertyNode() = default;

const CPropertyNode* CPropertyNode::Find(const char* matchName) const
{
	for (const auto& child : m_Children)
	{
		if (child->m_MatchName == matchName)
		{
			return child.get();
		}
	}
	return nullptr;
}

const CPropertyNode* CPropertyNode::FindProperty(const char* matchName) const
{
	const CPropertyNode* node = Find(matchName);
	return node && !node->m_bGroup ? node : nullptr;
}

const CPropertyNode* CPropertyNode::FindGroup(const char* matchName) const
{
	const CPropertyNode* node = Find(matchName);
	return node && node->m_bGroup ? node : nullptr;
}

CPropertyNode* CPropertyNode::FindMutable(const char* matchName)
{
	return const_cast<CPropertyNode*>(Find(matchName));
}

std::string sFootageSource::FrameName(u32 frame) const
{
	const u32 index = frame - m_uStartFrame;
	if (m_FileNames.size() == size_t(m_uEndFrame - m_uStartFrame) + 1 && index < m_FileNames.size() && !m_FileNames[index].empty())
	{
		return m_FileNames[index];
	}
	std::string digits = std::to_string(frame);
	if (digits.size() < m_uFramePadding)
	{
		digits.insert(0, m_uFramePadding - digits.size(), '0');
	}
	return m_SequencePrefix + digits + m_SequenceExtension;
}

const CLayer* CItem::LayerById(u32 id) const
{
	for (const auto& layer : m_Layers)
	{
		if (layer->m_uId == id)
		{
			return layer.get();
		}
	}
	return nullptr;
}

const CItem* CProject::Item(u32 id) const
{
	const auto found = m_Items.find(id);
	return found != m_Items.end() ? found->second.get() : nullptr;
}

const CItem* CProject::CompByName(const std::string& name) const
{
	for (const auto& entry : m_Items)
	{
		if (entry.second->m_eKind == ITEM_COMP && entry.second->m_Name == name)
		{
			return entry.second.get();
		}
	}
	return nullptr;
}

} /** namespace aep */
