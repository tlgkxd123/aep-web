/**
 * See app.h.
 */
#include "app.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>

#include "evaluate.h"
#include "imgui_internal.h"

namespace aep
{

/** Roboto Medium (Apache 2.0), from Dear ImGui's misc/fonts, embedded by native/CMakeLists.txt. */
extern const unsigned char g_UiFont[];
extern const size_t g_UiFontSize;

namespace
{

enum eIcon
{
	ICON_PLAY,
	ICON_PAUSE,
	ICON_STEP_BACK,
	ICON_STEP_FORWARD,
	ICON_TO_START,
	ICON_TO_END,
	ICON_MENU,
	ICON_FOLDER,
	ICON_GRID,
};

/** Interface colors: After Effects' dark panels with its blue accent. */
const ImU32 kAccent = IM_COL32(45, 140, 235, 255);
const ImU32 kAccentDim = IM_COL32(45, 140, 235, 110);
const ImU32 kPlayhead = IM_COL32(64, 160, 255, 255);
const ImU32 kTextDim = IM_COL32(150, 150, 150, 255);
const ImU32 kRowAlt = IM_COL32(255, 255, 255, 8);
const float kBackground[3] = { 0.09f, 0.09f, 0.09f };

/** Desktop layout below this many interface units across; one column (phones held upright) otherwise. */
const f32 kCompactWidth = 720;
/** Font size in interface units, on desktop and on touch screens. */
const f32 kFontSize = 15;
const f32 kTouchFontSize = 17;

/** Bar colors in the Timeline, by layer type (After Effects' default label colors for each kind). */
ImU32 LayerColor(const CLayer& layer)
{
	if (layer.m_bAdjustment)
	{
		return IM_COL32(164, 164, 164, 255);
	}
	if (layer.m_bNull)
	{
		return IM_COL32(188, 136, 75, 255);
	}
	switch (layer.m_eType)
	{
	case LAYER_TEXT: return IM_COL32(200, 70, 70, 255);
	case LAYER_SHAPE: return IM_COL32(64, 135, 212, 255);
	case LAYER_CAMERA: return IM_COL32(167, 103, 196, 255);
	case LAYER_LIGHT: return IM_COL32(214, 176, 66, 255);
	default: return IM_COL32(112, 168, 120, 255);
	}
}

const char* LayerKind(const CLayer& layer, const CItem* source)
{
	if (layer.m_bAdjustment)
	{
		return "Adjustment layer";
	}
	if (layer.m_bNull)
	{
		return "Null object";
	}
	switch (layer.m_eType)
	{
	case LAYER_TEXT: return "Text layer";
	case LAYER_SHAPE: return "Shape layer";
	case LAYER_CAMERA: return "Camera";
	case LAYER_LIGHT: return "Light";
	case LAYER_THREE_D_MODEL: return "3D model";
	default: break;
	}
	if (!source)
	{
		return "Layer";
	}
	if (source->m_eKind == ITEM_COMP)
	{
		return "Precomp";
	}
	return source->m_eSource == SOURCE_SOLID ? "Solid" : "Footage";
}

/** The Transform group's properties, as the Timeline names them. */
const char* TransformName(const std::string& matchName)
{
	static const std::pair<const char*, const char*> s_Names[] = {
		{ "ADBE Anchor Point", "Anchor Point" },
		{ "ADBE Position", "Position" },
		{ "ADBE Position_0", "X Position" },
		{ "ADBE Position_1", "Y Position" },
		{ "ADBE Position_2", "Z Position" },
		{ "ADBE Scale", "Scale" },
		{ "ADBE Orientation", "Orientation" },
		{ "ADBE Rotate X", "X Rotation" },
		{ "ADBE Rotate Y", "Y Rotation" },
		{ "ADBE Rotate Z", "Rotation" },
		{ "ADBE Opacity", "Opacity" },
	};
	for (const auto& name : s_Names)
	{
		if (matchName == name.first)
		{
			return name.second;
		}
	}
	return nullptr;
}

/** A property's value in a line: numbers to two places, colors as hex, shapes and gradients by kind. */
std::string ValueText(const CValue& value, bool color, u32 maxCount)
{
	char text[128];
	if (value.IsShape())
	{
		std::snprintf(text, sizeof(text), "path, %zu points", value.m_pShape->m_Vertices.size());
		return text;
	}
	if (value.IsGradient())
	{
		return "gradient";
	}
	if (!value.IsNumeric())
	{
		return "";
	}
	if (color && value.Count() >= 3)
	{
		const auto channel = [&](u32 i) { return s32(std::lround(std::clamp(value.At(i), 0.0, 1.0) * 255)); };
		std::snprintf(text, sizeof(text), "#%02X%02X%02X", channel(0), channel(1), channel(2));
		return text;
	}
	std::string out;
	for (u32 i = 0; i < std::min(value.Count(), maxCount); i++)
	{
		std::snprintf(text, sizeof(text), i ? ", %.2f" : "%.2f", value.At(i));
		out += text;
	}
	return out;
}

ImVec2 Add(const ImVec2& a, const ImVec2& b)
{
	return ImVec2(a.x + b.x, a.y + b.y);
}

} /** namespace */

/** Where the workspace's panels go this frame. */
struct CApp::sLayout
{
	bool m_bCompact = false;
	ImVec2 m_Display;
};

CApp::CApp(aevk::Engine& engine, sAppHost host)
	: m_Engine(engine)
	, m_Host(std::move(host))
	, m_fScale(std::max(0.5f, m_Host.m_fScale))
{
}

CApp::~CApp()
{
	/** Frames go before the session and the engine they came from. */
	m_pFrame.reset();
	m_pSession.reset();
	if (m_pContext)
	{
		m_Renderer.Shutdown();
		ImGui::DestroyContext(m_pContext);
	}
}

bool CApp::Init(std::string& error)
{
	IMGUI_CHECKVERSION();
	m_pContext = ImGui::CreateContext();
	ImGuiIO& io = ImGui::GetIO();
	/** Settings are the app's own (the recent list); Dear ImGui keeps no layout file. */
	io.IniFilename = nullptr;
	io.LogFilename = nullptr;
	io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
	if (m_Host.m_bTouch)
	{
		io.ConfigFlags |= ImGuiConfigFlags_IsTouchScreen;
	}
	io.ConfigWindowsMoveFromTitleBarOnly = true;
	io.BackendFlags |= ImGuiBackendFlags_RendererHasVtxOffset;
	io.BackendRendererName = "aevk";
	m_Recent.Load(m_Host.m_SettingsFolder);
	if (!LoadFonts(error))
	{
		return false;
	}
	ApplyStyle();
	if (!m_Renderer.Init(m_Engine, error))
	{
		return false;
	}
	m_fAppliedScale = m_fScale;
	m_bInit = true;
	return true;
}

bool CApp::LoadFonts(std::string& error)
{
	ImGuiIO& io = ImGui::GetIO();
	io.Fonts->Clear();
	ImFontConfig config;
	/** The font is the app's static data: the atlas must not free it. */
	config.FontDataOwnedByAtlas = false;
	config.OversampleH = 2;
	config.OversampleV = 1;
	config.PixelSnapH = true;
	const f32 size = std::round((m_Host.m_bTouch ? kTouchFontSize : kFontSize) * m_fScale);
	static const ImWchar s_Ranges[] = { 0x0020, 0x024F, 0x2010, 0x205E, 0x2190, 0x21FF, 0x25A0, 0x25FF, 0 };
	if (!io.Fonts->AddFontFromMemoryTTF(const_cast<unsigned char*>(g_UiFont), s32(g_UiFontSize), size, &config, s_Ranges))
	{
		error = "the interface font could not be loaded";
		return false;
	}
	return true;
}

void CApp::ApplyStyle()
{
	ImGuiStyle& style = ImGui::GetStyle();
	style = ImGuiStyle();
	ImGui::StyleColorsDark(&style);
	style.WindowRounding = 0;
	style.ChildRounding = 4;
	style.FrameRounding = 4;
	style.PopupRounding = 4;
	style.GrabRounding = 4;
	style.TabRounding = 4;
	style.ScrollbarRounding = 6;
	style.WindowBorderSize = 0;
	style.ChildBorderSize = 1;
	style.FramePadding = ImVec2(8, 5);
	style.ItemSpacing = ImVec2(8, 6);
	style.WindowPadding = ImVec2(8, 8);
	style.ScrollbarSize = 12;
	style.GrabMinSize = 12;
	ImVec4* c = style.Colors;
	c[ImGuiCol_WindowBg] = ImVec4(0.11f, 0.11f, 0.11f, 1);
	c[ImGuiCol_ChildBg] = ImVec4(0.135f, 0.135f, 0.135f, 1);
	c[ImGuiCol_PopupBg] = ImVec4(0.16f, 0.16f, 0.16f, 0.98f);
	c[ImGuiCol_Border] = ImVec4(0.22f, 0.22f, 0.22f, 1);
	c[ImGuiCol_MenuBarBg] = ImVec4(0.14f, 0.14f, 0.14f, 1);
	c[ImGuiCol_FrameBg] = ImVec4(0.19f, 0.19f, 0.19f, 1);
	c[ImGuiCol_FrameBgHovered] = ImVec4(0.24f, 0.24f, 0.24f, 1);
	c[ImGuiCol_FrameBgActive] = ImVec4(0.27f, 0.27f, 0.27f, 1);
	c[ImGuiCol_Button] = ImVec4(0.21f, 0.21f, 0.21f, 1);
	c[ImGuiCol_ButtonHovered] = ImVec4(0.27f, 0.27f, 0.27f, 1);
	c[ImGuiCol_ButtonActive] = ImVec4(0.18f, 0.55f, 0.92f, 1);
	c[ImGuiCol_Header] = ImVec4(0.18f, 0.55f, 0.92f, 0.45f);
	c[ImGuiCol_HeaderHovered] = ImVec4(0.18f, 0.55f, 0.92f, 0.30f);
	c[ImGuiCol_HeaderActive] = ImVec4(0.18f, 0.55f, 0.92f, 0.60f);
	c[ImGuiCol_Tab] = ImVec4(0.16f, 0.16f, 0.16f, 1);
	c[ImGuiCol_TabHovered] = ImVec4(0.18f, 0.55f, 0.92f, 0.5f);
	c[ImGuiCol_TabSelected] = ImVec4(0.21f, 0.21f, 0.21f, 1);
	c[ImGuiCol_TabSelectedOverline] = ImVec4(0.18f, 0.55f, 0.92f, 1);
	c[ImGuiCol_TitleBg] = c[ImGuiCol_TitleBgActive] = ImVec4(0.14f, 0.14f, 0.14f, 1);
	c[ImGuiCol_CheckMark] = c[ImGuiCol_SliderGrab] = ImVec4(0.18f, 0.55f, 0.92f, 1);
	c[ImGuiCol_SeparatorHovered] = c[ImGuiCol_SeparatorActive] = ImVec4(0.18f, 0.55f, 0.92f, 1);
	/** Touch screens get larger targets: fingers are wider than pointers. */
	const f32 sizes = m_fScale * (m_Host.m_bTouch ? 1.4f : 1.0f);
	style.ScaleAllSizes(sizes);
	if (m_Host.m_bTouch)
	{
		style.TouchExtraPadding = ImVec2(4 * m_fScale, 4 * m_fScale);
		style.ScrollbarSize = 6 * m_fScale;
	}
}

void CApp::SetScale(f32 scale)
{
	m_fScale = std::max(0.5f, scale);
}

void CApp::SetSafeArea(f32 left, f32 top, f32 right, f32 bottom)
{
	m_SafeArea = ImVec4(std::max(0.0f, left), std::max(0.0f, top), std::max(0.0f, right), std::max(0.0f, bottom));
}

void CApp::TouchScroll()
{
	ImGuiContext& g = *m_pContext;
	if (!ImGui::IsMouseDown(ImGuiMouseButton_Left))
	{
		m_uTouchScrollWindow = 0;
		return;
	}
	ImGuiWindow* window = nullptr;
	if (m_uTouchScrollWindow)
	{
		window = ImGui::FindWindowByID(m_uTouchScrollWindow);
	}
	else
	{
		/** A drag that has gone mostly up or down, from a window (or one it sits in) that scrolls. */
		const ImVec2 drag = ImGui::GetMouseDragDelta(ImGuiMouseButton_Left, 10 * m_fScale);
		if (drag.y == 0 || std::fabs(drag.y) < std::fabs(drag.x) * 1.5f)
		{
			return;
		}
		for (window = g.HoveredWindow; window && window->ScrollMax.y <= 0; window = window->ParentWindow)
		{
			if (!(window->Flags & ImGuiWindowFlags_ChildWindow))
			{
				window = nullptr;
				break;
			}
		}
		if (!window || window->ScrollMax.y <= 0)
		{
			return;
		}
		/** The press becomes a scroll, so the row under the finger does not take it as a tap. */
		m_uTouchScrollWindow = window->ID;
		ImGui::ClearActiveID();
	}
	if (window)
	{
		ImGui::SetScrollY(window, std::clamp(window->Scroll.y - ImGui::GetIO().MouseDelta.y, 0.0f, window->ScrollMax.y));
	}
}

bool CApp::OpenFile(const std::string& path)
{
	std::string error;
	std::vector<u8> bytes = ReadFile(path, error);
	if (bytes.empty())
	{
		Notify(FileName(path) + " could not be opened: " + error);
		m_Recent.Remove(path);
		return false;
	}
	m_Engine.addMediaFolder(FolderOf(path));
	if (!StartSession(FileName(path), path, std::move(bytes)))
	{
		return false;
	}
	m_Recent.Add(path);
	return true;
}

bool CApp::OpenBytes(const std::string& name, std::vector<u8> bytes, const std::string& mediaFolder)
{
	if (!mediaFolder.empty())
	{
		m_Engine.addMediaFolder(mediaFolder);
	}
	return StartSession(name, "", std::move(bytes));
}

bool CApp::StartSession(const std::string& name, const std::string& path, std::vector<u8> bytes)
{
	std::string error;
	/** Half a gigabyte of rendered frames on desktop, a quarter on a phone (the RAM preview cache). */
	const size_t cache = size_t(m_Host.m_bTouch ? 256 : 512) << 20;
#if AEP_EXPRESSIONS
	std::vector<u8> copy = bytes;
	std::unique_ptr<CPlaybackSession> session = CPlaybackSession::Create(m_Engine, std::move(bytes), true, cache, error);
	if (!session)
	{
		/** A project whose expressions cannot start still plays, with its pre-expression values. */
		const std::string expressionError = error;
		session = CPlaybackSession::Create(m_Engine, std::move(copy), false, cache, error);
		if (session)
		{
			Notify("Expressions are off for this project: " + expressionError);
		}
	}
#else
	std::unique_ptr<CPlaybackSession> session = CPlaybackSession::Create(m_Engine, std::move(bytes), false, cache, error);
#endif
	if (!session)
	{
		Notify(name + " could not be opened: " + error);
		return false;
	}
	CloseProject();
	session->SetPresenting(false);
	m_pSession = std::move(session);
	m_ProjectName = name;
	m_ProjectPath = path;
	if (m_pSession->Comps().empty())
	{
		Notify(name + " has no compositions to play");
	}
	SelectComp(m_pSession->DefaultComp());
	return true;
}

void CApp::CloseProject()
{
	m_pFrame.reset();
	m_pSession.reset();
	m_ProjectName.clear();
	m_ProjectPath.clear();
	m_uSelectedLayer = 0;
	m_iFrameShown = -1;
	m_fZoom = 0;
	m_Pan = ImVec2(0, 0);
}

void CApp::AddMediaFolder(const std::string& folder)
{
	m_Engine.addMediaFolder(folder);
	if (m_pSession)
	{
		m_pSession->ForgetFrames();
	}
}

void CApp::Notify(const std::string& message)
{
	m_Toasts.push_back({ message, m_fNow + 5 });
}

void CApp::SelectComp(u32 id)
{
	if (!m_pSession || !id || !m_pSession->SelectComp(id))
	{
		return;
	}
	m_pFrame.reset();
	m_iFrameShown = -1;
	m_uSelectedLayer = 0;
	m_fZoom = 0;
	m_Pan = ImVec2(0, 0);
	m_LastError.clear();
}

void CApp::SetPlaying(bool playing)
{
	if (m_pSession && m_pSession->Comp() && m_pSession->Playing() != playing)
	{
		m_pSession->SetPlaying(playing, m_fNow);
	}
}

void CApp::TogglePlay()
{
	if (m_pSession && m_pSession->Comp())
	{
		m_pSession->SetPlaying(!m_pSession->Playing(), m_fNow);
	}
}

void CApp::Step(s32 frames)
{
	if (m_pSession && m_pSession->Comp())
	{
		if (m_pSession->Playing())
		{
			m_pSession->SetPlaying(false, m_fNow);
		}
		m_pSession->Step(frames, m_fNow);
	}
}

void CApp::SeekTime(f64 time)
{
	if (m_pSession && m_pSession->Comp())
	{
		m_pSession->Seek(time, m_fNow);
	}
}

std::string CApp::Timecode(f64 time) const
{
	const f64 rate = m_pSession && m_pSession->Comp() ? m_pSession->Comp()->m_fFrameRate : 24;
	const s64 fps = std::max<s64>(1, s64(std::lround(rate)));
	const s64 frames = s64(std::floor(time * rate + 1e-6));
	const s64 seconds = frames / fps;
	char text[64];
	std::snprintf(text, sizeof(text), "%d:%02d:%02d:%02d", s32(seconds / 3600), s32(seconds / 60 % 60), s32(seconds % 60), s32(frames % fps));
	return text;
}

void CApp::SaveFrame()
{
	if (!m_pFrame || !m_pSession || !m_pSession->Comp())
	{
		Notify("There is no frame to save yet");
		return;
	}
	std::vector<u8> rgba;
	std::string error;
	if (!m_Engine.readPixels(*m_pFrame, rgba, error))
	{
		Notify("The frame could not be read: " + error);
		return;
	}
	const u32 width = m_pFrame->width() - 2 * u32(aevk::kPad);
	const u32 height = m_pFrame->height() - 2 * u32(aevk::kPad);
	const std::vector<u8> png = EncodePng(rgba.data(), width, height);
	char name[256];
	std::snprintf(name, sizeof(name), "%s_%05lld.png", m_pSession->Comp()->m_Name.c_str(), (long long)m_pSession->Frame());
	std::string file = name;
	for (char& c : file)
	{
		if (c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|')
		{
			c = '_';
		}
	}
	bool saved = false;
	std::string where;
	if (m_Host.m_SaveFile)
	{
		saved = m_Host.m_SaveFile(file, png, error);
		where = file;
	}
	else
	{
		const std::string folder = m_ProjectPath.empty() ? HomeFolder() : FolderOf(m_ProjectPath);
		where = folder + "/" + file;
		saved = WriteFile(where, png, error);
	}
	Notify(saved ? "Saved " + where : "The frame could not be saved: " + error);
}

void CApp::Pinch(f32 factor, f32 x, f32 y)
{
	(void)x;
	(void)y;
	if (!m_pSession || !m_pSession->Comp() || factor <= 0)
	{
		return;
	}
	/** From Fit, a pinch starts at the zoom Fit showed. */
	const f32 current = m_fZoom > 0 ? m_fZoom : 1;
	m_fZoom = std::clamp(current * factor, 0.05f, 16.0f);
}

bool CApp::Back()
{
	if (m_bShowAbout)
	{
		m_bShowAbout = false;
		return true;
	}
	if (m_bShowBrowser)
	{
		m_bShowBrowser = false;
		return true;
	}
	if (m_pSession)
	{
		if (m_pSession->Playing())
		{
			m_pSession->SetPlaying(false, m_fNow);
		}
		CloseProject();
		return true;
	}
	return false;
}

bool CApp::Busy() const
{
	if (!m_bInit)
	{
		return false;
	}
	if (m_pSession && (m_pSession->Playing() || m_pSession->Frame() != m_iFrameShown))
	{
		return true;
	}
	if (!m_Toasts.empty() || m_bScrubbing)
	{
		return true;
	}
	const ImGuiContext& g = *m_pContext;
	/** Input still queued, a button held, or a widget animating (Dear ImGui asks for a few frames after input). */
	return g.InputEventsQueue.Size > 0 || ImGui::IsAnyMouseDown() || g.IO.MouseWheel != 0;
}

bool CApp::Frame(f64 now, s32 width, s32 height)
{
	ImGui::SetCurrentContext(m_pContext);
	ImGuiIO& io = ImGui::GetIO();
	const f64 delta = m_fNow > 0 ? now - m_fNow : 1.0 / 60;
	m_fNow = now;
	io.DeltaTime = f32(std::max(1e-4, delta));
	io.DisplaySize = ImVec2(f32(std::max(1, width)), f32(std::max(1, height)));

	if (m_fScale != m_fAppliedScale)
	{
		std::string error;
		if (LoadFonts(error) && m_Renderer.RebuildFonts(error))
		{
			ApplyStyle();
		}
		m_fAppliedScale = m_fScale;
	}

	if (m_pSession && m_pSession->Comp())
	{
		std::string error;
		const f64 budgetMs = 0.5 * 1000.0 / std::max(1.0, m_pSession->Comp()->m_fFrameRate);
		if (m_pSession->Tick(now, budgetMs, error))
		{
			m_pFrame = m_pSession->CurrentFrame();
			m_iFrameShown = m_pSession->Frame();
			if (m_pSession->Playing())
			{
				if (m_fLastFrameShown > 0)
				{
					const f64 instant = 1.0 / std::max(1e-6, now - m_fLastFrameShown);
					m_fFps = m_fFps > 0 ? m_fFps + (instant - m_fFps) * 0.1 : instant;
				}
				m_fLastFrameShown = now;
			}
		}
		if (!m_pSession->Playing())
		{
			m_fLastFrameShown = 0;
		}
		if (!error.empty() && error != m_LastError && m_pSession->CurrentUnsupported().empty())
		{
			Notify(error);
		}
		m_LastError = error;
	}

	ImGui::NewFrame();
	if (m_Host.m_bTouch)
	{
		TouchScroll();
	}

	const bool typing = io.WantTextInput;
	if (!typing && m_pSession && m_pSession->Comp())
	{
		if (ImGui::IsKeyPressed(ImGuiKey_Space, false))
		{
			TogglePlay();
		}
		if (ImGui::IsKeyPressed(ImGuiKey_LeftArrow) || ImGui::IsKeyPressed(ImGuiKey_PageUp))
		{
			Step(-1);
		}
		if (ImGui::IsKeyPressed(ImGuiKey_RightArrow) || ImGui::IsKeyPressed(ImGuiKey_PageDown))
		{
			Step(1);
		}
		if (ImGui::IsKeyPressed(ImGuiKey_Home, false))
		{
			SeekTime(0);
		}
		if (ImGui::IsKeyPressed(ImGuiKey_End, false))
		{
			SeekTime(m_pSession->Comp()->m_fDuration);
		}
	}
	if (!typing && ImGui::IsKeyChordPressed(ImGuiMod_Ctrl | ImGuiKey_O))
	{
		if (m_Host.m_ChooseProject)
		{
			m_Host.m_ChooseProject();
		}
		else
		{
			m_bShowBrowser = true;
		}
	}
	if (!typing && ImGui::IsKeyChordPressed(ImGuiMod_Ctrl | ImGuiKey_Q))
	{
		m_bQuit = true;
	}

	sLayout layout;
	layout.m_Display = ImVec2(std::max(1.0f, io.DisplaySize.x - m_SafeArea.x - m_SafeArea.z), std::max(1.0f, io.DisplaySize.y - m_SafeArea.y - m_SafeArea.w));
	layout.m_bCompact = layout.m_Display.x < kCompactWidth * m_fScale || (m_Host.m_bTouch && layout.m_Display.y > layout.m_Display.x);

	ImGui::SetNextWindowPos(ImVec2(m_SafeArea.x, m_SafeArea.y));
	ImGui::SetNextWindowSize(layout.m_Display);
	ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0, 0));
	const ImGuiWindowFlags root = ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoBringToFrontOnFocus |
		ImGuiWindowFlags_NoSavedSettings | ImGuiWindowFlags_NoScrollWithMouse | (layout.m_bCompact ? 0 : ImGuiWindowFlags_MenuBar);
	ImGui::Begin("##root", nullptr, root);
	ImGui::PopStyleVar();
	if (m_pSession)
	{
		DrawWorkspace(layout);
	}
	else
	{
		if (!layout.m_bCompact)
		{
			DrawMenuBar();
		}
		DrawHome();
	}
	ImGui::End();

