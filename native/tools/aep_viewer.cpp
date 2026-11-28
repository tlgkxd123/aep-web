/**
 * The desktop player: a window that opens an .aep project and plays its comps on the C++ core and the Vulkan engine,
 * with the web app's Preview timing (docs/native-port.md, milestone M2). Linux (xcb) and Windows (Win32).
 *
 *   aep-viewer [--comp name] [--resolution 1-4] [--expressions] [--play] [--no-vsync] [--benchmark] [--frames n]
 *              project.aep
 *
 * Space plays and pauses, Left and Right step a frame, Home goes to the start, 1 to 4 pick Full, Half, Third or
 * Quarter resolution, Page Up and Page Down switch comps, dragging in the window scrubs, Escape or Q quits.
 * --frames n quits after n frames have been shown (tried, with --benchmark) and prints one JSON line of what playback cost, for measuring.
 * --benchmark shows every frame in turn, each planned and rendered afresh with nothing cached, as fast as the planner,
 * the GPU and (without --no-vsync) the display allow, instead of at the comp's frame rate.
 */
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "engine.h"
#include "session.h"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <xcb/xcb.h>
#endif

namespace
{

using aep::f64;
using aep::s32;
using aep::s64;
using aep::u32;
using aep::u8;

enum eKey
{
	KEY_NONE,
	KEY_SPACE,
	KEY_LEFT,
	KEY_RIGHT,
	KEY_HOME,
	KEY_PAGE_UP,
	KEY_PAGE_DOWN,
	KEY_QUIT,
	KEY_1,
	KEY_2,
	KEY_3,
	KEY_4,
};

enum eEventType
{
	EVENT_KEY,
	EVENT_PRESS,
	EVENT_RELEASE,
	EVENT_MOTION,
	EVENT_RESIZE,
	EVENT_CLOSE,
};

struct sEvent
{
	eEventType m_eType = EVENT_KEY;
	eKey m_eKey = KEY_NONE;
	s32 m_iX = 0;
	s32 m_iY = 0;
};

f64 Now()
{
	return std::chrono::duration<f64>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

/** One top-level window on the platform's own window system, with its events reduced to what the player needs. */
class CWindow
{
public:
	~CWindow() { Destroy(); }

	bool Create(s32 width, s32 height, const std::string& title, std::string& error);
	void SetTitle(const std::string& title);
	/** Appends the events waiting now to `out` without blocking. */
	void Poll(std::vector<sEvent>& out);
	s32 Width() const { return m_iWidth; }
	s32 Height() const { return m_iHeight; }
	/** What Engine::attachDesktopWindow takes. */
	void* Display() const;
	uint64_t Handle() const;

private:
	void Destroy();

	s32 m_iWidth = 0;
	s32 m_iHeight = 0;
#if defined(_WIN32)
	static LRESULT CALLBACK Proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam);
	HINSTANCE m_hInstance = nullptr;
	HWND m_hWnd = nullptr;
	std::vector<sEvent>* m_pPending = nullptr;
#else
	xcb_connection_t* m_pConnection = nullptr;
	xcb_window_t m_Window = 0;
	xcb_atom_t m_DeleteAtom = 0;
	xcb_atom_t Atom(const char* name);
#endif
};

#if defined(_WIN32)

eKey KeyOf(WPARAM key)
{
	switch (key)
	{
	case VK_SPACE: return KEY_SPACE;
	case VK_LEFT: return KEY_LEFT;
	case VK_RIGHT: return KEY_RIGHT;
	case VK_HOME: return KEY_HOME;
	case VK_PRIOR: return KEY_PAGE_UP;
	case VK_NEXT: return KEY_PAGE_DOWN;
	case VK_ESCAPE:
	case 'Q': return KEY_QUIT;
	case '1': return KEY_1;
	case '2': return KEY_2;
	case '3': return KEY_3;
	case '4': return KEY_4;
	default: return KEY_NONE;
	}
}

LRESULT CALLBACK CWindow::Proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam)
{
	CWindow* self = reinterpret_cast<CWindow*>(GetWindowLongPtrA(hwnd, GWLP_USERDATA));
	if (!self || !self->m_pPending)
	{
		return DefWindowProcA(hwnd, message, wparam, lparam);
	}
	sEvent event;
	event.m_iX = s32(short(LOWORD(lparam)));
	event.m_iY = s32(short(HIWORD(lparam)));
	switch (message)
	{
	case WM_CLOSE:
		event.m_eType = EVENT_CLOSE;
		self->m_pPending->push_back(event);
		return 0;
	case WM_SIZE:
		self->m_iWidth = s32(LOWORD(lparam));
		self->m_iHeight = s32(HIWORD(lparam));
		event.m_eType = EVENT_RESIZE;
		self->m_pPending->push_back(event);
		return 0;
	case WM_KEYDOWN:
		event.m_eType = EVENT_KEY;
		event.m_eKey = KeyOf(wparam);
		self->m_pPending->push_back(event);
		return 0;
	case WM_LBUTTONDOWN:
		SetCapture(hwnd);
		event.m_eType = EVENT_PRESS;
		self->m_pPending->push_back(event);
		return 0;
	case WM_LBUTTONUP:
		ReleaseCapture();
		event.m_eType = EVENT_RELEASE;
		self->m_pPending->push_back(event);
		return 0;
	case WM_MOUSEMOVE:
		event.m_eType = EVENT_MOTION;
		self->m_pPending->push_back(event);
		return 0;
	default:
		return DefWindowProcA(hwnd, message, wparam, lparam);
	}
}

