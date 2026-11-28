/**
 * See render.h.
 */
#include "render.h"

#include <cstring>

namespace aep
{

namespace
{

static_assert(sizeof(ImDrawVert) == sizeof(aevk::UiVertex), "ImDrawVert and UiVertex must match (pos, uv, col)");
static_assert(sizeof(ImDrawIdx) == sizeof(u32), "the app builds Dear ImGui with 32-bit indices (aep_imconfig.h)");

/** The frame sampled by nearest pixel: one below kUiFrameTexture, which no interface texture reaches. */
const u64 kFrameNearest = aevk::kUiFrameTexture - 1;

} /** namespace */

ImTextureID CUiRenderer::FrameTexture(bool nearest)
{
	return ImTextureID(nearest ? kFrameNearest : aevk::kUiFrameTexture);
}

bool CUiRenderer::Init(aevk::Engine& engine, std::string& error)
{
	m_pEngine = &engine;
	return RebuildFonts(error);
}

void CUiRenderer::Shutdown()
{
	if (m_pEngine && m_uFontTexture)
	{
		m_pEngine->destroyUiTexture(m_uFontTexture);
	}
	m_uFontTexture = 0;
	m_pEngine = nullptr;
}

bool CUiRenderer::RebuildFonts(std::string& error)
{
	ImGuiIO& io = ImGui::GetIO();
	unsigned char* pixels = nullptr;
	s32 width = 0;
	s32 height = 0;
	io.Fonts->GetTexDataAsRGBA32(&pixels, &width, &height);
	const u64 texture = m_pEngine->createUiTexture(pixels, u32(width), u32(height), error);
	if (!texture)
	{
		return false;
	}
	if (m_uFontTexture)
	{
		m_pEngine->destroyUiTexture(m_uFontTexture);
	}
	m_uFontTexture = texture;
	io.Fonts->SetTexID(ImTextureID(texture));
	/** The atlas lives on the GPU now; the CPU copy is not needed again. */
	io.Fonts->ClearTexData();
	return true;
}

bool CUiRenderer::Present(const ImDrawData& data, const aevk::Frame* frame, const float background[3], std::string& error)
{
	m_Data.vertices.clear();
	m_Data.indices.clear();
	m_Data.commands.clear();
	m_Data.vertices.reserve(size_t(data.TotalVtxCount));
	m_Data.indices.reserve(size_t(data.TotalIdxCount));
	const ImVec2 origin = data.DisplayPos;
	const ImVec2 scale = data.FramebufferScale;
	for (const ImDrawList* list : data.CmdLists)
	{
		const u32 firstVertex = u32(m_Data.vertices.size());
		const u32 firstIndex = u32(m_Data.indices.size());
		m_Data.vertices.resize(firstVertex + u32(list->VtxBuffer.Size));
		std::memcpy(static_cast<void*>(&m_Data.vertices[firstVertex]), list->VtxBuffer.Data, size_t(list->VtxBuffer.Size) * sizeof(ImDrawVert));
		m_Data.indices.insert(m_Data.indices.end(), list->IdxBuffer.Data, list->IdxBuffer.Data + list->IdxBuffer.Size);
		/** Positions are in the interface's units; the window's pixels may be more (FramebufferScale). */
		if (origin.x != 0 || origin.y != 0 || scale.x != 1 || scale.y != 1)
		{
			for (u32 i = firstVertex; i < m_Data.vertices.size(); i++)
			{
				m_Data.vertices[i].x = (m_Data.vertices[i].x - origin.x) * scale.x;
				m_Data.vertices[i].y = (m_Data.vertices[i].y - origin.y) * scale.y;
			}
		}
		for (const ImDrawCmd& cmd : list->CmdBuffer)
		{
			if (cmd.UserCallback || !cmd.ElemCount)
			{
				continue;
			}
			aevk::UiCommand out;
			out.clip[0] = (cmd.ClipRect.x - origin.x) * scale.x;
			out.clip[1] = (cmd.ClipRect.y - origin.y) * scale.y;
			out.clip[2] = (cmd.ClipRect.z - origin.x) * scale.x;
			out.clip[3] = (cmd.ClipRect.w - origin.y) * scale.y;
			const u64 texture = u64(cmd.GetTexID());
			out.texture = texture == kFrameNearest ? aevk::kUiFrameTexture : texture;
			out.nearest = texture == kFrameNearest;
			out.firstIndex = firstIndex + cmd.IdxOffset;
			out.indexCount = cmd.ElemCount;
			out.vertexOffset = s32(firstVertex + cmd.VtxOffset);
			m_Data.commands.push_back(out);
		}
	}
	return m_pEngine->presentUi(m_Data, frame, background, error);
}

} /** namespace aep */
