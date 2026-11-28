/**
 * Dear ImGui drawn by the engine: the font atlas as an interface texture, and each frame's draw lists handed to
 * Engine::presentUi with the comp's frame for the Composition viewer to sample.
 */
#pragma once

#include <string>

#include "engine.h"
#include "imgui.h"
#include "types.h"

namespace aep
{

class CUiRenderer
{
public:
	/** The texture id that draws the frame passed to Present, bilinearly or (zoomed in) by nearest pixel. */
	static ImTextureID FrameTexture(bool nearest);

	/** Builds the font atlas (after the fonts are added to the current context) and uploads it. */
	bool Init(aevk::Engine& engine, std::string& error);
	/** Gives the font texture back; the engine must still be alive. */
	void Shutdown();
	/** Rebuilds the font atlas after the fonts changed (a new interface scale). */
	bool RebuildFonts(std::string& error);
	/** Draws `data` into the engine's window over `background`, sampling `frame` for FrameTexture. */
	bool Present(const ImDrawData& data, const aevk::Frame* frame, const float background[3], std::string& error);

private:
	aevk::Engine* m_pEngine = nullptr;
	u64 m_uFontTexture = 0;
	aevk::UiDrawData m_Data;
};

} /** namespace aep */