bool CWindow::Create(s32 width, s32 height, const std::string& title, std::string& error)
{
	m_hInstance = GetModuleHandleA(nullptr);
	WNDCLASSEXA windowClass = {};
	windowClass.cbSize = sizeof(windowClass);
	windowClass.style = CS_HREDRAW | CS_VREDRAW;
	windowClass.lpfnWndProc = Proc;
	windowClass.hInstance = m_hInstance;
	windowClass.hCursor = LoadCursor(nullptr, IDC_ARROW);
	windowClass.lpszClassName = "aep-viewer";
	RegisterClassExA(&windowClass);
	RECT rect = { 0, 0, width, height };
	AdjustWindowRect(&rect, WS_OVERLAPPEDWINDOW, FALSE);
	m_hWnd = CreateWindowExA(0, "aep-viewer", title.c_str(), WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT,
		rect.right - rect.left, rect.bottom - rect.top, nullptr, nullptr, m_hInstance, nullptr);
	if (!m_hWnd)
	{
		error = "the window could not be created";
		return false;
	}
	SetWindowLongPtrA(m_hWnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
	m_iWidth = width;
	m_iHeight = height;
	ShowWindow(m_hWnd, SW_SHOW);
	return true;
}

void CWindow::SetTitle(const std::string& title)
{
	SetWindowTextA(m_hWnd, title.c_str());
}

void CWindow::Poll(std::vector<sEvent>& out)
{
	m_pPending = &out;
	MSG message;
	while (PeekMessageA(&message, nullptr, 0, 0, PM_REMOVE))
	{
		TranslateMessage(&message);
		DispatchMessageA(&message);
	}
	m_pPending = nullptr;
}

void* CWindow::Display() const
{
	return m_hInstance;
}

uint64_t CWindow::Handle() const
{
	return uint64_t(reinterpret_cast<uintptr_t>(m_hWnd));
}

void CWindow::Destroy()
{
	if (m_hWnd)
	{
		DestroyWindow(m_hWnd);
		m_hWnd = nullptr;
	}
}

#else

/**
 * X key codes of the keys the player uses. These are the evdev codes every current X server (Xorg, Xwayland, Xvfb)
 * reports, so the viewer needs no keyboard-mapping library.
 */
eKey KeyOf(xcb_keycode_t code)
{
	switch (code)
	{
	case 65: return KEY_SPACE;
	case 113: return KEY_LEFT;
	case 114: return KEY_RIGHT;
	case 110: return KEY_HOME;
	case 112: return KEY_PAGE_UP;
	case 117: return KEY_PAGE_DOWN;
	case 9:
	case 24: return KEY_QUIT;
	case 10: return KEY_1;
	case 11: return KEY_2;
	case 12: return KEY_3;
	case 13: return KEY_4;
	default: return KEY_NONE;
	}
}

xcb_atom_t CWindow::Atom(const char* name)
{
	xcb_intern_atom_reply_t* reply =
		xcb_intern_atom_reply(m_pConnection, xcb_intern_atom(m_pConnection, 0, u32(std::strlen(name)), name), nullptr);
	const xcb_atom_t atom = reply ? reply->atom : 0;
	std::free(reply);
	return atom;
}

bool CWindow::Create(s32 width, s32 height, const std::string& title, std::string& error)
{
	s32 screenIndex = 0;
	m_pConnection = xcb_connect(nullptr, &screenIndex);
	if (!m_pConnection || xcb_connection_has_error(m_pConnection))
	{
		error = "no X display (set DISPLAY, or run it under Xvfb)";
		return false;
	}
	xcb_screen_iterator_t screens = xcb_setup_roots_iterator(xcb_get_setup(m_pConnection));
	for (s32 i = 0; i < screenIndex; i++)
	{
		xcb_screen_next(&screens);
	}
	xcb_screen_t* screen = screens.data;
	m_Window = xcb_generate_id(m_pConnection);
	const u32 mask = XCB_CW_BACK_PIXEL | XCB_CW_EVENT_MASK;
	const u32 values[2] = { screen->black_pixel,
		XCB_EVENT_MASK_KEY_PRESS | XCB_EVENT_MASK_BUTTON_PRESS | XCB_EVENT_MASK_BUTTON_RELEASE |
			XCB_EVENT_MASK_BUTTON_MOTION | XCB_EVENT_MASK_STRUCTURE_NOTIFY | XCB_EVENT_MASK_EXPOSURE };
	xcb_create_window(m_pConnection, XCB_COPY_FROM_PARENT, m_Window, screen->root, 0, 0, u32(width), u32(height), 0,
		XCB_WINDOW_CLASS_INPUT_OUTPUT, screen->root_visual, mask, values);
	const xcb_atom_t protocols = Atom("WM_PROTOCOLS");
	m_DeleteAtom = Atom("WM_DELETE_WINDOW");
	xcb_change_property(m_pConnection, XCB_PROP_MODE_REPLACE, m_Window, protocols, XCB_ATOM_ATOM, 32, 1, &m_DeleteAtom);
	m_iWidth = width;
	m_iHeight = height;
	SetTitle(title);
	xcb_map_window(m_pConnection, m_Window);
	xcb_flush(m_pConnection);
	return true;
}

void CWindow::SetTitle(const std::string& title)
{
	xcb_change_property(m_pConnection, XCB_PROP_MODE_REPLACE, m_Window, XCB_ATOM_WM_NAME, XCB_ATOM_STRING, 8,
		u32(title.size()), title.data());
	xcb_flush(m_pConnection);
}

void CWindow::Poll(std::vector<sEvent>& out)
{
	while (xcb_generic_event_t* raw = xcb_poll_for_event(m_pConnection))
	{
		sEvent event;
		switch (raw->response_type & 0x7f)
		{
		case XCB_KEY_PRESS:
			event.m_eType = EVENT_KEY;
			event.m_eKey = KeyOf(reinterpret_cast<xcb_key_press_event_t*>(raw)->detail);
			out.push_back(event);
			break;
		case XCB_BUTTON_PRESS:
		case XCB_BUTTON_RELEASE:
		{
			const auto* button = reinterpret_cast<xcb_button_press_event_t*>(raw);
			if (button->detail == 1)
			{
				event.m_eType = (raw->response_type & 0x7f) == XCB_BUTTON_PRESS ? EVENT_PRESS : EVENT_RELEASE;
				event.m_iX = button->event_x;
				event.m_iY = button->event_y;
				out.push_back(event);
			}
			break;
		}
		case XCB_MOTION_NOTIFY:
		{
			const auto* motion = reinterpret_cast<xcb_motion_notify_event_t*>(raw);
			event.m_eType = EVENT_MOTION;
			event.m_iX = motion->event_x;
			event.m_iY = motion->event_y;
			out.push_back(event);
			break;
		}
		case XCB_CONFIGURE_NOTIFY:
		{
			const auto* configure = reinterpret_cast<xcb_configure_notify_event_t*>(raw);
			if (configure->width != m_iWidth || configure->height != m_iHeight)
			{
				m_iWidth = configure->width;
				m_iHeight = configure->height;
				event.m_eType = EVENT_RESIZE;
				out.push_back(event);
			}
			break;
		}
		case XCB_EXPOSE:
			event.m_eType = EVENT_RESIZE;
			out.push_back(event);
			break;
		case XCB_CLIENT_MESSAGE:
			if (reinterpret_cast<xcb_client_message_event_t*>(raw)->data.data32[0] == m_DeleteAtom)
			{
				event.m_eType = EVENT_CLOSE;
				out.push_back(event);
			}
			break;
		default:
			break;
		}
		std::free(raw);
	}
	if (xcb_connection_has_error(m_pConnection))
	{
		sEvent event;
		event.m_eType = EVENT_CLOSE;
		out.push_back(event);
	}
}

void* CWindow::Display() const
{
	return m_pConnection;
}

uint64_t CWindow::Handle() const
{
	return m_Window;
}

void CWindow::Destroy()
{
	if (m_pConnection)
	{
		if (m_Window)
		{
			xcb_destroy_window(m_pConnection, m_Window);
		}
		xcb_disconnect(m_pConnection);
		m_pConnection = nullptr;
	}
}

#endif

std::string Title(const aep::CPlaybackSession& session, f64 fps)
{
	const aep::sCompInfo* comp = session.Comp();
	const aep::sSessionStats& stats = session.Stats();
	char text[256];
	std::snprintf(text, sizeof(text), "%s  %lld/%lld  1/%d  %.0f fps  plan %.2f ms  render %.2f ms%s",
		comp ? comp->m_Name.c_str() : "", (long long)session.Frame() + 1, (long long)session.FrameCount(),
		session.Resolution(), fps, stats.m_fPlanMs, stats.m_fRenderMs, session.Playing() ? "" : "  (paused)");
	return text;
}

} /** namespace */

