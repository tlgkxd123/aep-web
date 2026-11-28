/**
 * The desktop app: the interface in native/ui (Dear ImGui over the C++ core and the Vulkan engine) in a window of the
 * platform's own window system. Linux (xcb) and Windows (Win32).
 *
 *   aep-app [--scale s] [--no-vsync] [--play] [project.aep]
 *
 * Without a project it opens on the home screen, where File > Open (Ctrl+O) browses for one. --scale sets the interface
 * scale (otherwise the display's density, or AEP_UI_SCALE); --play starts playing the project's first comp.
 */
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <memory>
#include <string>
#include <thread>

#include "app.h"
#include "engine.h"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <windowsx.h>
#else
#include <xcb/xcb.h>
#endif

namespace
{

using aep::f32;
using aep::f64;
using aep::s32;
using aep::u32;

f64 Now()
{
	return std::chrono::duration<f64>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

/**
 * One top-level window whose input goes straight into Dear ImGui's IO: the pointer, its buttons and wheel, keys and the
 * characters they type.
 */
class CAppWindow
{
public:
	~CAppWindow() { Destroy(); }

	bool Create(s32 width, s32 height, const char* title, std::string& error);
	/** Feeds the events waiting now into Dear ImGui; true when there were any. Waits up to `waitMs` for one first. */
	bool Poll(s32 waitMs);
	bool Closed() const { return m_bClosed; }
	s32 Width() const { return m_iWidth; }
	s32 Height() const { return m_iHeight; }
	/** The display's density as an interface scale (1 at 96 dpi). */
	f32 Scale() const;
	void* Display() const;
	uint64_t Handle() const;

private:
	void Destroy();

	s32 m_iWidth = 0;
	s32 m_iHeight = 0;
	bool m_bClosed = false;
#if defined(_WIN32)
	static LRESULT CALLBACK Proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam);
	HINSTANCE m_hInstance = nullptr;
	HWND m_hWnd = nullptr;
	bool m_bEvents = false;
#else
	bool Handle(xcb_generic_event_t* raw);
	xcb_connection_t* m_pConnection = nullptr;
	xcb_screen_t* m_pScreen = nullptr;
	xcb_window_t m_Window = 0;
	xcb_atom_t m_DeleteAtom = 0;
	xcb_atom_t Atom(const char* name);
	bool m_bShift = false;
#endif
};

#if defined(_WIN32)

ImGuiKey KeyOf(WPARAM key)
{
	if (key >= '0' && key <= '9')
	{
		return ImGuiKey(ImGuiKey_0 + (key - '0'));
	}
	if (key >= 'A' && key <= 'Z')
	{
		return ImGuiKey(ImGuiKey_A + (key - 'A'));
	}
	if (key >= VK_F1 && key <= VK_F12)
	{
		return ImGuiKey(ImGuiKey_F1 + (key - VK_F1));
	}
	switch (key)
	{
	case VK_TAB: return ImGuiKey_Tab;
	case VK_LEFT: return ImGuiKey_LeftArrow;
	case VK_RIGHT: return ImGuiKey_RightArrow;
	case VK_UP: return ImGuiKey_UpArrow;
	case VK_DOWN: return ImGuiKey_DownArrow;
	case VK_PRIOR: return ImGuiKey_PageUp;
	case VK_NEXT: return ImGuiKey_PageDown;
	case VK_HOME: return ImGuiKey_Home;
	case VK_END: return ImGuiKey_End;
	case VK_INSERT: return ImGuiKey_Insert;
	case VK_DELETE: return ImGuiKey_Delete;
	case VK_BACK: return ImGuiKey_Backspace;
	case VK_SPACE: return ImGuiKey_Space;
	case VK_RETURN: return ImGuiKey_Enter;
	case VK_ESCAPE: return ImGuiKey_Escape;
	case VK_SHIFT: return ImGuiKey_LeftShift;
	case VK_CONTROL: return ImGuiKey_LeftCtrl;
	case VK_MENU: return ImGuiKey_LeftAlt;
	default: return ImGuiKey_None;
	}
}

LRESULT CALLBACK CAppWindow::Proc(HWND hwnd, UINT message, WPARAM wparam, LPARAM lparam)
{
	CAppWindow* self = reinterpret_cast<CAppWindow*>(GetWindowLongPtrA(hwnd, GWLP_USERDATA));
	if (!self || !ImGui::GetCurrentContext())
	{
		return DefWindowProcW(hwnd, message, wparam, lparam);
	}
	ImGuiIO& io = ImGui::GetIO();
	self->m_bEvents = true;
	switch (message)
	{
	case WM_CLOSE:
		self->m_bClosed = true;
		return 0;
	case WM_SIZE:
		self->m_iWidth = s32(LOWORD(lparam));
		self->m_iHeight = s32(HIWORD(lparam));
		return 0;
	case WM_MOUSEMOVE:
		io.AddMousePosEvent(f32(GET_X_LPARAM(lparam)), f32(GET_Y_LPARAM(lparam)));
		return 0;
	case WM_MOUSELEAVE:
		io.AddMousePosEvent(-FLT_MAX, -FLT_MAX);
		return 0;
	case WM_LBUTTONDOWN:
	case WM_RBUTTONDOWN:
	case WM_MBUTTONDOWN:
	case WM_LBUTTONDBLCLK:
	case WM_RBUTTONDBLCLK:
	case WM_MBUTTONDBLCLK:
		SetCapture(hwnd);
		io.AddMouseButtonEvent(message == WM_LBUTTONDOWN || message == WM_LBUTTONDBLCLK ? 0 : message == WM_RBUTTONDOWN || message == WM_RBUTTONDBLCLK ? 1 : 2,
			true);
		return 0;
	case WM_LBUTTONUP:
	case WM_RBUTTONUP:
	case WM_MBUTTONUP:
		ReleaseCapture();
		io.AddMouseButtonEvent(message == WM_LBUTTONUP ? 0 : message == WM_RBUTTONUP ? 1 : 2, false);
		return 0;
	case WM_MOUSEWHEEL:
		io.AddMouseWheelEvent(0, f32(GET_WHEEL_DELTA_WPARAM(wparam)) / WHEEL_DELTA);
		return 0;
	case WM_MOUSEHWHEEL:
		io.AddMouseWheelEvent(-f32(GET_WHEEL_DELTA_WPARAM(wparam)) / WHEEL_DELTA, 0);
		return 0;
	case WM_KEYDOWN:
	case WM_KEYUP:
	case WM_SYSKEYDOWN:
	case WM_SYSKEYUP:
	{
		const bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
		io.AddKeyEvent(ImGuiMod_Ctrl, (GetKeyState(VK_CONTROL) & 0x8000) != 0);
		io.AddKeyEvent(ImGuiMod_Shift, (GetKeyState(VK_SHIFT) & 0x8000) != 0);
		io.AddKeyEvent(ImGuiMod_Alt, (GetKeyState(VK_MENU) & 0x8000) != 0);
		const ImGuiKey key = KeyOf(wparam);
		if (key != ImGuiKey_None)
		{
			io.AddKeyEvent(key, down);
		}
		if (message == WM_SYSKEYDOWN || message == WM_SYSKEYUP)
		{
			break;
		}
		return 0;
	}
	case WM_CHAR:
		if (wparam > 0 && wparam < 0x10000)
		{
			io.AddInputCharacterUTF16(unsigned short(wparam));
		}
		return 0;
	case WM_SETFOCUS:
	case WM_KILLFOCUS:
		io.AddFocusEvent(message == WM_SETFOCUS);
		return 0;
	case WM_SETCURSOR:
		if (LOWORD(lparam) == HTCLIENT)
		{
			static const LPCTSTR s_Cursors[] = { IDC_ARROW, IDC_IBEAM, IDC_SIZEALL, IDC_SIZENS, IDC_SIZEWE, IDC_SIZENESW, IDC_SIZENWSE, IDC_HAND, IDC_NO };
			const ImGuiMouseCursor cursor = ImGui::GetMouseCursor();
			SetCursor(LoadCursor(nullptr, cursor >= 0 && cursor < ImGuiMouseCursor_COUNT ? s_Cursors[cursor] : IDC_ARROW));
			return TRUE;
		}
		break;
	default:
		break;
	}
	return DefWindowProcW(hwnd, message, wparam, lparam);
}

bool CAppWindow::Create(s32 width, s32 height, const char* title, std::string& error)
{
	m_hInstance = GetModuleHandleW(nullptr);
	WNDCLASSEXW windowClass = {};
	windowClass.cbSize = sizeof(windowClass);
	windowClass.style = CS_HREDRAW | CS_VREDRAW | CS_DBLCLKS;
	windowClass.lpfnWndProc = Proc;
	windowClass.hInstance = m_hInstance;
	windowClass.hCursor = LoadCursor(nullptr, IDC_ARROW);
	windowClass.lpszClassName = L"aep-app";
	RegisterClassExW(&windowClass);
	const f32 scale = Scale();
	RECT rect = { 0, 0, LONG(width * scale), LONG(height * scale) };
	AdjustWindowRect(&rect, WS_OVERLAPPEDWINDOW, FALSE);
	wchar_t wide[256] = {};
	MultiByteToWideChar(CP_UTF8, 0, title, -1, wide, 255);
	m_hWnd = CreateWindowExW(0, L"aep-app", wide, WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, rect.right - rect.left,
		rect.bottom - rect.top, nullptr, nullptr, m_hInstance, nullptr);
	if (!m_hWnd)
	{
		error = "the window could not be created";
		return false;
	}
	SetWindowLongPtrA(m_hWnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
	RECT client;
	GetClientRect(m_hWnd, &client);
	m_iWidth = client.right - client.left;
	m_iHeight = client.bottom - client.top;
	ShowWindow(m_hWnd, SW_SHOW);
	return true;
}

bool CAppWindow::Poll(s32 waitMs)
{
	m_bEvents = false;
	if (waitMs > 0)
	{
		MsgWaitForMultipleObjects(0, nullptr, FALSE, DWORD(waitMs), QS_ALLINPUT);
	}
	MSG message;
	while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE))
	{
		TranslateMessage(&message);
		DispatchMessageW(&message);
	}
	return m_bEvents;
}