	DrawBrowser();
	DrawAbout();
	DrawToasts(ImVec2(io.DisplaySize.x, io.DisplaySize.y - m_SafeArea.w));

	ImGui::Render();
	std::string error;
	if (!m_Renderer.Present(*ImGui::GetDrawData(), m_pFrame.get(), kBackground, error) && error != m_LastError)
	{
		std::fprintf(stderr, "presenting failed: %s\n", error.c_str());
		m_LastError = error;
	}
	return !m_bQuit;
}

// --- panels ------------------------------------------------------------------------------------------------------

void CApp::DrawMenuBar()
{
	if (!ImGui::BeginMenuBar())
	{
		return;
	}
	if (ImGui::BeginMenu("File"))
	{
		if (ImGui::MenuItem("Open Project...", "Ctrl+O"))
		{
			if (m_Host.m_ChooseProject)
			{
				m_Host.m_ChooseProject();
			}
			else
			{
				m_bShowBrowser = true;
			}
		}
		if (ImGui::BeginMenu("Open Recent", !m_Recent.Paths().empty()))
		{
			for (const std::string& path : m_Recent.Paths())
			{
				if (ImGui::MenuItem(FileName(path).c_str()))
				{
					OpenFile(path);
					break;
				}
				ImGui::SetItemTooltip("%s", path.c_str());
			}
			ImGui::EndMenu();
		}
		if (ImGui::MenuItem("Close Project", nullptr, false, m_pSession != nullptr))
		{
			CloseProject();
		}
		ImGui::Separator();
		if (ImGui::MenuItem("Save Frame As PNG", nullptr, false, m_pFrame != nullptr))
		{
			SaveFrame();
		}
		ImGui::Separator();
		if (ImGui::MenuItem("Quit", "Ctrl+Q"))
		{
			m_bQuit = true;
		}
		ImGui::EndMenu();
	}
	if (ImGui::BeginMenu("View", m_pSession != nullptr))
	{
		static const char* const s_Resolutions[] = { "Full", "Half", "Third", "Quarter" };
		if (ImGui::BeginMenu("Resolution"))
		{
			for (s32 i = 0; i < 4; i++)
			{
				if (ImGui::MenuItem(s_Resolutions[i], nullptr, m_pSession && m_pSession->Resolution() == i + 1))
				{
					m_pSession->SetResolution(i + 1);
				}
			}
			ImGui::EndMenu();
		}
		if (ImGui::MenuItem("Fit in Viewer", nullptr, m_fZoom == 0))
		{
			m_fZoom = 0;
			m_Pan = ImVec2(0, 0);
		}
		if (ImGui::MenuItem("100%", nullptr, m_fZoom == 1))
		{
			m_fZoom = 1;
			m_Pan = ImVec2(0, 0);
		}
		ImGui::MenuItem("Transparency Grid", nullptr, &m_bTransparencyGrid);
		ImGui::EndMenu();
	}
	if (ImGui::BeginMenu("Help"))
	{
		if (ImGui::MenuItem("About"))
		{
			m_bShowAbout = true;
		}
		ImGui::EndMenu();
	}
	ImGui::EndMenuBar();
}

