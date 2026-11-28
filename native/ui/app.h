/**
 * The app: one interface for desktop and Android, drawn with Dear ImGui over the C++ core and the Vulkan engine. It
 * opens an After Effects project and plays its comps with the panels the web app has for viewing one: Project, the
 * Composition viewer, playback controls, the Timeline and the selected layer's details. Wide windows get the desktop
 * layout; narrow ones (phones held upright) get one column with large touch targets.
 *
 * The host (tools/aep_app.cpp on desktop, android/aep_app_jni.cpp on Android) owns the window and the engine, feeds
 * input into Dear ImGui's IO and calls Frame once per display frame.
 */
#pragma once

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "engine.h"
#include "files.h"
#include "imgui.h"
#include "render.h"
#include "session.h"

namespace aep
{

/** What the platform does for the app. */
struct sAppHost
{
	/**
	 * Asks the platform to let the user choose a project; it answers later with CApp::OpenBytes or CApp::OpenFile.
	 * Without it the app shows its own folder browser.
	 */
	std::function<void()> m_ChooseProject;
	/**
	 * Asks the platform to let the user choose the folder a project's footage is in; it answers later with
	 * CApp::AddMediaFolder. Without it footage is only looked for next to the project.
	 */
	std::function<void()> m_ChooseFootageFolder;
	/** Saves a file the user asked for (a frame as PNG); without it the app writes next to the project. */
	std::function<bool(const std::string& name, const std::vector<u8>& bytes, std::string& error)> m_SaveFile;
	/** A touch screen: larger targets, no hover. */
	bool m_bTouch = false;
	/** Interface scale: the display's density (1 at 96 dpi on desktop, 160 dpi on Android). */
	f32 m_fScale = 1;
	/** Where settings and the recent list are kept; empty keeps them in memory. */
	std::string m_SettingsFolder;
	/** What the platform calls itself in the About box. */
	std::string m_Platform;
};

class CApp
{
public:
	CApp(aevk::Engine& engine, sAppHost host);
	~CApp();

	CApp(const CApp&) = delete;
	CApp& operator=(const CApp&) = delete;

	/** Creates the interface (its context, fonts and font texture); false with `error` set. */
	bool Init(std::string& error);

	/** Opens the project at `path` (its folder is searched for its footage and sounds). */
	bool OpenFile(const std::string& path);
	/** Opens a project from its bytes; `mediaFolder` (may be empty) is searched for its footage and sounds. */
	bool OpenBytes(const std::string& name, std::vector<u8> bytes, const std::string& mediaFolder);
	/** Looks for footage and sounds in `folder` too, and draws the frames shown so far again. */
	void AddMediaFolder(const std::string& folder);
	/** Starts or pauses playback of the current comp. */
	void SetPlaying(bool playing);
	/** Shows a message in the app (a project the platform could not read...). */
	void Notify(const std::string& message);

	/**
	 * One display frame: the input the host fed into IO since the last one is handled, playback moves on, and the
	 * interface is drawn into the engine's window (`width` x `height` pixels). False once the user quit.
	 */
	bool Frame(f64 now, s32 width, s32 height);
	/** Whether the app has something to animate (playback, a drag); otherwise the host may wait for input. */
	bool Busy() const;

	/** Zooms the viewer by `factor` about window point (x, y): a pinch on a touch screen. */
	void Pinch(f32 factor, f32 x, f32 y);
	/** The platform's back button: closes a dialog or the project; false when there was nothing to close. */
	bool Back();
	/** Changes the interface scale (a window moved to another display). */
	void SetScale(f32 scale);
	/** Window pixels at each edge that system bars or a camera cutout cover; the interface keeps clear of them. */
	void SetSafeArea(f32 left, f32 top, f32 right, f32 bottom);

private:
	struct sLayout;

	void ApplyStyle();
	bool LoadFonts(std::string& error);
	bool StartSession(const std::string& name, const std::string& path, std::vector<u8> bytes);
	void CloseProject();

	void DrawHome();
	void DrawWorkspace(const sLayout& layout);
	void DrawMenuBar();
	void DrawProjectPanel();
	void DrawViewer(const ImVec2& size);
	void DrawTransport(bool compact);
	void DrawTimeline(const ImVec2& size);
	void DrawLayerDetails();
	void DrawInfo();
	void DrawStatusBar();
	void DrawBrowser();
	void DrawAbout();
	void DrawToasts(const ImVec2& display);

	void SelectComp(u32 id);
	void TogglePlay();
	void Step(s32 frames);
	void SeekTime(f64 time);
	void SaveFrame();
	std::string Timecode(f64 time) const;

	/** On a touch screen, a finger dragging up or down over a list scrolls it, as Android's lists do. */
	void TouchScroll();

	/** Draws an icon button (play, pause, step...) of `size`, its tooltip `label`; true when clicked. */
	bool IconButton(const char* id, s32 icon, f32 size, const char* label, bool active = false);

	aevk::Engine& m_Engine;
	sAppHost m_Host;
	CUiRenderer m_Renderer;
	ImGuiContext* m_pContext = nullptr;
	bool m_bInit = false;
	f32 m_fScale = 1;
	f32 m_fAppliedScale = 0;
	/** Left, top, right and bottom insets in window pixels. */
	ImVec4 m_SafeArea = ImVec4(0, 0, 0, 0);
	/** The window a touch drag is scrolling, while it does. */
	ImGuiID m_uTouchScrollWindow = 0;

	std::unique_ptr<CPlaybackSession> m_pSession;
	std::string m_ProjectName;
	std::string m_ProjectPath;
	CRecentFiles m_Recent;
	f64 m_fNow = 0;
	bool m_bQuit = false;

	/** The layer the details panel shows, by id in the current comp. */
	u32 m_uSelectedLayer = 0;
	/** Viewer zoom: 0 fits the comp in the panel; otherwise image pixels per comp pixel. */
	f32 m_fZoom = 0;
	ImVec2 m_Pan = ImVec2(0, 0);
	bool m_bTransparencyGrid = true;
	bool m_bScrubbing = false;
	bool m_bWasPlaying = false;
	/** The playhead time the last scrub asked for, so dragging does not seek the same frame again. */
	f64 m_fScrubTime = -1;
	/** Timeline: seconds per pixel's inverse (pixels per second); 0 fits the comp. */
	f32 m_fTimelineZoom = 0;
	f32 m_fTimelineScroll = 0;
	/** Desktop layout's split sizes, in interface units. */
	f32 m_fProjectWidth = 230;
	f32 m_fDetailsWidth = 300;
	f32 m_fTimelineHeight = 240;
	/** Compact layout: the tab under the viewer. */
	s32 m_iTab = 0;

	bool m_bShowBrowser = false;
	bool m_bShowAbout = false;
	std::string m_BrowserFolder;
	std::vector<sFolderEntry> m_BrowserEntries;
	std::string m_BrowserError;

	struct sToast
	{
		std::string m_Text;
		f64 m_fUntil = 0;
	};
	std::vector<sToast> m_Toasts;
	std::string m_LastError;

	/** Smoothed frames per second the viewer shows. */
	f64 m_fFps = 0;
	f64 m_fLastFrameShown = 0;
	/** A frame the session rendered is kept until the next, so the viewer always has one to draw. */
	std::shared_ptr<aevk::Frame> m_pFrame;
	s64 m_iFrameShown = -1;
};

} /** namespace aep */