int main(int argc, char** argv)
{
	std::string path, compName;
	s32 divisor = 1;
	s64 frameLimit = 0;
	bool expressions = false;
	bool play = false;
	bool vsync = true;
	bool benchmark = false;
	for (s32 i = 1; i < argc; i++)
	{
		if (!std::strcmp(argv[i], "--comp") && i + 1 < argc)
		{
			compName = argv[++i];
		}
		else if (!std::strcmp(argv[i], "--resolution") && i + 1 < argc)
		{
			divisor = std::atoi(argv[++i]);
		}
		else if (!std::strcmp(argv[i], "--frames") && i + 1 < argc)
		{
			frameLimit = std::atoll(argv[++i]);
			play = true;
		}
		else if (!std::strcmp(argv[i], "--expressions"))
		{
			expressions = true;
		}
		else if (!std::strcmp(argv[i], "--play"))
		{
			play = true;
		}
		else if (!std::strcmp(argv[i], "--benchmark"))
		{
			benchmark = true;
		}
		else if (!std::strcmp(argv[i], "--no-vsync"))
		{
			vsync = false;
		}
		else
		{
			path = argv[i];
		}
	}
	if (path.empty())
	{
		std::fprintf(stderr,
			"usage: aep-viewer [--comp name] [--resolution 1-4] [--expressions] [--play] [--no-vsync] [--benchmark] "
			"[--frames n] project.aep\n");
		return 2;
	}

	std::ifstream file(path, std::ios::binary);
	std::vector<u8> bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
	if (bytes.empty())
	{
		std::fprintf(stderr, "%s could not be read\n", path.c_str());
		return 1;
	}

	std::string error;
	aevk::EngineOptions options;
	options.presentation = true;
	options.vsync = vsync;
	std::unique_ptr<aevk::Engine> engine = aevk::Engine::create(options, error);
	if (!engine)
	{
		std::fprintf(stderr, "no Vulkan device: %s\n", error.c_str());
		return 1;
	}
	std::unique_ptr<aep::CPlaybackSession> session =
		aep::CPlaybackSession::Create(*engine, std::move(bytes), expressions, benchmark ? 1 : size_t(1) << 30, error);
	if (!session)
	{
		std::fprintf(stderr, "%s: %s\n", path.c_str(), error.c_str());
		return 1;
	}
	u32 compId = session->DefaultComp();
	for (const aep::sCompInfo& info : session->Comps())
	{
		if (!compName.empty() && info.m_Name == compName)
		{
			compId = info.m_uId;
		}
	}
	if (!compId || !session->SelectComp(compId))
	{
		std::fprintf(stderr, "%s has no comp to play\n", path.c_str());
		return 1;
	}
	session->SetResolution(divisor);

	const aep::sCompInfo& comp = *session->Comp();
	/** Fits the comp in 1280x720, scaling small comps up as far as four times. */
	const f64 fit = std::min(4.0, std::min(1280.0 / comp.m_fWidth, 720.0 / comp.m_fHeight));
	CWindow window;
	if (!window.Create(std::max(160, s32(comp.m_fWidth * fit)), std::max(90, s32(comp.m_fHeight * fit)), comp.m_Name, error) ||
		!engine->attachDesktopWindow(window.Display(), window.Handle(), error))
	{
		std::fprintf(stderr, "%s\n", error.c_str());
		return 1;
	}
	std::fprintf(stderr, "%s on %s\n", comp.m_Name.c_str(), engine->device().name.c_str());
	session->SetPlaying(play && !benchmark, Now());

	bool running = true;
	bool scrubbing = false;
	f64 fps = 0;
	f64 lastPresent = 0;
	f64 lastTitle = 0;
	const f64 started = Now();
	/** Ticks so far; in benchmark mode each one tries the next frame, drawable or not. */
	s64 attempted = 0;
	std::string lastError;
	std::vector<sEvent> events;
	while (running)
	{
		events.clear();
		window.Poll(events);
		const f64 now = Now();
		for (const sEvent& event : events)
		{
			switch (event.m_eType)
			{
			case EVENT_CLOSE:
				running = false;
				break;
			case EVENT_RESIZE:
				session->Invalidate();
				break;
			case EVENT_PRESS:
			case EVENT_MOTION:
				scrubbing = scrubbing || event.m_eType == EVENT_PRESS;
				if (scrubbing && window.Width() > 0)
				{
					const f64 at = std::max(0.0, std::min(1.0, f64(event.m_iX) / window.Width()));
					session->Seek(at * session->Comp()->m_fDuration, now);
				}
				break;
			case EVENT_RELEASE:
				scrubbing = false;
				break;
			case EVENT_KEY:
				switch (event.m_eKey)
				{
				case KEY_SPACE: session->SetPlaying(!session->Playing(), now); break;
				case KEY_LEFT: session->Step(-1, now); break;
				case KEY_RIGHT: session->Step(1, now); break;
				case KEY_HOME: session->Seek(0, now); break;
				case KEY_1: session->SetResolution(1); break;
				case KEY_2: session->SetResolution(2); break;
				case KEY_3: session->SetResolution(3); break;
				case KEY_4: session->SetResolution(4); break;
				case KEY_QUIT: running = false; break;
				case KEY_PAGE_UP:
				case KEY_PAGE_DOWN:
				{
					const std::vector<aep::sCompInfo>& comps = session->Comps();
					auto it = std::find_if(comps.begin(), comps.end(),
						[&](const aep::sCompInfo& info) { return info.m_uId == session->Comp()->m_uId; });
					const s32 count = s32(comps.size());
					const s32 index = s32(it - comps.begin()) + (event.m_eKey == KEY_PAGE_DOWN ? 1 : -1);
					session->SelectComp(comps[size_t((index % count + count) % count)].m_uId);
					break;
				}
				default: break;
				}
				break;
			}
		}

		if (benchmark && attempted > 0)
		{
			session->Step(1, now);
		}
		attempted++;
		const f64 budgetMs = benchmark ? 0 : 1000.0 / std::max(1.0, session->Comp()->m_fFrameRate);
		const bool presented = session->Tick(now, budgetMs, error);
		if (!error.empty() && error != lastError)
		{
			std::fprintf(stderr, "%s\n", error.c_str());
		}
		lastError = error;
		if (presented)
		{
			if (lastPresent > 0)
			{
				const f64 instant = 1.0 / std::max(1e-6, now - lastPresent);
				fps = fps > 0 ? fps + (instant - fps) * 0.1 : instant;
			}
			lastPresent = now;
		}
		if (now - lastTitle > 0.25)
		{
			window.SetTitle(Title(*session, fps));
			lastTitle = now;
		}
		if (frameLimit > 0 && (benchmark ? attempted : session->Stats().m_iShown) >= frameLimit)
		{
			running = false;
		}
		if (!presented && !benchmark)
		{
			/** Nothing was presented, so nothing waited for the display: idle instead of spinning. */
			std::this_thread::sleep_for(std::chrono::milliseconds(session->Playing() ? 2 : 4));
		}
	}

	const aep::sSessionStats& stats = session->Stats();
	const f64 seconds = Now() - started;
	std::printf("{\"comp\":\"%s\",\"size\":\"%.0fx%.0f\",\"device\":\"%s\",\"resolution\":%d,\"shown\":%lld,\"dropped\":%lld,\"unsupported\":%lld,"
				"\"seconds\":%.3f,\"fps\":%.2f,\"planMs\":%.3f,\"renderMs\":%.3f,\"expressionStartupMs\":%.1f}\n",
		comp.m_Name.c_str(), comp.m_fWidth, comp.m_fHeight, engine->device().name.c_str(), session->Resolution(), (long long)stats.m_iShown,
		(long long)stats.m_iDropped, (long long)stats.m_iUnsupported, seconds, stats.m_iShown / std::max(seconds, 1e-6),
		stats.m_fPlanMs, stats.m_fRenderMs, stats.m_fExpressionStartupMs);
	session.reset();
	engine->detachWindow();
	return 0;
}