void CApp::DrawHome()
{
	const ImVec2 avail = ImGui::GetContentRegionAvail();
	const f32 s = m_fScale;
	const f32 width = std::min(avail.x - 32 * s, 560 * s);
	ImGui::SetCursorPos(ImVec2((ImGui::GetWindowWidth() - width) * 0.5f, ImGui::GetCursorPosY() + std::max(24 * s, avail.y * 0.08f)));
	ImGui::BeginGroup();
	ImGui::PushTextWrapPos(ImGui::GetCursorPosX() + width);
	ImGui::SetWindowFontScale(1.6f);
	ImGui::TextUnformatted("Open an After Effects project");
	ImGui::SetWindowFontScale(1.0f);
	ImGui::PushStyleColor(ImGuiCol_Text, kTextDim);
	ImGui::TextUnformatted(m_Host.m_bTouch
			? "Choose an .aep file from your files. Its comps play on this phone's GPU with Vulkan."
			: "Choose an .aep file. Its comps play on this computer's GPU with Vulkan; footage and sounds are found in the project's folder.");
	ImGui::PopStyleColor();
	ImGui::PopTextWrapPos();
	ImGui::Dummy(ImVec2(0, 8 * s));

	/** The big target: a dashed card with a folder icon, as the web app's home screen has. */
	const f32 cardHeight = 150 * s * (m_Host.m_bTouch ? 1.2f : 1.0f);
	const ImVec2 p0 = ImGui::GetCursorScreenPos();
	if (ImGui::InvisibleButton("##choose", ImVec2(width, cardHeight)))
	{
		if (m_Host.m_ChooseProject)
		{
			m_Host.m_ChooseProject();
		}
		else
		{
			m_bShowBrowser = true;
		}
	}
	const bool hovered = ImGui::IsItemHovered();
	const bool held = ImGui::IsItemActive();
	ImDrawList* draw = ImGui::GetWindowDrawList();
	const ImVec2 p1 = Add(p0, ImVec2(width, cardHeight));
	draw->AddRectFilled(p0, p1, held ? IM_COL32(45, 140, 235, 60) : hovered ? IM_COL32(255, 255, 255, 14) : IM_COL32(255, 255, 255, 6), 8 * s);
	draw->AddRect(p0, p1, hovered ? kAccent : IM_COL32(90, 90, 90, 255), 8 * s, 0, 1.5f * s);
	const f32 icon = 40 * s;
	const ImVec2 iconAt(p0.x + width * 0.5f - icon * 0.5f, p0.y + cardHeight * 0.22f);
	const ImVec2 save = ImGui::GetCursorScreenPos();
	ImGui::SetCursorScreenPos(iconAt);
	IconButton("##homeicon", ICON_FOLDER, icon, nullptr, hovered);
	ImGui::SetCursorScreenPos(save);
	const char* title = "Choose a project";
	const char* sub = m_Host.m_bTouch ? "Tap to browse your files" : "Click to browse, or press Ctrl+O";
	const ImVec2 titleSize = ImGui::CalcTextSize(title);
	const ImVec2 subSize = ImGui::CalcTextSize(sub);
	draw->AddText(ImVec2(p0.x + (width - titleSize.x) * 0.5f, iconAt.y + icon + 10 * s), IM_COL32(235, 235, 235, 255), title);
	draw->AddText(ImVec2(p0.x + (width - subSize.x) * 0.5f, iconAt.y + icon + 14 * s + titleSize.y), kTextDim, sub);

	if (!m_Recent.Paths().empty())
	{
		ImGui::Dummy(ImVec2(0, 10 * s));
		ImGui::SeparatorText("Recent projects");
		std::string open;
		for (const std::string& path : m_Recent.Paths())
		{
			ImGui::PushID(path.c_str());
			const std::string label = FileName(path);
			if (ImGui::Selectable("##recent", false, 0, ImVec2(width, ImGui::GetTextLineHeight() * 2 + 4 * s)))
			{
				open = path;
			}
			const ImVec2 min = ImGui::GetItemRectMin();
			draw->AddText(Add(min, ImVec2(6 * s, 2 * s)), IM_COL32(230, 230, 230, 255), label.c_str());
			draw->AddText(Add(min, ImVec2(6 * s, 2 * s + ImGui::GetTextLineHeight())), kTextDim, FolderOf(path).c_str());
			ImGui::PopID();
		}
		if (!open.empty())
		{
			OpenFile(open);
		}
	}
	ImGui::EndGroup();
}