f32 CAppWindow::Scale() const
{
	HDC dc = GetDC(nullptr);
	const s32 dpi = GetDeviceCaps(dc, LOGPIXELSX);
	ReleaseDC(nullptr, dc);
	return std::max(1.0f, f32(dpi) / 96);
}

void* CAppWindow::Display() const
{
	return m_hInstance;
}

uint64_t CAppWindow::Handle() const
{
	return uint64_t(reinterpret_cast<uintptr_t>(m_hWnd));
}

void CAppWindow::Destroy()
{
	if (m_hWnd)
	{
		DestroyWindow(m_hWnd);
		m_hWnd = nullptr;
	}
}

#else

/**
 * A key by its X key code. These are the evdev codes every current X server (Xorg, Xwayland, Xvfb) reports; the
 * characters are those of a US layout, which is what the app needs without a keyboard-mapping library (typed text is a
 * folder path in the file browser).
 */
struct sKeyCode
{
	ImGuiKey m_eKey;
	char m_cLower;
	char m_cUpper;
};

sKeyCode KeyOf(xcb_keycode_t code)
{
	static const char* const s_Rows[] = { "1234567890-=", "qwertyuiop[]", "asdfghjkl;'`", "\\zxcvbnm,./" };
	static const char* const s_Shifted[] = { "!@#$%^&*()_+", "QWERTYUIOP{}", "ASDFGHJKL:\"~", "|ZXCVBNM<>?" };
	static const u32 s_First[] = { 10, 24, 38, 51 };
	for (u32 row = 0; row < 4; row++)
	{
		const u32 length = u32(std::strlen(s_Rows[row]));
		if (code >= s_First[row] && code < s_First[row] + length)
		{
			const char c = s_Rows[row][code - s_First[row]];
			ImGuiKey key = ImGuiKey_None;
			if (c >= 'a' && c <= 'z')
			{
				key = ImGuiKey(ImGuiKey_A + (c - 'a'));
			}
			else if (c >= '1' && c <= '9')
			{
				key = ImGuiKey(ImGuiKey_1 + (c - '1'));
			}
			else if (c == '0')
			{
				key = ImGuiKey_0;
			}
			return { key, c, s_Shifted[row][code - s_First[row]] };
		}
	}
	switch (code)
	{
	case 9: return { ImGuiKey_Escape, 0, 0 };
	case 22: return { ImGuiKey_Backspace, 0, 0 };
	case 23: return { ImGuiKey_Tab, 0, 0 };
	case 36: return { ImGuiKey_Enter, 0, 0 };
	case 104: return { ImGuiKey_KeypadEnter, 0, 0 };
	case 65: return { ImGuiKey_Space, ' ', ' ' };
	case 37: return { ImGuiKey_LeftCtrl, 0, 0 };
	case 105: return { ImGuiKey_RightCtrl, 0, 0 };
	case 50: return { ImGuiKey_LeftShift, 0, 0 };
	case 62: return { ImGuiKey_RightShift, 0, 0 };
	case 64: return { ImGuiKey_LeftAlt, 0, 0 };
	case 108: return { ImGuiKey_RightAlt, 0, 0 };
	case 110: return { ImGuiKey_Home, 0, 0 };
	case 111: return { ImGuiKey_UpArrow, 0, 0 };
	case 112: return { ImGuiKey_PageUp, 0, 0 };
	case 113: return { ImGuiKey_LeftArrow, 0, 0 };
	case 114: return { ImGuiKey_RightArrow, 0, 0 };
	case 115: return { ImGuiKey_End, 0, 0 };
	case 116: return { ImGuiKey_DownArrow, 0, 0 };
	case 117: return { ImGuiKey_PageDown, 0, 0 };
	case 118: return { ImGuiKey_Insert, 0, 0 };
	case 119: return { ImGuiKey_Delete, 0, 0 };
	default: break;
	}
	if (code >= 67 && code <= 76)
	{
		return { ImGuiKey(ImGuiKey_F1 + (code - 67)), 0, 0 };
	}
	return { ImGuiKey_None, 0, 0 };
}

