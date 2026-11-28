/**
 * The Android app's native screen (android/.../NativeAppActivity.java): the interface in native/ui, the same one the
 * desktop app has, drawn by the engine into the activity's SurfaceView. Everything the app does runs on one thread
 * driven by the display's frame clock (AChoreographer); the activity's calls (touches, the surface, a project the user
 * picked, the back button) are queued for it and handled at the start of the next frame.
 */
#include <android/choreographer.h>
#include <android/log.h>
#include <android/looper.h>
#include <android/native_window.h>
#include <android/native_window_jni.h>
#include <dlfcn.h>
#include <jni.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <deque>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "app.h"
#include "engine.h"

namespace aep
{

namespace
{

f64 Now()
{
	return std::chrono::duration<f64>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

/** JavaVM::AttachCurrentThread takes JNIEnv** in the NDK's jni.h and void** in the JDK's; both are served. */
template <typename V>
auto AttachImpl(V* vm, JNIEnv** env, int) -> decltype(vm->AttachCurrentThread(env, nullptr))
{
	return vm->AttachCurrentThread(env, nullptr);
}
template <typename V>
jint AttachImpl(V* vm, JNIEnv** env, long)
{
	return vm->AttachCurrentThread(reinterpret_cast<void**>(env), nullptr);
}
jint AttachThread(JavaVM* vm, JNIEnv** env)
{
	return AttachImpl(vm, env, 0);
}

enum eAppEvent
{
	APP_EVENT_TOUCH_DOWN,
	APP_EVENT_TOUCH_MOVE,
	APP_EVENT_TOUCH_UP,
	APP_EVENT_TOUCH_CANCEL,
	APP_EVENT_PINCH,
	APP_EVENT_SURFACE,
	APP_EVENT_SURFACE_CHANGED,
	APP_EVENT_SURFACE_LOST,
	APP_EVENT_OPEN,
	APP_EVENT_NOTIFY,
	APP_EVENT_SAFE_AREA,
	APP_EVENT_BACK,
};

struct sAppEvent
{
	eAppEvent m_eType = APP_EVENT_TOUCH_MOVE;
	f32 m_fX = 0;
	f32 m_fY = 0;
	/** A pinch's factor; a safe area's right and bottom insets are m_fZ and m_fW. */
	f32 m_fZ = 0;
	f32 m_fW = 0;
	ANativeWindow* m_pWindow = nullptr;
	std::string m_Name;
	std::vector<u8> m_Bytes;
	/** Answered once the loop has handled the event, for calls that wait (the surface going, the back button). */
	std::shared_ptr<std::promise<bool>> m_pDone;
};

} /** namespace */

/**
 * The app on its thread: the engine, the interface and the frame clock that drives them. The activity holds one per
 * screen, from onCreate to onDestroy.
 */
class CAndroidApp
{
public:
	CAndroidApp(JavaVM* vm, jobject activity, f32 density, std::string settingsFolder)
		: m_pVm(vm)
		, m_Activity(activity)
		, m_fDensity(density)
		, m_SettingsFolder(std::move(settingsFolder))
	{
	}
	~CAndroidApp() { Stop(); }

	CAndroidApp(const CAndroidApp&) = delete;
	CAndroidApp& operator=(const CAndroidApp&) = delete;

	/** Starts the thread and waits until the engine and interface exist; false with `error` set when they cannot. */
	bool Start(std::string& error);
	void Stop();
	/** Queues `event`; with `wait`, blocks until the loop handled it and returns its answer (false if it stopped). */
	bool Post(sAppEvent event, bool wait = false);

private:
	typedef void (*tPostFrameCallback64)(AChoreographer*, void (*)(int64_t, void*), void*);

	static void OnFrame64(int64_t frameTimeNanos, void* data);
	static void OnFrame(long frameTimeNanos, void* data);
	void Run();
	void Tick();
	void PostFrame();
	bool Handle(sAppEvent& event);
	void ChooseProject();
	bool SaveFile(const std::string& name, const std::vector<u8>& bytes, std::string& error);