void CApp::DrawWorkspace(const sLayout& layout)
{
	const f32 s = m_fScale;
	ImGuiStyle& style = ImGui::GetStyle();
	if (layout.m_bCompact)
	{
		/** One column: a top bar, the viewer, playback controls, then tabs for the rest. */
		ImGui::SetCursorPos(ImVec2(style.ItemSpacing.x, style.ItemSpacing.y));
		const f32 bar = ImGui::GetFrameHeight() * 1.25f;
		if (IconButton("##menu", ICON_MENU, bar, "Menu"))
		{
			ImGui::OpenPopup("##compactmenu");
		}
		if (ImGui::BeginPopup("##compactmenu"))
		{
			if (ImGui::MenuItem("Open project"))
			{
				if (m_Host.m_ChooseProject)
				{
					m_Host.m_ChooseProject();
				}
				else
				{
					m_bShowBrowser = true;
				}
			}
			if (ImGui::MenuItem("Close project"))
			{
				CloseProject();
				ImGui::EndPopup();
				return;
			}
			ImGui::Separator();
			if (ImGui::MenuItem("Save frame as PNG", nullptr, false, m_pFrame != nullptr))
			{
				SaveFrame();
			}
			ImGui::MenuItem("Transparency grid", nullptr, &m_bTransparencyGrid);
			if (ImGui::MenuItem("Fit in viewer", nullptr, m_fZoom == 0))
			{
				m_fZoom = 0;
				m_Pan = ImVec2(0, 0);
			}
			ImGui::Separator();
			if (ImGui::MenuItem("About"))
			{
				m_bShowAbout = true;
			}
			ImGui::EndPopup();
		}
		ImGui::SameLine();
		ImGui::SetNextItemWidth(ImGui::GetContentRegionAvail().x - style.ItemSpacing.x);
		const sCompInfo* comp = m_pSession->Comp();
		ImGui::PushStyleVar(ImGuiStyleVar_FramePadding, ImVec2(style.FramePadding.x, (bar - ImGui::GetTextLineHeight()) * 0.5f));
		if (ImGui::BeginCombo("##comp", comp ? comp->m_Name.c_str() : "No comp"))
		{
			for (const sCompInfo& info : m_pSession->Comps())
			{
				if (ImGui::Selectable(info.m_Name.c_str(), comp && comp->m_uId == info.m_uId))
				{
					SelectComp(info.m_uId);
				}
			}
			ImGui::EndCombo();
		}
		ImGui::PopStyleVar();

		const f32 width = layout.m_Display.x;
		const f32 aspect = comp && comp->m_fWidth > 0 ? f32(comp->m_fHeight / comp->m_fWidth) : 9.0f / 16;
		const f32 viewerHeight = std::clamp(width * aspect, 140 * s, layout.m_Display.y * 0.42f);
		ImGui::SetCursorPosX(0);
		DrawViewer(ImVec2(width, viewerHeight));
		ImGui::SetCursorPosX(style.ItemSpacing.x);
		DrawTransport(true);

		ImGui::SetCursorPosX(style.ItemSpacing.x);
		ImGui::BeginChild("##tabs", ImVec2(width - 2 * style.ItemSpacing.x, 0), 0, ImGuiWindowFlags_NoScrollbar);
		if (ImGui::BeginTabBar("##compacttabs", ImGuiTabBarFlags_FittingPolicyResizeDown))
		{
			if (ImGui::BeginTabItem("Layers"))
			{
				DrawTimeline(ImGui::GetContentRegionAvail());
				ImGui::EndTabItem();
			}
			if (ImGui::BeginTabItem("Details"))
			{
				ImGui::BeginChild("##details");
				DrawLayerDetails();
				ImGui::EndChild();
				ImGui::EndTabItem();
			}
			if (ImGui::BeginTabItem("Project"))
			{
				ImGui::BeginChild("##project");
				DrawProjectPanel();
				ImGui::EndChild();
				ImGui::EndTabItem();
			}
			if (ImGui::BeginTabItem("Info"))
			{
				ImGui::BeginChild("##info");
				DrawInfo();
				ImGui::EndChild();
				ImGui::EndTabItem();
			}
			ImGui::EndTabBar();
		}
		ImGui::EndChild();
		return;
	}

	DrawMenuBar();
	const ImVec2 origin = ImGui::GetCursorScreenPos();
	const f32 statusHeight = ImGui::GetFrameHeight();
	const f32 transportHeight = ImGui::GetFrameHeight() * 1.6f + style.ItemSpacing.y;
	const f32 splitter = 5 * s;
	const f32 total = layout.m_Display.y - (origin.y - ImGui::GetWindowPos().y) - statusHeight;
	m_fTimelineHeight = std::clamp(m_fTimelineHeight, 80 * s, std::max(80 * s, total - transportHeight - 200 * s));
	m_fProjectWidth = std::clamp(m_fProjectWidth, 140 * s, layout.m_Display.x * 0.3f);
	m_fDetailsWidth = std::clamp(m_fDetailsWidth, 180 * s, layout.m_Display.x * 0.35f);
	const f32 topHeight = std::max(120 * s, total - m_fTimelineHeight - transportHeight - splitter);
	const f32 viewerWidth = std::max(160 * s, layout.m_Display.x - m_fProjectWidth - m_fDetailsWidth - 2 * splitter);

	/** A vertical or horizontal bar between panels that resizes them. */
	const auto split = [&](const char* id, ImVec2 size, f32& value, f32 direction, bool vertical) {
		ImGui::InvisibleButton(id, size);
		const bool active = ImGui::IsItemActive();
		if (active || ImGui::IsItemHovered())
		{
			ImGui::SetMouseCursor(vertical ? ImGuiMouseCursor_ResizeEW : ImGuiMouseCursor_ResizeNS);
			const ImVec2 min = ImGui::GetItemRectMin();
			const ImVec2 max = ImGui::GetItemRectMax();
			ImGui::GetWindowDrawList()->AddRectFilled(min, max, active ? kAccent : kAccentDim);
		}
		if (active)
		{
			value += (vertical ? ImGui::GetIO().MouseDelta.x : ImGui::GetIO().MouseDelta.y) * direction;
		}
	};

	ImGui::BeginChild("##projectpanel", ImVec2(m_fProjectWidth, topHeight), ImGuiChildFlags_Borders);
	DrawProjectPanel();
	ImGui::EndChild();
	ImGui::SameLine(0, 0);
	split("##splitproject", ImVec2(splitter, topHeight), m_fProjectWidth, 1, true);
	ImGui::SameLine(0, 0);
	DrawViewer(ImVec2(viewerWidth, topHeight));
	ImGui::SameLine(0, 0);
	split("##splitdetails", ImVec2(splitter, topHeight), m_fDetailsWidth, -1, true);
	ImGui::SameLine(0, 0);
	ImGui::BeginChild("##detailspanel", ImVec2(0, topHeight), ImGuiChildFlags_Borders);
	if (ImGui::BeginTabBar("##detailtabs"))
	{
		if (ImGui::BeginTabItem("Layer"))
		{
			ImGui::BeginChild("##layerdetails");
			DrawLayerDetails();
			ImGui::EndChild();
			ImGui::EndTabItem();
		}
		if (ImGui::BeginTabItem("Info"))
		{
			ImGui::BeginChild("##infodetails");
			DrawInfo();
			ImGui::EndChild();
			ImGui::EndTabItem();
		}
		ImGui::EndTabBar();
	}
	ImGui::EndChild();

	split("##splittimeline", ImVec2(layout.m_Display.x, splitter), m_fTimelineHeight, -1, false);
	ImGui::SetCursorPosX(style.ItemSpacing.x);
	DrawTransport(false);
	ImGui::SetCursorPosX(0);
	DrawTimeline(ImVec2(layout.m_Display.x, m_fTimelineHeight));
	DrawStatusBar();
}

void CApp::DrawProjectPanel()
{
	const CProject& project = m_pSession->Project();
	const sCompInfo* current = m_pSession->Comp();
	const f32 s = m_fScale;
	ImGui::SeparatorText("Compositions");
	for (const sCompInfo& info : m_pSession->Comps())
	{
		ImGui::PushID(s32(info.m_uId));
		const bool selected = current && current->m_uId == info.m_uId;
		const f32 rowHeight = ImGui::GetTextLineHeight() * 2 + 4 * s;
		if (ImGui::Selectable("##comp", selected, 0, ImVec2(0, rowHeight)))
		{
			SelectComp(info.m_uId);
		}
		const ImVec2 min = ImGui::GetItemRectMin();
		ImDrawList* draw = ImGui::GetWindowDrawList();
		const f32 dot = 4 * s;
		draw->AddCircleFilled(ImVec2(min.x + 6 * s + dot, min.y + rowHeight * 0.5f), dot,
			info.m_bPlayable ? IM_COL32(90, 200, 120, 255) : IM_COL32(220, 160, 60, 255));
		char detail[128];
		std::snprintf(detail, sizeof(detail), "%.0f x %.0f  %.2f fps  %.2f s", info.m_fWidth, info.m_fHeight, info.m_fFrameRate, info.m_fDuration);
		draw->AddText(ImVec2(min.x + 12 * s + 2 * dot, min.y + 2 * s), IM_COL32(230, 230, 230, 255), info.m_Name.c_str());
		draw->AddText(ImVec2(min.x + 12 * s + 2 * dot, min.y + 2 * s + ImGui::GetTextLineHeight()), kTextDim, detail);
		ImGui::SetItemTooltip("%s", info.m_bPlayable ? "Plays natively" : "Its first frame has something this app cannot draw yet");
		ImGui::PopID();
	}

	ImGui::Dummy(ImVec2(0, 4 * s));
	if (ImGui::CollapsingHeader("Footage"))
	{
		if (m_Host.m_ChooseFootageFolder)
		{
			if (ImGui::Button("Choose footage folder", ImVec2(-FLT_MIN, 0)))
			{
				m_Host.m_ChooseFootageFolder();
			}
			ImGui::SetItemTooltip("The folder this project's images, videos and sounds are in");
		}
		for (const auto& entry : project.m_Items)
		{
			const CItem& item = *entry.second;
			if (item.m_eKind != ITEM_FOOTAGE)
			{
				continue;
			}
			ImGui::PushID(s32(item.m_uId));
			if (item.m_eSource == SOURCE_SOLID)
			{
				const ImVec4 color(f32(item.m_SolidColor[0]), f32(item.m_SolidColor[1]), f32(item.m_SolidColor[2]), 1);
				ImGui::ColorButton("##solid", color, ImGuiColorEditFlags_NoTooltip, ImVec2(ImGui::GetTextLineHeight(), ImGui::GetTextLineHeight()));
				ImGui::SameLine();
			}
			ImGui::TextUnformatted(item.m_Name.c_str());
			if (!item.m_File.empty())
			{
				ImGui::SetItemTooltip("%s", item.m_File.c_str());
			}
			ImGui::SameLine();
			ImGui::PushStyleColor(ImGuiCol_Text, kTextDim);
			if (item.m_fWidth > 0)
			{
				ImGui::Text("%.0f x %.0f%s", item.m_fWidth, item.m_fHeight, item.m_bHasAudio ? ", sound" : "");
			}
			else
			{
				ImGui::TextUnformatted(item.m_bHasAudio ? "sound" : "");
			}
			ImGui::PopStyleColor();
			ImGui::PopID();
		}
	}
}