xcb_atom_t CAppWindow::Atom(const char* name)
{
	xcb_intern_atom_reply_t* reply =
		xcb_intern_atom_reply(m_pConnection, xcb_intern_atom(m_pConnection, 0, u32(std::strlen(name)), name), nullptr);
	const xcb_atom_t atom = reply ? reply->atom : 0;
	std::free(reply);
	return atom;
}

bool CAppWindow::Create(s32 width, s32 height, const char* title, std::string& error)
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
	m_pScreen = screens.data;
	const f32 scale = Scale();
	width = std::min(s32(width * scale), s32(m_pScreen->width_in_pixels));
	height = std::min(s32(height * scale), s32(m_pScreen->height_in_pixels));
	m_Window = xcb_generate_id(m_pConnection);
	const u32 mask = XCB_CW_BACK_PIXEL | XCB_CW_EVENT_MASK;
	const u32 values[2] = { m_pScreen->black_pixel,
		XCB_EVENT_MASK_KEY_PRESS | XCB_EVENT_MASK_KEY_RELEASE | XCB_EVENT_MASK_BUTTON_PRESS | XCB_EVENT_MASK_BUTTON_RELEASE |
			XCB_EVENT_MASK_POINTER_MOTION | XCB_EVENT_MASK_LEAVE_WINDOW | XCB_EVENT_MASK_FOCUS_CHANGE |
			XCB_EVENT_MASK_STRUCTURE_NOTIFY | XCB_EVENT_MASK_EXPOSURE };
	xcb_create_window(m_pConnection, XCB_COPY_FROM_PARENT, m_Window, m_pScreen->root, 0, 0, u32(width), u32(height), 0,
		XCB_WINDOW_CLASS_INPUT_OUTPUT, m_pScreen->root_visual, mask, values);
	const xcb_atom_t protocols = Atom("WM_PROTOCOLS");
	m_DeleteAtom = Atom("WM_DELETE_WINDOW");
	xcb_change_property(m_pConnection, XCB_PROP_MODE_REPLACE, m_Window, protocols, XCB_ATOM_ATOM, 32, 1, &m_DeleteAtom);
	xcb_change_property(m_pConnection, XCB_PROP_MODE_REPLACE, m_Window, XCB_ATOM_WM_NAME, XCB_ATOM_STRING, 8, u32(std::strlen(title)), title);
	m_iWidth = width;
	m_iHeight = height;
	xcb_map_window(m_pConnection, m_Window);
	xcb_flush(m_pConnection);
	return true;
}