	JavaVM* m_pVm = nullptr;
	/** A global reference to the activity; the loop thread calls its chooseProject and saveFile. */
	jobject m_Activity = nullptr;
	JNIEnv* m_pEnv = nullptr;
	f32 m_fDensity = 1;
	std::string m_SettingsFolder;

	std::thread m_Thread;
	std::atomic<bool> m_bRunning{ false };
	std::mutex m_StartLock;
	std::condition_variable m_Started;
	bool m_bReady = false;
	std::string m_StartError;
	ALooper* m_pLooper = nullptr;
	AChoreographer* m_pChoreographer = nullptr;
	tPostFrameCallback64 m_pPost64 = nullptr;

	std::mutex m_QueueLock;
	std::deque<sAppEvent> m_Queue;

	std::unique_ptr<aevk::Engine> m_pEngine;
	std::unique_ptr<CApp> m_pApp;
	ANativeWindow* m_pWindow = nullptr;
	s32 m_iWidth = 0;
	s32 m_iHeight = 0;
	/** Frames still to draw after input stops: Dear ImGui finishes some changes a frame or two later. */
	s32 m_iSettle = 3;
	/** A touch that ended this frame: the pointer leaves next frame, so nothing stays hovered. */
	bool m_bLiftPointer = false;
};

bool CAndroidApp::Start(std::string& error)
{
	if (m_bRunning.exchange(true))
	{
		return true;
	}
	std::unique_lock<std::mutex> guard(m_StartLock);
	m_bReady = false;
	m_Thread = std::thread([this] { Run(); });
	m_Started.wait(guard, [this] { return m_bReady; });
	if (!m_pApp)
	{
		error = m_StartError;
		guard.unlock();
		Stop();
		return false;
	}
	return true;
}

void CAndroidApp::Stop()
{
	if (!m_bRunning.exchange(false))
	{
		return;
	}
	{
		std::lock_guard<std::mutex> guard(m_StartLock);
		if (m_pLooper)
		{
			ALooper_wake(m_pLooper);
		}
	}
	if (m_Thread.joinable())
	{
		m_Thread.join();
	}
	/** Calls still waiting get their answer: there is nothing left to handle them. */
	std::lock_guard<std::mutex> guard(m_QueueLock);
	for (sAppEvent& event : m_Queue)
	{
		if (event.m_pWindow)
		{
			ANativeWindow_release(event.m_pWindow);
		}
		if (event.m_pDone)
		{
			event.m_pDone->set_value(false);
		}
	}
	m_Queue.clear();
}

bool CAndroidApp::Post(sAppEvent event, bool wait)
{
	std::future<bool> answer;
	if (wait)
	{
		event.m_pDone = std::make_shared<std::promise<bool>>();
		answer = event.m_pDone->get_future();
	}
	{
		std::lock_guard<std::mutex> guard(m_QueueLock);
		if (!m_bRunning.load())
		{
			if (event.m_pWindow)
			{
				ANativeWindow_release(event.m_pWindow);
			}
			return false;
		}
		m_Queue.push_back(std::move(event));
	}
	if (!wait)
	{
		return true;
	}
	/** The loop answers within a frame or two; a stuck GPU must not hang the activity's thread for ever. */
	if (answer.wait_for(std::chrono::seconds(4)) != std::future_status::ready)
	{
		return false;
	}
	return answer.get();
}

void CAndroidApp::Run()
{
	AttachThread(m_pVm, &m_pEnv);
	ALooper* looper = ALooper_prepare(0);
	ALooper_acquire(looper);
	m_pChoreographer = AChoreographer_getInstance();
	if (void* android = dlopen("libandroid.so", RTLD_NOW | RTLD_LOCAL))
	{
		m_pPost64 = reinterpret_cast<tPostFrameCallback64>(dlsym(android, "AChoreographer_postFrameCallback64"));
	}

	std::string error;
	aevk::EngineOptions options;
	options.presentation = true;
	options.vsync = true;
	/** A phone shares its memory with the GPU: keep the pool smaller than on desktop. */
	options.poolBudget = size_t(128) << 20;
	m_pEngine = aevk::Engine::create(options, error);
	if (m_pEngine)
	{
		sAppHost host;
		host.m_bTouch = true;
		host.m_fScale = m_fDensity;
		host.m_SettingsFolder = m_SettingsFolder;
		host.m_Platform = "Android";
		host.m_ChooseProject = [this] { ChooseProject(); };
		host.m_SaveFile = [this](const std::string& name, const std::vector<u8>& bytes, std::string& saveError) {
			return SaveFile(name, bytes, saveError);
		};
		m_pApp = std::make_unique<CApp>(*m_pEngine, std::move(host));
		if (!m_pApp->Init(error))
		{
			m_pApp.reset();
		}
	}
	{
		std::lock_guard<std::mutex> guard(m_StartLock);
		m_pLooper = looper;
		m_StartError = m_pEngine ? "the interface could not start: " + error : "no Vulkan device: " + error;
		m_bReady = true;
	}
	m_Started.notify_all();

	if (m_pApp)
	{
		PostFrame();
		while (m_bRunning.load())
		{
			ALooper_pollOnce(-1, nullptr, nullptr, nullptr);
		}
	}
	{
		std::lock_guard<std::mutex> guard(m_StartLock);
		m_pLooper = nullptr;
	}
	m_pApp.reset();
	if (m_pEngine && m_pWindow)
	{
		m_pEngine->detachWindow();
	}
	m_pEngine.reset();
	if (m_pWindow)
	{
		ANativeWindow_release(m_pWindow);
		m_pWindow = nullptr;
	}
	ALooper_release(looper);
	m_pVm->DetachCurrentThread();
}

void CAndroidApp::PostFrame()
{
	if (!m_pChoreographer || !m_bRunning.load())
	{
		return;
	}
	if (m_pPost64)
	{
		m_pPost64(m_pChoreographer, OnFrame64, this);
	}
	else
	{
		AChoreographer_postFrameCallback(m_pChoreographer, OnFrame, this);
	}
}

void CAndroidApp::OnFrame64(int64_t frameTimeNanos, void* data)
{
	(void)frameTimeNanos;
	static_cast<CAndroidApp*>(data)->Tick();
}

void CAndroidApp::OnFrame(long frameTimeNanos, void* data)
{
	(void)frameTimeNanos;
	static_cast<CAndroidApp*>(data)->Tick();
}

bool CAndroidApp::Handle(sAppEvent& event)
{
	ImGuiIO& io = ImGui::GetIO();
	switch (event.m_eType)
	{
	case APP_EVENT_TOUCH_DOWN:
		io.AddMouseSourceEvent(ImGuiMouseSource_TouchScreen);
		io.AddMousePosEvent(event.m_fX, event.m_fY);
		io.AddMouseButtonEvent(0, true);
		return true;
	case APP_EVENT_TOUCH_MOVE:
		io.AddMouseSourceEvent(ImGuiMouseSource_TouchScreen);
		io.AddMousePosEvent(event.m_fX, event.m_fY);
		return true;
	case APP_EVENT_TOUCH_UP:
		io.AddMouseSourceEvent(ImGuiMouseSource_TouchScreen);
		io.AddMousePosEvent(event.m_fX, event.m_fY);
		io.AddMouseButtonEvent(0, false);
		m_bLiftPointer = true;
		return true;
	case APP_EVENT_TOUCH_CANCEL:
		/** A pinch took the finger over: it lifts away from everything, so nothing takes it as a tap. */
		io.AddMouseSourceEvent(ImGuiMouseSource_TouchScreen);
		io.AddMousePosEvent(-FLT_MAX, -FLT_MAX);
		io.AddMouseButtonEvent(0, false);
		return true;
	case APP_EVENT_PINCH:
		m_pApp->Pinch(event.m_fZ, event.m_fX, event.m_fY);
		return true;
	case APP_EVENT_SURFACE:
	{
		std::string error;
		if (m_pWindow)
		{
			m_pEngine->detachWindow();
			ANativeWindow_release(m_pWindow);
		}
		m_pWindow = event.m_pWindow;
		event.m_pWindow = nullptr;
		if (!m_pEngine->attachWindow(m_pWindow, error))
		{
			__android_log_print(ANDROID_LOG_ERROR, "aep", "the surface could not be used: %s", error.c_str());
			ANativeWindow_release(m_pWindow);
			m_pWindow = nullptr;
			return false;
		}
		return true;
	}
	case APP_EVENT_SURFACE_CHANGED:
		if (m_pWindow)
		{
			m_pEngine->windowResized();
		}
		return true;
	case APP_EVENT_SURFACE_LOST:
		if (m_pWindow)
		{
			m_pEngine->detachWindow();
			ANativeWindow_release(m_pWindow);
			m_pWindow = nullptr;
		}
		return true;
	case APP_EVENT_OPEN:
		return m_pApp->OpenBytes(event.m_Name, std::move(event.m_Bytes), "");
	case APP_EVENT_NOTIFY:
		m_pApp->Notify(event.m_Name);
		return true;
	case APP_EVENT_SAFE_AREA:
		m_pApp->SetSafeArea(event.m_fX, event.m_fY, event.m_fZ, event.m_fW);
		return true;
	case APP_EVENT_BACK:
		return m_pApp->Back();
	}
	return false;
}

void CAndroidApp::Tick()
{
	if (!m_bRunning.load())
	{
		return;
	}
	/** The next frame's callback first, so a slow frame does not skip the clock. */
	PostFrame();

	std::deque<sAppEvent> events;
	{
		std::lock_guard<std::mutex> guard(m_QueueLock);
		events.swap(m_Queue);
	}
	if (m_bLiftPointer && events.empty())
	{
		ImGui::GetIO().AddMousePosEvent(-FLT_MAX, -FLT_MAX);
		m_bLiftPointer = false;
	}
	for (sAppEvent& event : events)
	{
		const bool answer = Handle(event);
		if (event.m_pWindow)
		{
			ANativeWindow_release(event.m_pWindow);
		}
		if (event.m_pDone)
		{
			event.m_pDone->set_value(answer);
		}
		m_iSettle = 3;
	}

	if (!m_pWindow)
	{
		return;
	}
	const s32 width = ANativeWindow_getWidth(m_pWindow);
	const s32 height = ANativeWindow_getHeight(m_pWindow);
	if (width <= 0 || height <= 0)
	{
		return;
	}
	if (width != m_iWidth || height != m_iHeight)
	{
		m_iWidth = width;
		m_iHeight = height;
		m_pEngine->windowResized();
		m_iSettle = 3;
	}
	if (!m_pApp->Busy() && m_iSettle <= 0)
	{
		return;
	}
	m_iSettle--;
	m_pApp->Frame(Now(), width, height);
}

void CAndroidApp::ChooseProject()
{
	jclass type = m_pEnv->GetObjectClass(m_Activity);
	jmethodID choose = m_pEnv->GetMethodID(type, "chooseProject", "()V");
	if (choose)
	{
		m_pEnv->CallVoidMethod(m_Activity, choose);
	}
	if (m_pEnv->ExceptionCheck())
	{
		m_pEnv->ExceptionClear();
	}
	m_pEnv->DeleteLocalRef(type);
}

bool CAndroidApp::SaveFile(const std::string& name, const std::vector<u8>& bytes, std::string& error)
{
	jclass type = m_pEnv->GetObjectClass(m_Activity);
	jmethodID save = m_pEnv->GetMethodID(type, "saveFile", "(Ljava/lang/String;[B)Ljava/lang/String;");
	m_pEnv->DeleteLocalRef(type);
	if (!save)
	{
		m_pEnv->ExceptionClear();
		error = "this app cannot save files";
		return false;
	}
	jstring jname = m_pEnv->NewStringUTF(name.c_str());
	jbyteArray jbytes = m_pEnv->NewByteArray(jsize(bytes.size()));
	m_pEnv->SetByteArrayRegion(jbytes, 0, jsize(bytes.size()), reinterpret_cast<const jbyte*>(bytes.data()));
	/** The activity answers null when it saved the file, or why it could not. */
	jstring failure = static_cast<jstring>(m_pEnv->CallObjectMethod(m_Activity, save, jname, jbytes));
	bool saved = !m_pEnv->ExceptionCheck() && !failure;
	if (m_pEnv->ExceptionCheck())
	{
		m_pEnv->ExceptionClear();
		error = "the file could not be written";
	}
	else if (failure)
	{
		const char* text = m_pEnv->GetStringUTFChars(failure, nullptr);
		error = text ? text : "the file could not be written";
		m_pEnv->ReleaseStringUTFChars(failure, text);
		m_pEnv->DeleteLocalRef(failure);
	}
	m_pEnv->DeleteLocalRef(jname);
	m_pEnv->DeleteLocalRef(jbytes);
	return saved;
}

} /** namespace aep */

namespace
{

struct sAppHandle
{
	std::unique_ptr<aep::CAndroidApp> m_pApp;
	jobject m_Activity = nullptr;
};

std::string g_CreateError;

aep::CAndroidApp* AppOf(jlong handle)
{
	return handle ? reinterpret_cast<sAppHandle*>(handle)->m_pApp.get() : nullptr;
}

std::string StringOf(JNIEnv* env, jstring text)
{
	if (!text)
	{
		return "";
	}
	const char* chars = env->GetStringUTFChars(text, nullptr);
	std::string out = chars ? chars : "";
	env->ReleaseStringUTFChars(text, chars);
	return out;
}

void PostTouch(jlong handle, aep::eAppEvent type, jfloat x, jfloat y)
{
	if (aep::CAndroidApp* app = AppOf(handle))
	{
		aep::sAppEvent event;
		event.m_eType = type;
		event.m_fX = x;
		event.m_fY = y;
		app->Post(std::move(event));
	}
}

} /** namespace */

extern "C"
{

/** A screen's app; 0 when it cannot start (nativeCreateError says why). */
JNIEXPORT jlong JNICALL Java_com_zionschxma_aev3_NativeApp_nativeCreate(JNIEnv* env, jclass, jobject activity, jfloat density, jstring settingsFolder)
{
	JavaVM* vm = nullptr;
	env->GetJavaVM(&vm);
	auto* handle = new sAppHandle();
	handle->m_Activity = env->NewGlobalRef(activity);
	handle->m_pApp = std::make_unique<aep::CAndroidApp>(vm, handle->m_Activity, density, StringOf(env, settingsFolder));
	std::string error;
	if (!handle->m_pApp->Start(error))
	{
		g_CreateError = error;
		handle->m_pApp.reset();
		env->DeleteGlobalRef(handle->m_Activity);
		delete handle;
		return 0;
	}
	return reinterpret_cast<jlong>(handle);
}

JNIEXPORT jstring JNICALL Java_com_zionschxma_aev3_NativeApp_nativeCreateError(JNIEnv* env, jclass)
{
	return env->NewStringUTF(g_CreateError.c_str());
}

JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeApp_nativeDestroy(JNIEnv* env, jclass, jlong handle)
{
	if (!handle)
	{
		return;
	}
	auto* app = reinterpret_cast<sAppHandle*>(handle);
	app->m_pApp.reset();
	env->DeleteGlobalRef(app->m_Activity);
	delete app;
}

JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeApp_nativeSurface(JNIEnv* env, jclass, jlong handle, jobject surface)
{
	aep::CAndroidApp* app = AppOf(handle);
	if (!app || !surface)
	{
		return;
	}
	aep::sAppEvent event;
	event.m_eType = aep::APP_EVENT_SURFACE;
	event.m_pWindow = ANativeWindow_fromSurface(env, surface);
	app->Post(std::move(event), true);
}

JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeApp_nativeSurfaceChanged(JNIEnv*, jclass, jlong handle)
{
	if (aep::CAndroidApp* app = AppOf(handle))
	{
		aep::sAppEvent event;
		event.m_eType = aep::APP_EVENT_SURFACE_CHANGED;
		app->Post(std::move(event));
	}
}

/** Waits until the engine stopped using the surface: Android may free it once surfaceDestroyed returns. */
JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeApp_nativeSurfaceLost(JNIEnv*, jclass, jlong handle)
{
	if (aep::CAndroidApp* app = AppOf(handle))
	{
		aep::sAppEvent event;
		event.m_eType = aep::APP_EVENT_SURFACE_LOST;
		app->Post(std::move(event), true);
	}
}

/** action: 0 down, 1 move, 2 up, 3 cancel; x and y in surface pixels. */
JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeApp_nativeTouch(JNIEnv*, jclass, jlong handle, jint action, jfloat x, jfloat y)
{
	static const aep::eAppEvent s_Types[] = { aep::APP_EVENT_TOUCH_DOWN, aep::APP_EVENT_TOUCH_MOVE, aep::APP_EVENT_TOUCH_UP, aep::APP_EVENT_TOUCH_CANCEL };
	if (action >= 0 && action < 4)
	{
		PostTouch(handle, s_Types[action], x, y);
	}
}

JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeApp_nativePinch(JNIEnv*, jclass, jlong handle, jfloat factor, jfloat x, jfloat y)
{
	if (aep::CAndroidApp* app = AppOf(handle))
	{
		aep::sAppEvent event;
		event.m_eType = aep::APP_EVENT_PINCH;
		event.m_fX = x;
		event.m_fY = y;
		event.m_fZ = factor;
		app->Post(std::move(event));
	}
}

JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeApp_nativeSafeArea(JNIEnv*, jclass, jlong handle, jfloat left, jfloat top, jfloat right, jfloat bottom)
{
	if (aep::CAndroidApp* app = AppOf(handle))
	{
		aep::sAppEvent event;
		event.m_eType = aep::APP_EVENT_SAFE_AREA;
		event.m_fX = left;
		event.m_fY = top;
		event.m_fZ = right;
		event.m_fW = bottom;
		app->Post(std::move(event));
	}
}

/** Opens a project's bytes the user picked or shared (`name` is its file name). */
JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeApp_nativeOpen(JNIEnv* env, jclass, jlong handle, jstring name, jbyteArray bytes)
{
	aep::CAndroidApp* app = AppOf(handle);
	if (!app || !bytes)
	{
		return;
	}
	aep::sAppEvent event;
	event.m_eType = aep::APP_EVENT_OPEN;
	event.m_Name = StringOf(env, name);
	event.m_Bytes.resize(size_t(env->GetArrayLength(bytes)));
	env->GetByteArrayRegion(bytes, 0, jsize(event.m_Bytes.size()), reinterpret_cast<jbyte*>(event.m_Bytes.data()));
	app->Post(std::move(event));
}

JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeApp_nativeNotify(JNIEnv* env, jclass, jlong handle, jstring message)
{
	if (aep::CAndroidApp* app = AppOf(handle))
	{
		aep::sAppEvent event;
		event.m_eType = aep::APP_EVENT_NOTIFY;
		event.m_Name = StringOf(env, message);
		app->Post(std::move(event));
	}
}

/** The back button: true when the app closed something (a dialog, the project), false when the activity should go. */
JNIEXPORT jboolean JNICALL Java_com_zionschxma_aev3_NativeApp_nativeBack(JNIEnv*, jclass, jlong handle)
{
	aep::CAndroidApp* app = AppOf(handle);
	if (!app)
	{
		return JNI_FALSE;
	}
	aep::sAppEvent event;
	event.m_eType = aep::APP_EVENT_BACK;
	return app->Post(std::move(event), true) ? JNI_TRUE : JNI_FALSE;
}

} /** extern "C" */