void CApp::DrawViewer(const ImVec2& size)
{
	const f32 s = m_fScale;
	ImGui::PushStyleColor(ImGuiCol_ChildBg, IM_COL32(26, 26, 26, 255));
	ImGui::BeginChild("##viewer", size, ImGuiChildFlags_Borders, ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);
	ImGui::PopStyleColor();
	const sCompInfo* comp = m_pSession->Comp();
	if (!comp)
	{
		ImGui::TextDisabled("This project has no compositions.");
		ImGui::EndChild();
		return;
	}
	const ImVec2 origin = ImGui::GetCursorScreenPos();
	const ImVec2 area = ImGui::GetContentRegionAvail();
	const f32 margin = 12 * s;
	const f32 fit = std::max(0.01f, std::min((area.x - 2 * margin) / f32(comp->m_fWidth), (area.y - 2 * margin) / f32(comp->m_fHeight)));
	const f32 zoom = m_fZoom > 0 ? m_fZoom : fit;
	const ImVec2 shown(f32(comp->m_fWidth) * zoom, f32(comp->m_fHeight) * zoom);
	ImVec2 p0(std::floor(origin.x + (area.x - shown.x) * 0.5f + m_Pan.x), std::floor(origin.y + (area.y - shown.y) * 0.5f + m_Pan.y));
	ImVec2 p1 = Add(p0, shown);

	/** The whole panel takes the pointer: wheel zooms about it, dragging pans once zoomed. */
	ImGui::SetCursorScreenPos(origin);
	ImGui::InvisibleButton("##viewerinput", area, ImGuiButtonFlags_MouseButtonLeft | ImGuiButtonFlags_MouseButtonMiddle);
	ImGuiIO& io = ImGui::GetIO();
	if (ImGui::IsItemHovered() && io.MouseWheel != 0)
	{
		const f32 next = std::clamp(zoom * std::pow(1.15f, io.MouseWheel), 0.05f, 16.0f);
		/** Keep the comp point under the pointer where it is. */
		const ImVec2 center(origin.x + area.x * 0.5f, origin.y + area.y * 0.5f);
		const ImVec2 rel(io.MousePos.x - center.x - m_Pan.x, io.MousePos.y - center.y - m_Pan.y);
		m_Pan.x -= rel.x * (next / zoom - 1);
		m_Pan.y -= rel.y * (next / zoom - 1);
		m_fZoom = next;
	}
	if (ImGui::IsItemActive() && (m_fZoom > 0 || ImGui::IsMouseDragging(ImGuiMouseButton_Middle)))
	{
		m_Pan.x += io.MouseDelta.x;
		m_Pan.y += io.MouseDelta.y;
		if (m_fZoom == 0)
		{
			m_fZoom = fit;
		}
	}
	if (ImGui::IsItemHovered() && ImGui::IsMouseDoubleClicked(ImGuiMouseButton_Left))
	{
		m_fZoom = 0;
		m_Pan = ImVec2(0, 0);
	}

	ImDrawList* draw = ImGui::GetWindowDrawList();
	draw->PushClipRect(origin, Add(origin, area), true);
	if (m_bTransparencyGrid)
	{
		const f32 cell = 8 * s;
		draw->AddRectFilled(p0, p1, IM_COL32(204, 204, 204, 255));
		const ImVec2 c0(std::max(p0.x, origin.x), std::max(p0.y, origin.y));
		const ImVec2 c1(std::min(p1.x, origin.x + area.x), std::min(p1.y, origin.y + area.y));
		for (f32 y = p0.y + std::floor((c0.y - p0.y) / cell) * cell; y < c1.y; y += cell)
		{
			for (f32 x = p0.x + std::floor((c0.x - p0.x) / cell) * cell; x < c1.x; x += cell)
			{
				if ((s32(std::lround((x - p0.x) / cell)) + s32(std::lround((y - p0.y) / cell))) & 1)
				{
					draw->AddRectFilled(ImVec2(x, y), ImVec2(std::min(x + cell, p1.x), std::min(y + cell, p1.y)), IM_COL32(255, 255, 255, 255));
				}
			}
		}
	}
	else
	{
		float bg[3];
		m_pSession->Background(bg);
		draw->AddRectFilled(p0, p1, ImGui::ColorConvertFloat4ToU32(ImVec4(bg[0], bg[1], bg[2], 1)));
	}
	const std::vector<std::string>& unsupported = m_pSession->CurrentUnsupported();
	if (m_pFrame && unsupported.empty())
	{
		/** Each image pixel covers two or more screen pixels: show them sharp rather than blurred. */
		const f32 imagePixels = f32(m_pFrame->width() - 2 * u32(aevk::kPad));
		const bool nearest = shown.x / std::max(1.0f, imagePixels) >= 2;
		draw->AddImage(CUiRenderer::FrameTexture(nearest), p0, p1);
	}
	draw->AddRect(ImVec2(p0.x - 1, p0.y - 1), ImVec2(p1.x + 1, p1.y + 1), IM_COL32(0, 0, 0, 160));
	draw->PopClipRect();

	/** What the native engine cannot draw yet, over the viewer. */
	if (!unsupported.empty())
	{
		const f32 pad = 12 * s;
		const f32 wrap = std::min(area.x - 4 * pad, 520 * s);
		std::string text = "This frame has something the native engine cannot draw yet:";
		for (size_t i = 0; i < unsupported.size() && i < 4; i++)
		{
			text += "\n- " + unsupported[i];
		}
		if (unsupported.size() > 4)
		{
			text += "\n- and " + std::to_string(unsupported.size() - 4) + " more";
		}
		const ImVec2 textSize = ImGui::CalcTextSize(text.c_str(), nullptr, false, wrap);
		const ImVec2 box0(origin.x + (area.x - textSize.x) * 0.5f - pad, origin.y + (area.y - textSize.y) * 0.5f - pad);
		const ImVec2 box1(box0.x + textSize.x + 2 * pad, box0.y + textSize.y + 2 * pad);
		draw->AddRectFilled(box0, box1, IM_COL32(20, 20, 20, 230), 6 * s);
		draw->AddText(nullptr, 0, ImVec2(box0.x + pad, box0.y + pad), IM_COL32(235, 200, 120, 255), text.c_str(), nullptr, wrap);
	}

	/** Zoom and resolution, in the viewer's corner. */
	char label[64];
	std::snprintf(label, sizeof(label), "%.0f%%  %s", zoom * 100, m_pSession->Resolution() == 1 ? "Full" : m_pSession->Resolution() == 2 ? "Half"
			: m_pSession->Resolution() == 3 ? "Third" : "Quarter");
	const ImVec2 labelSize = ImGui::CalcTextSize(label);
	const ImVec2 at(origin.x + area.x - labelSize.x - 10 * s, origin.y + area.y - labelSize.y - 8 * s);
	draw->AddRectFilled(ImVec2(at.x - 6 * s, at.y - 3 * s), ImVec2(at.x + labelSize.x + 6 * s, at.y + labelSize.y + 3 * s), IM_COL32(0, 0, 0, 140), 4 * s);
	draw->AddText(at, IM_COL32(220, 220, 220, 255), label);
	ImGui::EndChild();
}

void CApp::DrawTransport(bool compact)
{
	const sCompInfo* comp = m_pSession->Comp();
	if (!comp)
	{
		return;
	}
	ImGuiStyle& style = ImGui::GetStyle();
	const f32 s = m_fScale;
	const f32 button = ImGui::GetFrameHeight() * (compact ? 1.5f : 1.25f);
	const bool playing = m_pSession->Playing();
	ImGui::BeginGroup();
	if (IconButton("##start", ICON_TO_START, button, "Go to start (Home)"))
	{
		SeekTime(0);
	}
	ImGui::SameLine();
	if (IconButton("##back", ICON_STEP_BACK, button, "Previous frame (Left)"))
	{
		Step(-1);
	}
	ImGui::SameLine();
	if (IconButton("##play", playing ? ICON_PAUSE : ICON_PLAY, button * (compact ? 1.2f : 1.0f), playing ? "Pause (Space)" : "Play (Space)", true))
	{
		TogglePlay();
	}
	ImGui::SameLine();
	if (IconButton("##forward", ICON_STEP_FORWARD, button, "Next frame (Right)"))
	{
		Step(1);
	}
	ImGui::SameLine();
	if (IconButton("##end", ICON_TO_END, button, "Go to end (End)"))
	{
		SeekTime(comp->m_fDuration);
	}
	ImGui::SameLine();
	const f32 textY = ImGui::GetCursorPosY() + (button - ImGui::GetTextLineHeight()) * 0.5f;
	ImGui::SetCursorPosY(textY);
	ImGui::Text("%s", Timecode(m_pSession->Time()).c_str());
	ImGui::SameLine();
	ImGui::SetCursorPosY(textY);
	ImGui::PushStyleColor(ImGuiCol_Text, kTextDim);
	ImGui::Text("frame %lld of %lld", (long long)m_pSession->Frame() + 1, (long long)m_pSession->FrameCount());
	ImGui::PopStyleColor();
	if (!compact)
	{
		ImGui::SameLine(0, 24 * s);
		ImGui::SetCursorPosY(ImGui::GetCursorPosY() + (button - ImGui::GetFrameHeight()) * 0.5f);
		static const char* const s_Resolutions[] = { "Full", "Half", "Third", "Quarter" };
		ImGui::SetNextItemWidth(ImGui::CalcTextSize("Quarter").x + ImGui::GetFrameHeight() + 2 * style.FramePadding.x);
		s32 resolution = m_pSession->Resolution() - 1;
		if (ImGui::Combo("##resolution", &resolution, s_Resolutions, 4))
		{
			m_pSession->SetResolution(resolution + 1);
		}
		ImGui::SetItemTooltip("Resolution: renders at full, half, third or quarter size");
		ImGui::SameLine();
		if (IconButton("##grid", ICON_GRID, ImGui::GetFrameHeight(), "Transparency grid", m_bTransparencyGrid))
		{
			m_bTransparencyGrid = !m_bTransparencyGrid;
		}
		if (playing && m_fFps > 0)
		{
			ImGui::SameLine(0, 24 * s);
			ImGui::SetCursorPosY(textY);
			ImGui::PushStyleColor(ImGuiCol_Text, m_fFps + 0.5 >= comp->m_fFrameRate ? IM_COL32(110, 200, 130, 255) : IM_COL32(230, 170, 70, 255));
			ImGui::Text("%.1f fps", m_fFps);
			ImGui::PopStyleColor();
		}
	}
	ImGui::EndGroup();

	if (compact)
	{
		/** A full-width scrub bar: phones have no Timeline ruler in reach of a thumb. */
		/** The knob's radius is kept clear at both ends, so it is whole at the start and the end. */
		const f32 knob = 10 * s;
		ImGui::SetCursorPosX(style.ItemSpacing.x + knob);
		const f32 width = ImGui::GetContentRegionAvail().x - style.ItemSpacing.x - knob;
		const f32 height = 28 * s;
		const ImVec2 p0 = ImGui::GetCursorScreenPos();
		ImGui::InvisibleButton("##scrub", ImVec2(width, height));
		const f64 duration = std::max(1e-6, comp->m_fDuration);
		if (ImGui::IsItemActive())
		{
			const f64 at = std::clamp(f64((ImGui::GetIO().MousePos.x - p0.x) / width), 0.0, 1.0) * duration;
			if (!m_bScrubbing)
			{
				m_bScrubbing = true;
				if (m_pSession->Playing())
				{
					m_pSession->SetPlaying(false, m_fNow);
				}
			}
			if (at != m_fScrubTime)
			{
				SeekTime(at);
				m_fScrubTime = at;
			}
		}
		else if (m_bScrubbing && !ImGui::IsAnyMouseDown())
		{
			m_bScrubbing = false;
			m_fScrubTime = -1;
		}
		ImDrawList* draw = ImGui::GetWindowDrawList();
		const f32 y = p0.y + height * 0.5f;
		const f32 x = p0.x + f32(m_pSession->Time() / duration) * width;
		draw->AddRectFilled(ImVec2(p0.x, y - 2 * s), ImVec2(p0.x + width, y + 2 * s), IM_COL32(70, 70, 70, 255), 2 * s);
		draw->AddRectFilled(ImVec2(p0.x, y - 2 * s), ImVec2(x, y + 2 * s), kAccent, 2 * s);
		draw->AddCircleFilled(ImVec2(x, y), ImGui::IsItemActive() ? knob : knob * 0.8f, IM_COL32(240, 240, 240, 255));
	}
}