bool CAppWindow::Handle(xcb_generic_event_t* raw)
{
	ImGuiIO& io = ImGui::GetIO();
	switch (raw->response_type & 0x7f)
	{
	case XCB_KEY_PRESS:
	case XCB_KEY_RELEASE:
	{
		const auto* key = reinterpret_cast<xcb_key_press_event_t*>(raw);
		const bool down = (raw->response_type & 0x7f) == XCB_KEY_PRESS;
		io.AddKeyEvent(ImGuiMod_Ctrl, (key->state & XCB_MOD_MASK_CONTROL) != 0);
		io.AddKeyEvent(ImGuiMod_Shift, (key->state & XCB_MOD_MASK_SHIFT) != 0);
		io.AddKeyEvent(ImGuiMod_Alt, (key->state & XCB_MOD_MASK_1) != 0);
		const sKeyCode code = KeyOf(key->detail);
		if (code.m_eKey == ImGuiKey_LeftShift || code.m_eKey == ImGuiKey_RightShift)
		{
			m_bShift = down;
		}
		if (code.m_eKey != ImGuiKey_None)
		{
			io.AddKeyEvent(code.m_eKey, down);
		}
		const bool shift = (key->state & XCB_MOD_MASK_SHIFT) != 0 || m_bShift;
		const bool caps = (key->state & XCB_MOD_MASK_LOCK) != 0 && code.m_cLower >= 'a' && code.m_cLower <= 'z';
		if (down && code.m_cLower && !(key->state & XCB_MOD_MASK_CONTROL))
		{
			io.AddInputCharacter(u32(shift != caps ? code.m_cUpper : code.m_cLower));
		}
		return true;
	}
	case XCB_BUTTON_PRESS:
	case XCB_BUTTON_RELEASE:
	{
		const auto* button = reinterpret_cast<xcb_button_press_event_t*>(raw);
		const bool down = (raw->response_type & 0x7f) == XCB_BUTTON_PRESS;
		io.AddMousePosEvent(f32(button->event_x), f32(button->event_y));
		switch (button->detail)
		{
		case 1: io.AddMouseButtonEvent(0, down); break;
		case 2: io.AddMouseButtonEvent(2, down); break;
		case 3: io.AddMouseButtonEvent(1, down); break;
		case 4: if (down) io.AddMouseWheelEvent(0, 1); break;
		case 5: if (down) io.AddMouseWheelEvent(0, -1); break;
		case 6: if (down) io.AddMouseWheelEvent(1, 0); break;
		case 7: if (down) io.AddMouseWheelEvent(-1, 0); break;
		default: break;
		}
		return true;
	}
	case XCB_MOTION_NOTIFY:
	{
		const auto* motion = reinterpret_cast<xcb_motion_notify_event_t*>(raw);
		io.AddMousePosEvent(f32(motion->event_x), f32(motion->event_y));
		return true;
	}
	case XCB_LEAVE_NOTIFY:
		io.AddMousePosEvent(-FLT_MAX, -FLT_MAX);
		return true;
	case XCB_FOCUS_IN:
	case XCB_FOCUS_OUT:
		io.AddFocusEvent((raw->response_type & 0x7f) == XCB_FOCUS_IN);
		return true;
	case XCB_CONFIGURE_NOTIFY:
	{
		const auto* configure = reinterpret_cast<xcb_configure_notify_event_t*>(raw);
		m_iWidth = configure->width;
		m_iHeight = configure->height;
		return true;
	}
	case XCB_EXPOSE:
		return true;
	case XCB_CLIENT_MESSAGE:
		if (reinterpret_cast<xcb_client_message_event_t*>(raw)->data.data32[0] == m_DeleteAtom)
		{
			m_bClosed = true;
		}
		return true;
	default:
		return false;
	}
}