void CApp::DrawTimeline(const ImVec2& size)
{
	const CItem* comp = m_pSession->CompItem();
	const sCompInfo* info = m_pSession->Comp();
	if (!comp || !info)
	{
		return;
	}
	const f32 s = m_fScale;
	const bool touch = m_Host.m_bTouch;
	ImGui::BeginChild("##timeline", size, ImGuiChildFlags_Borders, ImGuiWindowFlags_NoScrollbar | ImGuiWindowFlags_NoScrollWithMouse);
	const ImVec2 origin = ImGui::GetCursorScreenPos();
	const ImVec2 area = ImGui::GetContentRegionAvail();
	const f32 nameWidth = std::min(area.x * 0.42f, (touch ? 170 : 220) * s);
	const f32 rulerHeight = ImGui::GetTextLineHeight() + 10 * s;
	const f32 rowHeight = ImGui::GetTextLineHeight() + (touch ? 18 : 8) * s;
	const f32 barsX = origin.x + nameWidth;
	const f32 barsWidth = std::max(1.0f, area.x - nameWidth - 8 * s);
	const f64 duration = std::max(1e-6, info->m_fDuration);
	const auto timeToX = [&](f64 t) { return barsX + f32(std::clamp(t / duration, 0.0, 1.0)) * barsWidth; };
	ImDrawList* draw = ImGui::GetWindowDrawList();
	ImGuiIO& io = ImGui::GetIO();

	/** The ruler: second ticks, labelled as often as fits. */
	draw->AddRectFilled(origin, ImVec2(origin.x + area.x, origin.y + rulerHeight), IM_COL32(30, 30, 30, 255));
	draw->AddText(ImVec2(origin.x + 8 * s, origin.y + 5 * s), kTextDim, "Layer");
	const f32 labelWidth = ImGui::CalcTextSize("0:00:00:00").x + 16 * s;
	/** Whole frames below a second (so labels land on frames), whole seconds and minutes above. */
	const f64 frame = 1.0 / std::max(1.0, info->m_fFrameRate);
	const f64 fps = std::max(1.0, std::round(info->m_fFrameRate));
	const f64 steps[] = { frame, 2 * frame, 5 * frame, 10 * frame, std::round(fps / 2) * frame, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600 };
	f64 step = steps[sizeof(steps) / sizeof(steps[0]) - 1];
	for (const f64 candidate : steps)
	{
		if (candidate / duration * barsWidth >= labelWidth)
		{
			step = candidate;
			break;
		}
	}
	for (s64 tick = 0; f64(tick) * step <= duration + 1e-9; tick++)
	{
		const f64 t = f64(tick) * step;
		const f32 x = timeToX(t);
		draw->AddLine(ImVec2(x, origin.y + rulerHeight - 6 * s), ImVec2(x, origin.y + rulerHeight), IM_COL32(120, 120, 120, 255));
		if (x + labelWidth - 12 * s <= origin.x + area.x)
		{
			draw->AddText(ImVec2(x + 3 * s, origin.y + 3 * s), kTextDim, Timecode(t).c_str());
		}
	}

	/** Dragging in the ruler, or in the bars, moves the playhead. */
	ImGui::SetCursorScreenPos(ImVec2(barsX, origin.y));
	ImGui::InvisibleButton("##ruler", ImVec2(barsWidth + 8 * s, rulerHeight));
	bool scrub = ImGui::IsItemActive();

	/** Layer rows, top layer first, scrolled by the wheel or by dragging the names. */
	const std::vector<std::unique_ptr<CLayer>>& layers = comp->m_Layers;
	const f32 rowsTop = origin.y + rulerHeight;
	const f32 rowsHeight = std::max(0.0f, area.y - rulerHeight);
	const f32 contentHeight = f32(layers.size()) * rowHeight;
	const f32 maxScroll = std::max(0.0f, contentHeight - rowsHeight);
	const bool hoverRows = ImGui::IsMouseHoveringRect(ImVec2(origin.x, rowsTop), ImVec2(origin.x + area.x, rowsTop + rowsHeight));
	if (hoverRows && ImGui::IsWindowHovered(ImGuiHoveredFlags_ChildWindows) && io.MouseWheel != 0)
	{
		m_fTimelineScroll -= io.MouseWheel * rowHeight * 2;
	}
	m_fTimelineScroll = std::clamp(m_fTimelineScroll, 0.0f, maxScroll);

	draw->PushClipRect(ImVec2(origin.x, rowsTop), ImVec2(origin.x + area.x, rowsTop + rowsHeight), true);
	const f64 time = m_pSession->Time();
	for (size_t i = 0; i < layers.size(); i++)
	{
		const CLayer& layer = *layers[i];
		const f32 y = rowsTop + f32(i) * rowHeight - m_fTimelineScroll;
		if (y + rowHeight < rowsTop || y > rowsTop + rowsHeight)
		{
			continue;
		}
		const bool selected = layer.m_uId == m_uSelectedLayer;
		if (selected)
		{
			draw->AddRectFilled(ImVec2(origin.x, y), ImVec2(origin.x + area.x, y + rowHeight), IM_COL32(45, 140, 235, 55));
		}
		else if (i & 1)
		{
			draw->AddRectFilled(ImVec2(origin.x, y), ImVec2(origin.x + area.x, y + rowHeight), kRowAlt);
		}
		const ImU32 color = LayerColor(layer);
		const f32 chip = 10 * s;
		const f32 midY = y + rowHeight * 0.5f;
		draw->AddRectFilled(ImVec2(origin.x + 8 * s, midY - chip * 0.5f), ImVec2(origin.x + 8 * s + chip, midY + chip * 0.5f), color, 2 * s);
		char index[16];
		std::snprintf(index, sizeof(index), "%d", layer.m_iIndex);
		draw->AddText(ImVec2(origin.x + 14 * s + chip, midY - ImGui::GetTextLineHeight() * 0.5f), kTextDim, index);
		const f32 nameX = origin.x + 22 * s + chip + ImGui::CalcTextSize("00").x;
		const bool visible = layer.m_bEnabled && !layer.m_bGuide;
		draw->PushClipRect(ImVec2(nameX, y), ImVec2(barsX - 4 * s, y + rowHeight), true);
		draw->AddText(ImVec2(nameX, midY - ImGui::GetTextLineHeight() * 0.5f), visible ? IM_COL32(230, 230, 230, 255) : IM_COL32(120, 120, 120, 255),
			layer.m_Name.c_str());
		draw->PopClipRect();

		const f32 x0 = timeToX(std::min(layer.m_fInPoint, layer.m_fOutPoint));
		const f32 x1 = std::max(x0 + 2 * s, timeToX(std::max(layer.m_fInPoint, layer.m_fOutPoint)));
		const ImU32 bar = visible ? (color & 0x00ffffff) | 0xb0000000 : (color & 0x00ffffff) | 0x40000000;
		draw->AddRectFilled(ImVec2(x0, y + 4 * s), ImVec2(x1, y + rowHeight - 4 * s), bar, 3 * s);
		if (selected)
		{
			draw->AddRect(ImVec2(x0, y + 4 * s), ImVec2(x1, y + rowHeight - 4 * s), IM_COL32(255, 255, 255, 200), 3 * s, 0, 1.5f * s);
		}

		ImGui::SetCursorScreenPos(ImVec2(origin.x, y));
		ImGui::PushID(s32(layer.m_uId));
		if (ImGui::InvisibleButton("##name", ImVec2(nameWidth, rowHeight)))
		{
			m_uSelectedLayer = layer.m_uId;
		}
		if (ImGui::IsItemActive() && touch && ImGui::IsMouseDragging(ImGuiMouseButton_Left))
		{
			m_fTimelineScroll = std::clamp(m_fTimelineScroll - io.MouseDelta.y, 0.0f, maxScroll);
		}
		ImGui::SameLine(0, 0);
		ImGui::InvisibleButton("##bars", ImVec2(barsWidth + 8 * s, rowHeight));
		if (ImGui::IsItemActivated())
		{
			m_uSelectedLayer = layer.m_uId;
		}
		scrub = scrub || ImGui::IsItemActive();
		ImGui::PopID();
	}
	draw->PopClipRect();
	if (layers.empty())
	{
		draw->AddText(ImVec2(origin.x + 8 * s, rowsTop + 8 * s), kTextDim, "This comp has no layers.");
	}

	/** The playhead over the ruler and the rows. */
	const f32 px = timeToX(time);
	draw->AddLine(ImVec2(px, origin.y), ImVec2(px, origin.y + area.y), kPlayhead, 1.5f * s);
	draw->AddTriangleFilled(ImVec2(px - 6 * s, origin.y), ImVec2(px + 6 * s, origin.y), ImVec2(px, origin.y + 8 * s), kPlayhead);

	if (scrub)
	{
		const f64 at = std::clamp(f64((io.MousePos.x - barsX) / barsWidth), 0.0, 1.0) * duration;
		if (!m_bScrubbing)
		{
			m_bScrubbing = true;
			if (m_pSession->Playing())
			{
				m_pSession->SetPlaying(false, m_fNow);
			}
		}
		if (at != m_fScrubTime)
		{
			SeekTime(at);
			m_fScrubTime = at;
		}
	}
	else if (m_bScrubbing && !ImGui::IsAnyMouseDown())
	{
		m_bScrubbing = false;
		m_fScrubTime = -1;
	}
	ImGui::SetCursorScreenPos(origin);
	ImGui::Dummy(area);
	ImGui::EndChild();
}

void CApp::DrawLayerDetails()
{
	const CItem* comp = m_pSession->CompItem();
	const CLayer* layer = comp ? comp->LayerById(m_uSelectedLayer) : nullptr;
	if (!layer)
	{
		ImGui::PushStyleColor(ImGuiCol_Text, kTextDim);
		ImGui::TextWrapped("%s", m_Host.m_bTouch ? "Tap a layer in Layers to see its properties." : "Click a layer in the Timeline to see its properties.");
		ImGui::PopStyleColor();
		return;
	}
	const CProject& project = m_pSession->Project();
	const CItem* source = layer->m_uSourceId ? project.Item(layer->m_uSourceId) : nullptr;
	const f64 time = m_pSession->Time();

	ImGui::SetWindowFontScale(1.15f);
	ImGui::TextUnformatted(layer->m_Name.c_str());
	ImGui::SetWindowFontScale(1.0f);
	ImGui::PushStyleColor(ImGuiCol_Text, kTextDim);
	ImGui::Text("%s%s%s", LayerKind(*layer, source), layer->m_bThreeD ? ", 3D" : "", layer->m_bEnabled ? "" : ", hidden");
	ImGui::PopStyleColor();

	if (ImGui::BeginTable("##timing", 2, ImGuiTableFlags_SizingStretchProp))
	{
		const auto row = [](const char* name, const std::string& value) {
			ImGui::TableNextRow();
			ImGui::TableNextColumn();
			ImGui::TextDisabled("%s", name);
			ImGui::TableNextColumn();
			ImGui::TextUnformatted(value.c_str());
		};
		if (source)
		{
			row("Source", source->m_Name);
		}
		row("In", Timecode(layer->m_fInPoint));
		row("Out", Timecode(layer->m_fOutPoint));
		row("Start", Timecode(layer->m_fStartTime));
		if (layer->m_fStretch != 100)
		{
			char stretch[32];
			std::snprintf(stretch, sizeof(stretch), "%.1f%%", layer->m_fStretch);
			row("Stretch", stretch);
		}
		if (const CLayer* parent = layer->m_uParentId ? comp->LayerById(layer->m_uParentId) : nullptr)
		{
			row("Parent", parent->m_Name);
		}
		if (const CLayer* matte = layer->m_uTrackMatteLayerId ? comp->LayerById(layer->m_uTrackMatteLayerId) : nullptr)
		{
			row("Track matte", matte->m_Name);
		}
		ImGui::EndTable();
	}

	/** One property's line: its name, its value now, and marks for keyframes and expressions. */
	const auto property = [&](const char* name, const CPropertyNode& prop, const CPropertyNode* siblings, bool transform) {
		const CValue value = CurrentValue(prop, time, *layer, siblings);
		/** A 2D layer's anchor point, position and scale have a z the Timeline does not show. */
		const std::string text = ValueText(value, prop.m_uControlType == CONTROL_COLOR, transform && !layer->m_bThreeD ? 2 : ~0u);
		ImGui::TableNextRow();
		ImGui::TableNextColumn();
		ImGui::TextUnformatted(name);
		ImGui::TableNextColumn();
		ImGui::TextUnformatted(text.c_str());
		if (!prop.m_Keyframes.empty() || (!prop.m_Expression.empty() && prop.m_bExpressionEnabled))
		{
			ImGui::SameLine();
			ImGui::PushStyleColor(ImGuiCol_Text, kAccent);
			ImGui::TextUnformatted(!prop.m_Expression.empty() && prop.m_bExpressionEnabled ? (prop.m_Keyframes.empty() ? "=" : "\xE2\x97\x86 =") : "\xE2\x97\x86");
			ImGui::PopStyleColor();
			ImGui::SetItemTooltip("%s", !prop.m_Expression.empty() && prop.m_bExpressionEnabled ? prop.m_Expression.c_str() : "Keyframed");
		}
	};

	if (const CPropertyNode* transform = layer->m_Properties.FindGroup("ADBE Transform Group"))
	{
		if (ImGui::CollapsingHeader("Transform", ImGuiTreeNodeFlags_DefaultOpen) && ImGui::BeginTable("##transform", 2, ImGuiTableFlags_SizingStretchProp))
		{
			for (const auto& child : transform->m_Children)
			{
				if (child->m_bGroup || child->m_uValueType == PVT_NO_VALUE)
				{
					continue;
				}
				const bool separated = transform->FindProperty("ADBE Position") && transform->FindProperty("ADBE Position")->m_bDimensionsSeparated;
				if ((child->m_MatchName == "ADBE Position" && separated) ||
					(!separated && child->m_MatchName.rfind("ADBE Position_", 0) == 0) ||
					(!layer->m_bThreeD && (child->m_MatchName == "ADBE Orientation" || child->m_MatchName == "ADBE Rotate X" ||
						child->m_MatchName == "ADBE Rotate Y" || child->m_MatchName == "ADBE Position_2")))
				{
					continue;
				}
				if (const char* name = TransformName(child->m_MatchName))
				{
					property(name, *child, transform, true);
				}
			}
			ImGui::EndTable();
		}
	}

	if (const CPropertyNode* masks = layer->m_Properties.FindGroup("ADBE Mask Parade"))
	{
		s32 count = 0;
		for (const auto& child : masks->m_Children)
		{
			count += child->m_bHasMask ? 1 : 0;
		}
		if (count && ImGui::CollapsingHeader("Masks"))
		{
			ImGui::Text("%d mask%s", count, count == 1 ? "" : "s");
		}
	}

	if (const CPropertyNode* effects = layer->m_Properties.FindGroup("ADBE Effect Parade"))
	{
		if (!effects->m_Children.empty() && ImGui::CollapsingHeader("Effects", ImGuiTreeNodeFlags_DefaultOpen))
		{
			for (const auto& effect : effects->m_Children)
			{
				if (!effect->m_bGroup)
				{
					continue;
				}
				const auto known = project.m_EffectTypes.find(effect->m_MatchName);
				const std::string type = known != project.m_EffectTypes.end() ? known->second : effect->m_MatchName;
				const std::string title = (effect->m_EffectName.empty() ? type : effect->m_EffectName) + (effect->m_bEnabled ? "" : " (off)");
				ImGui::PushID(effect.get());
				if (ImGui::TreeNode("##effect", "%s", title.c_str()))
				{
					if (!effect->m_EffectName.empty() && effect->m_EffectName != type)
					{
						ImGui::TextDisabled("%s", type.c_str());
					}
					if (ImGui::BeginTable("##params", 2, ImGuiTableFlags_SizingStretchProp))
					{
						s32 index = 0;
						for (const auto& param : effect->m_Children)
						{
							index++;
							if (param->m_bGroup || param->m_uValueType == PVT_NO_VALUE)
							{
								continue;
							}
							char name[32];
							std::snprintf(name, sizeof(name), "Parameter %d", index);
							property(name, *param, effect.get(), false);
						}
						ImGui::EndTable();
					}
					ImGui::TreePop();
				}
				ImGui::PopID();
			}
		}
	}
}

void CApp::DrawInfo()
{
	const aevk::DeviceInfo& device = m_Engine.device();
	const sSessionStats& stats = m_pSession->Stats();
	const sCompInfo* comp = m_pSession->Comp();
	if (ImGui::BeginTable("##info", 2, ImGuiTableFlags_SizingStretchProp))
	{
		const auto row = [](const char* name, const char* format, auto... values) {
			ImGui::TableNextRow();
			ImGui::TableNextColumn();
			ImGui::TextDisabled("%s", name);
			ImGui::TableNextColumn();
			ImGui::Text(format, values...);
		};
		row("Project", "%s", m_ProjectName.c_str());
		row("Saved by", "After Effects %s", m_pSession->Project().m_Version.c_str());
		if (comp)
		{
			row("Comp", "%s", comp->m_Name.c_str());
			row("Size", "%.0f x %.0f", comp->m_fWidth, comp->m_fHeight);
			row("Frame rate", "%.3f fps", comp->m_fFrameRate);
		}
		row("GPU", "%s%s", device.name.c_str(), device.software ? " (software)" : "");
		row("Vulkan", "%u.%u.%u", device.apiVersion >> 22, (device.apiVersion >> 12) & 0x3ff, device.apiVersion & 0xfff);
		row("Planning", "%.2f ms a frame", stats.m_fPlanMs);
		row("Rendering", "%.2f ms a frame", stats.m_fRenderMs);
		row("Shown", "%lld frames", (long long)stats.m_iShown);
		row("Dropped", "%lld frames", (long long)stats.m_iDropped);
		if (stats.m_fExpressionStartupMs > 0)
		{
			row("Expressions", "started in %.0f ms", stats.m_fExpressionStartupMs);
		}
		ImGui::EndTable();
	}
	const std::vector<std::string>& warnings = m_pSession->Project().m_Warnings;
	if (!warnings.empty() && ImGui::CollapsingHeader("Project warnings"))
	{
		for (const std::string& warning : warnings)
		{
			ImGui::BulletText("%s", warning.c_str());
		}
	}
}

void CApp::DrawStatusBar()
{
	const f32 s = m_fScale;
	const ImVec2 size(ImGui::GetWindowWidth(), ImGui::GetFrameHeight());
	ImGui::SetCursorPos(ImVec2(0, ImGui::GetWindowHeight() - size.y));
	const ImVec2 p0 = ImGui::GetCursorScreenPos();
	ImDrawList* draw = ImGui::GetWindowDrawList();
	draw->AddRectFilled(p0, Add(p0, size), IM_COL32(20, 20, 20, 255));
	const f32 y = p0.y + (size.y - ImGui::GetTextLineHeight()) * 0.5f;
	std::string left = m_ProjectName;
	if (const sCompInfo* comp = m_pSession->Comp())
	{
		char text[128];
		std::snprintf(text, sizeof(text), "  |  %s  %.0f x %.0f", comp->m_Name.c_str(), comp->m_fWidth, comp->m_fHeight);
		left += text;
	}
	char stats[96];
	std::snprintf(stats, sizeof(stats), "  |  plan %.2f ms  render %.2f ms", m_pSession->Stats().m_fPlanMs, m_pSession->Stats().m_fRenderMs);
	left += stats;
	draw->AddText(ImVec2(p0.x + 8 * s, y), kTextDim, left.c_str());
	const std::string& device = m_Engine.device().name;
	const f32 deviceWidth = ImGui::CalcTextSize(device.c_str()).x;
	draw->AddText(ImVec2(p0.x + size.x - deviceWidth - 8 * s, y), kTextDim, device.c_str());
	ImGui::Dummy(size);
}