bool CAppWindow::Poll(s32 waitMs)
{
	bool any = false;
	const f64 until = Now() + waitMs / 1000.0;
	for (;;)
	{
		while (xcb_generic_event_t* raw = xcb_poll_for_event(m_pConnection))
		{
			any = Handle(raw) || any;
			std::free(raw);
		}
		if (xcb_connection_has_error(m_pConnection))
		{
			m_bClosed = true;
			return true;
		}
		if (any || Now() >= until)
		{
			return any;
		}
		std::this_thread::sleep_for(std::chrono::milliseconds(2));
	}
}

f32 CAppWindow::Scale() const
{
	if (const char* scale = std::getenv("AEP_UI_SCALE"))
	{
		return std::clamp(f32(std::atof(scale)), 0.5f, 4.0f);
	}
	if (!m_pScreen || !m_pScreen->width_in_millimeters)
	{
		return 1;
	}
	/** The screen's density, in quarter steps; X servers that do not know it report 96 dpi. */
	const f32 dpi = f32(m_pScreen->width_in_pixels) * 25.4f / f32(m_pScreen->width_in_millimeters);
	return std::clamp(std::round(dpi / 96 * 4) / 4, 1.0f, 3.0f);
}

void* CAppWindow::Display() const
{
	return m_pConnection;
}