void CApp::DrawBrowser()
{
	if (m_bShowBrowser && !ImGui::IsPopupOpen("Open a project"))
	{
		ImGui::OpenPopup("Open a project");
		if (m_BrowserFolder.empty())
		{
			m_BrowserFolder = m_Recent.Paths().empty() ? HomeFolder() : FolderOf(m_Recent.Paths().front());
		}
		m_BrowserError.clear();
		if (!ListFolder(m_BrowserFolder, m_BrowserEntries, m_BrowserError))
		{
			m_BrowserFolder = HomeFolder();
			ListFolder(m_BrowserFolder, m_BrowserEntries, m_BrowserError);
		}
	}
	const ImVec2 display = ImGui::GetIO().DisplaySize;
	const f32 s = m_fScale;
	ImGui::SetNextWindowSize(ImVec2(std::min(display.x - 24 * s, 720 * s), std::min(display.y - 24 * s, 560 * s)), ImGuiCond_Appearing);
	ImGui::SetNextWindowPos(ImVec2(display.x * 0.5f, display.y * 0.5f), ImGuiCond_Appearing, ImVec2(0.5f, 0.5f));
	if (!ImGui::BeginPopupModal("Open a project", &m_bShowBrowser, ImGuiWindowFlags_NoSavedSettings))
	{
		return;
	}
	std::string go;
	if (ImGui::Button("Up"))
	{
		go = ParentFolder(m_BrowserFolder);
	}
	ImGui::SameLine();
	if (ImGui::Button("Home"))
	{
		go = HomeFolder();
	}
	for (const std::string& root : Roots())
	{
		ImGui::SameLine();
		if (ImGui::Button(root.c_str()))
		{
			go = root;
		}
	}
	ImGui::SameLine();
	ImGui::SetNextItemWidth(-1);
	char path[1024];
	std::snprintf(path, sizeof(path), "%s", m_BrowserFolder.c_str());
	if (ImGui::InputText("##path", path, sizeof(path), ImGuiInputTextFlags_EnterReturnsTrue))
	{
		go = path;
	}
	const f32 footer = ImGui::GetFrameHeightWithSpacing();
	ImGui::BeginChild("##entries", ImVec2(0, -footer), ImGuiChildFlags_Borders);
	if (!m_BrowserError.empty())
	{
		ImGui::TextColored(ImVec4(0.9f, 0.6f, 0.3f, 1), "This folder cannot be read: %s", m_BrowserError.c_str());
	}
	std::string open;
	for (const sFolderEntry& entry : m_BrowserEntries)
	{
		ImGui::PushID(entry.m_Path.c_str());
		const std::string label = (entry.m_bFolder ? "[folder]  " : "") + entry.m_Name;
		const bool single = m_Host.m_bTouch || !entry.m_bFolder;
		if (ImGui::Selectable(label.c_str(), false, ImGuiSelectableFlags_AllowDoubleClick))
		{
			if (entry.m_bFolder && (single || ImGui::IsMouseDoubleClicked(ImGuiMouseButton_Left)))
			{
				go = entry.m_Path;
			}
			else if (!entry.m_bFolder)
			{
				open = entry.m_Path;
			}
		}
		if (!entry.m_bFolder)
		{
			ImGui::SameLine(ImGui::GetContentRegionAvail().x - 80 * s);
			ImGui::TextDisabled("%.1f MB", f64(entry.m_uBytes) / (1 << 20));
		}
		ImGui::PopID();
	}
	if (m_BrowserEntries.empty() && m_BrowserError.empty())
	{
		ImGui::TextDisabled("No folders or .aep projects here.");
	}
	ImGui::EndChild();
	ImGui::TextDisabled("Choose an .aep project. Its footage and sounds are looked for in its folder.");
	ImGui::SameLine(ImGui::GetWindowWidth() - 90 * s);
	if (ImGui::Button("Cancel", ImVec2(80 * s, 0)))
	{
		m_bShowBrowser = false;
	}
	if (!go.empty())
	{
		std::string error;
		std::vector<sFolderEntry> entries;
		if (ListFolder(go, entries, error))
		{
			m_BrowserFolder = go;
			m_BrowserEntries = std::move(entries);
			m_BrowserError.clear();
		}
		else
		{
			m_BrowserError = error;
		}
	}
	if (!m_bShowBrowser)
	{
		ImGui::CloseCurrentPopup();
	}
	ImGui::EndPopup();
	if (!open.empty())
	{
		m_bShowBrowser = false;
		OpenFile(open);
	}
}

void CApp::DrawAbout()
{
	if (m_bShowAbout && !ImGui::IsPopupOpen("About"))
	{
		ImGui::OpenPopup("About");
	}
	const ImVec2 display = ImGui::GetIO().DisplaySize;
	ImGui::SetNextWindowPos(ImVec2(display.x * 0.5f, display.y * 0.5f), ImGuiCond_Appearing, ImVec2(0.5f, 0.5f));
	ImGui::SetNextWindowSizeConstraints(ImVec2(0, 0), ImVec2(std::min(display.x - 24 * m_fScale, 520 * m_fScale), display.y));
	if (!ImGui::BeginPopupModal("About", &m_bShowAbout, ImGuiWindowFlags_AlwaysAutoResize | ImGuiWindowFlags_NoSavedSettings))
	{
		return;
	}
	ImGui::TextUnformatted("aep, native");
	ImGui::PushTextWrapPos(std::min(display.x - 48 * m_fScale, 480 * m_fScale));
	ImGui::TextDisabled("Plays After Effects projects with the C++ core and the Vulkan engine%s%s.", m_Host.m_Platform.empty() ? "" : " on ",
		m_Host.m_Platform.c_str());
	ImGui::TextDisabled("GPU: %s", m_Engine.device().name.c_str());
	ImGui::TextDisabled("Interface: Dear ImGui %s (MIT). Font: Roboto (Apache 2.0).", IMGUI_VERSION);
#if AEP_EXPRESSIONS
	ImGui::TextDisabled("Expressions: QuickJS-ng (MIT).");
#endif
	ImGui::PopTextWrapPos();
	if (ImGui::Button("Close", ImVec2(120 * m_fScale, 0)))
	{
		m_bShowAbout = false;
	}
	if (!m_bShowAbout)
	{
		ImGui::CloseCurrentPopup();
	}
	ImGui::EndPopup();
}

void CApp::DrawToasts(const ImVec2& display)
{
	m_Toasts.erase(std::remove_if(m_Toasts.begin(), m_Toasts.end(), [&](const sToast& t) { return t.m_fUntil < m_fNow; }), m_Toasts.end());
	if (m_Toasts.empty())
	{
		return;
	}
	const f32 s = m_fScale;
	ImDrawList* draw = ImGui::GetForegroundDrawList();
	f32 y = display.y - 48 * s;
	const f32 wrap = std::min(display.x - 48 * s, 560 * s);
	for (auto it = m_Toasts.rbegin(); it != m_Toasts.rend(); ++it)
	{
		const ImVec2 size = ImGui::CalcTextSize(it->m_Text.c_str(), nullptr, false, wrap);
		const f32 pad = 10 * s;
		y -= size.y + 2 * pad;
		const ImVec2 p0((display.x - size.x) * 0.5f - pad, y);
		const ImVec2 p1(p0.x + size.x + 2 * pad, y + size.y + 2 * pad);
		const f32 fade = f32(std::clamp(it->m_fUntil - m_fNow, 0.0, 0.3) / 0.3);
		draw->AddRectFilled(p0, p1, IM_COL32(40, 40, 40, s32(240 * fade)), 6 * s);
		draw->AddRect(p0, p1, IM_COL32(80, 80, 80, s32(255 * fade)), 6 * s);
		draw->AddText(nullptr, 0, ImVec2(p0.x + pad, p0.y + pad), IM_COL32(235, 235, 235, s32(255 * fade)), it->m_Text.c_str(), nullptr, wrap);
		y -= 8 * s;
	}
}

bool CApp::IconButton(const char* id, s32 icon, f32 size, const char* label, bool active)
{
	const ImVec2 p0 = ImGui::GetCursorScreenPos();
	const bool pressed = ImGui::InvisibleButton(id, ImVec2(size, size));
	const bool hovered = ImGui::IsItemHovered();
	const bool held = ImGui::IsItemActive();
	if (label && label[0])
	{
		ImGui::SetItemTooltip("%s", label);
	}
	ImDrawList* draw = ImGui::GetWindowDrawList();
	const ImVec2 p1 = Add(p0, ImVec2(size, size));
	const f32 r = size * 0.18f;
	if (icon != ICON_FOLDER)
	{
		const ImU32 fill = held ? IM_COL32(45, 140, 235, 255) : active ? IM_COL32(45, 140, 235, hovered ? 220 : 170) : hovered ? IM_COL32(70, 70, 70, 255)
																							 : IM_COL32(52, 52, 52, 255);
		draw->AddRectFilled(p0, p1, fill, r);
	}
	const ImU32 ink = IM_COL32(240, 240, 240, 255);
	const f32 c = size * 0.5f;
	const ImVec2 m(p0.x + c, p0.y + c);
	const f32 u = size * 0.16f;
	switch (icon)
	{
	case ICON_PLAY:
		draw->AddTriangleFilled(ImVec2(m.x - u * 0.9f, m.y - u * 1.2f), ImVec2(m.x - u * 0.9f, m.y + u * 1.2f), ImVec2(m.x + u * 1.3f, m.y), ink);
		break;
	case ICON_PAUSE:
		draw->AddRectFilled(ImVec2(m.x - u * 1.1f, m.y - u * 1.1f), ImVec2(m.x - u * 0.3f, m.y + u * 1.1f), ink, 1);
		draw->AddRectFilled(ImVec2(m.x + u * 0.3f, m.y - u * 1.1f), ImVec2(m.x + u * 1.1f, m.y + u * 1.1f), ink, 1);
		break;
	case ICON_STEP_BACK:
		draw->AddRectFilled(ImVec2(m.x - u * 1.2f, m.y - u), ImVec2(m.x - u * 0.8f, m.y + u), ink);
		draw->AddTriangleFilled(ImVec2(m.x + u, m.y - u), ImVec2(m.x + u, m.y + u), ImVec2(m.x - u * 0.6f, m.y), ink);
		break;
	case ICON_STEP_FORWARD:
		draw->AddRectFilled(ImVec2(m.x + u * 0.8f, m.y - u), ImVec2(m.x + u * 1.2f, m.y + u), ink);
		draw->AddTriangleFilled(ImVec2(m.x - u, m.y - u), ImVec2(m.x - u, m.y + u), ImVec2(m.x + u * 0.6f, m.y), ink);
		break;
	case ICON_TO_START:
		draw->AddRectFilled(ImVec2(m.x - u * 1.4f, m.y - u), ImVec2(m.x - u * 1.0f, m.y + u), ink);
		draw->AddTriangleFilled(ImVec2(m.x, m.y - u), ImVec2(m.x, m.y + u), ImVec2(m.x - u, m.y), ink);
		draw->AddTriangleFilled(ImVec2(m.x + u, m.y - u), ImVec2(m.x + u, m.y + u), ImVec2(m.x, m.y), ink);
		break;
	case ICON_TO_END:
		draw->AddRectFilled(ImVec2(m.x + u * 1.0f, m.y - u), ImVec2(m.x + u * 1.4f, m.y + u), ink);
		draw->AddTriangleFilled(ImVec2(m.x, m.y - u), ImVec2(m.x, m.y + u), ImVec2(m.x + u, m.y), ink);
		draw->AddTriangleFilled(ImVec2(m.x - u, m.y - u), ImVec2(m.x - u, m.y + u), ImVec2(m.x, m.y), ink);
		break;
	case ICON_MENU:
		for (s32 i = -1; i <= 1; i++)
		{
			draw->AddRectFilled(ImVec2(m.x - u * 1.3f, m.y + i * u * 0.8f - u * 0.15f), ImVec2(m.x + u * 1.3f, m.y + i * u * 0.8f + u * 0.15f), ink, 1);
		}
		break;
	case ICON_FOLDER:
	{
		const ImU32 folder = active ? kAccent : IM_COL32(160, 160, 160, 255);
		draw->AddRectFilled(ImVec2(p0.x + size * 0.08f, p0.y + size * 0.2f), ImVec2(p0.x + size * 0.45f, p0.y + size * 0.35f), folder, size * 0.05f);
		draw->AddRectFilled(ImVec2(p0.x + size * 0.08f, p0.y + size * 0.3f), ImVec2(p0.x + size * 0.92f, p0.y + size * 0.82f), folder, size * 0.06f);
		break;
	}
	case ICON_GRID:
	{
		const f32 g = size * 0.2f;
		for (s32 y = 0; y < 3; y++)
		{
			for (s32 x = 0; x < 3; x++)
			{
				const ImVec2 a(m.x - 1.5f * g + x * g, m.y - 1.5f * g + y * g);
				draw->AddRectFilled(a, Add(a, ImVec2(g, g)), ((x + y) & 1) ? IM_COL32(240, 240, 240, 255) : IM_COL32(150, 150, 150, 255));
			}
		}
		break;
	}
	default:
		break;
	}
	return pressed;
}

} /** namespace aep */