uint64_t CAppWindow::Handle() const
{
	return m_Window;
}

void CAppWindow::Destroy()
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

/** Where the recent list is kept: %APPDATA%\aep on Windows, $XDG_CONFIG_HOME/aep (~/.config/aep) elsewhere. */
std::string SettingsFolder()
{
#if defined(_WIN32)
	if (const char* appData = std::getenv("APPDATA"))
	{
		return std::string(appData) + "\\aep";
	}
#else
	if (const char* config = std::getenv("XDG_CONFIG_HOME"); config && config[0])
	{
		return std::string(config) + "/aep";
	}
	if (const char* home = std::getenv("HOME"))
	{
		return std::string(home) + "/.config/aep";
	}
#endif
	return "";
}

} /** namespace */

int main(int argc, char** argv)
{
	std::string path;
	f32 scale = 0;
	bool vsync = true;
	bool play = false;
	for (s32 i = 1; i < argc; i++)
	{
		if (!std::strcmp(argv[i], "--scale") && i + 1 < argc)
		{
			scale = f32(std::atof(argv[++i]));
		}
		else if (!std::strcmp(argv[i], "--no-vsync"))
		{
			vsync = false;
		}
		else if (!std::strcmp(argv[i], "--play"))
		{
			play = true;
		}
		else if (argv[i][0] == '-')
		{
			std::fprintf(stderr, "usage: aep-app [--scale s] [--no-vsync] [--play] [project.aep]\n");
			return 2;
		}
		else
		{
			path = argv[i];
		}
	}

	std::string error;
	CAppWindow window;
	if (!window.Create(1440, 900, "aep", error))
	{
		std::fprintf(stderr, "%s\n", error.c_str());
		return 1;
	}
	aevk::EngineOptions options;
	options.presentation = true;
	options.vsync = vsync;
	std::unique_ptr<aevk::Engine> engine = aevk::Engine::create(options, error);
	if (!engine || !engine->attachDesktopWindow(window.Display(), window.Handle(), error))
	{
		std::fprintf(stderr, "no Vulkan device: %s\n", error.c_str());
		return 1;
	}

	aep::sAppHost host;
	host.m_fScale = scale > 0 ? scale : window.Scale();
	host.m_SettingsFolder = SettingsFolder();
#if defined(_WIN32)
	host.m_Platform = "Windows";
#else
	host.m_Platform = "Linux";
#endif
	{
		aep::CApp app(*engine, host);
		if (!app.Init(error))
		{
			std::fprintf(stderr, "the interface could not start: %s\n", error.c_str());
			return 1;
		}
		if (!path.empty() && app.OpenFile(std::filesystem::weakly_canonical(std::filesystem::absolute(path)).string()) && play)
		{
			app.Frame(Now(), window.Width(), window.Height());
			app.SetPlaying(true);
		}
		/** Frames to draw after input settles: Dear ImGui finishes some changes (popups, hover) a frame or two later. */
		s32 settle = 3;
		s32 width = window.Width();
		s32 height = window.Height();
		for (;;)
		{
			const bool busy = app.Busy() || settle > 0;
			if (window.Poll(busy ? 0 : 50))
			{
				settle = 3;
			}
			if (window.Closed())
			{
				break;
			}
			if (!busy && settle <= 0)
			{
				continue;
			}
			settle--;
			if (window.Width() <= 0 || window.Height() <= 0)
			{
				continue;
			}
			if (window.Width() != width || window.Height() != height)
			{
				width = window.Width();
				height = window.Height();
				engine->windowResized();
			}
			if (!app.Frame(Now(), window.Width(), window.Height()))
			{
				break;
			}
		}
	}
	engine->detachWindow();
	return 0;
}
