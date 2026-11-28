/**
 * The project playing in C++ on Android (docs/native-port.md, milestone M2): the web app hands NativeEngine the
 * project's bytes once (again after an edit) and says which comp, when to play and where the playhead goes; planning,
 * timing, rendering and presenting into the plugin's SurfaceView then run here, on a thread driven by the display's
 * frame clock (AChoreographer), with no WebView or JavaScript in the frame loop.
 */
#include <android/choreographer.h>
#include <android/log.h>
#include <android/looper.h>
#include <dlfcn.h>
#include <jni.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "jni_session.h"

namespace aep
{

/**
 * A thread with its own looper that ticks a session's playback once per display frame, while the session has a
 * project and the engine a window.
 */
class CPlayerLoop
{
public:
	explicit CPlayerLoop(Session& session) : m_Session(session) {}
	~CPlayerLoop() { Stop(); }

	CPlayerLoop(const CPlayerLoop&) = delete;
	CPlayerLoop& operator=(const CPlayerLoop&) = delete;

	void Start();
	void Stop();

private:
	typedef void (*tPostFrameCallback64)(AChoreographer*, void (*)(int64_t, void*), void*);

	static void OnFrame64(int64_t frameTimeNanos, void* data);
	static void OnFrame(long frameTimeNanos, void* data);
	void Run();
	void Tick();
	void Post();

	Session& m_Session;
	std::thread m_Thread;
	std::atomic<bool> m_bRunning{ false };
	std::mutex m_StartLock;
	std::condition_variable m_Started;
	ALooper* m_pLooper = nullptr;
	AChoreographer* m_pChoreographer = nullptr;
	/** AChoreographer_postFrameCallback64 (API 29), whose frame time does not overflow on 32-bit devices. */
	tPostFrameCallback64 m_pPost64 = nullptr;
	std::string m_LastError;
};

void CPlayerLoop::Start()
{
	if (m_bRunning.exchange(true))
	{
		return;
	}
	std::unique_lock<std::mutex> guard(m_StartLock);
	m_pLooper = nullptr;
	m_Thread = std::thread([this] { Run(); });
	m_Started.wait(guard, [this] { return m_pLooper != nullptr; });
}

void CPlayerLoop::Stop()
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
}

void CPlayerLoop::Run()
{
	ALooper* looper = ALooper_prepare(0);
	ALooper_acquire(looper);
	m_pChoreographer = AChoreographer_getInstance();
	if (void* android = dlopen("libandroid.so", RTLD_NOW | RTLD_LOCAL))
	{
		m_pPost64 = reinterpret_cast<tPostFrameCallback64>(dlsym(android, "AChoreographer_postFrameCallback64"));
	}
	{
		std::lock_guard<std::mutex> guard(m_StartLock);
		m_pLooper = looper;
	}
	m_Started.notify_all();
	Post();
	while (m_bRunning.load())
	{
		ALooper_pollOnce(-1, nullptr, nullptr, nullptr);
	}
	{
		std::lock_guard<std::mutex> guard(m_StartLock);
		m_pLooper = nullptr;
	}
	ALooper_release(looper);
}

void CPlayerLoop::Post()
{
	if (!m_pChoreographer)
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

void CPlayerLoop::OnFrame64(int64_t frameTimeNanos, void* data)
{
	(void)frameTimeNanos;
	static_cast<CPlayerLoop*>(data)->Tick();
}

void CPlayerLoop::OnFrame(long frameTimeNanos, void* data)
{
	(void)frameTimeNanos;
	static_cast<CPlayerLoop*>(data)->Tick();
}

void CPlayerLoop::Tick()
{
	if (!m_bRunning.load())
	{
		return;
	}
	{
		std::lock_guard<std::mutex> guard(m_Session.lock);
		CPlaybackSession* playback = m_Session.playback.get();
		if (playback && playback->Comp() && m_Session.engine->hasWindow())
		{
			const f64 now = std::chrono::duration<f64>(std::chrono::steady_clock::now().time_since_epoch()).count();
			/** Three quarters of a comp frame, so planning and rendering ahead leave the display its time. */
			const f64 budgetMs = 750.0 / playback->Comp()->m_fFrameRate;
			std::string error;
			playback->Tick(now, budgetMs, error);
			if (!error.empty() && error != m_LastError)
			{
				__android_log_print(ANDROID_LOG_WARN, "aevk", "playback: %s", error.c_str());
			}
			m_LastError = error;
		}
	}
	Post();
}

} /** namespace aep */

namespace
{

Session* SessionOf(jlong handle)
{
	return reinterpret_cast<Session*>(handle);
}

/** A JSON string literal of `text`. */
std::string Quote(const std::string& text)
{
	std::string out = "\"";
	for (const char c : text)
	{
		switch (c)
		{
		case '"': out += "\\\""; break;
		case '\\': out += "\\\\"; break;
		case '\n': out += "\\n"; break;
		case '\r': out += "\\r"; break;
		case '\t': out += "\\t"; break;
		default:
			if (static_cast<unsigned char>(c) < 0x20)
			{
				char escaped[8];
				std::snprintf(escaped, sizeof(escaped), "\\u%04x", c);
				out += escaped;
			}
			else
			{
				out += c;
			}
		}
	}
	return out + "\"";
}

aep::f64 Now()
{
	return std::chrono::duration<aep::f64>(std::chrono::steady_clock::now().time_since_epoch()).count();
}

} /** namespace */

void StopPlayback(Session& session)
{
	std::shared_ptr<aep::CPlayerLoop> loop;
	{
		std::lock_guard<std::mutex> guard(session.lock);
		loop = std::move(session.loop);
	}
	/** Stopped without the lock: its last tick may be waiting for it. */
	loop.reset();
	std::lock_guard<std::mutex> guard(session.lock);
	session.playback.reset();
}

extern "C" {

/**
 * Opens `project` (an .aep file's bytes) for playback in the surface, replacing an earlier one, and starts the frame
 * clock. Its comps as JSON, [{"id", "name", "width", "height", "duration", "frameRate", "playable"}], or null when the
 * project cannot be read (nativeError says why).
 */
JNIEXPORT jstring JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeOpenProject(JNIEnv* env, jclass, jlong handle,
	jbyteArray project, jboolean expressions, jlong cacheBytes)
{
	Session* s = SessionOf(handle);
	std::vector<aep::u8> bytes(project ? size_t(env->GetArrayLength(project)) : 0);
	if (!bytes.empty())
	{
		env->GetByteArrayRegion(project, 0, jsize(bytes.size()), reinterpret_cast<jbyte*>(bytes.data()));
	}
	StopPlayback(*s);
	std::lock_guard<std::mutex> guard(s->lock);
	std::unique_ptr<aep::CPlaybackSession> playback = aep::CPlaybackSession::Create(*s->engine, std::move(bytes),
		expressions == JNI_TRUE, cacheBytes > 0 ? size_t(cacheBytes) : size_t(256) << 20, s->error);
	if (!playback)
	{
		return nullptr;
	}
	std::string json = "[";
	for (const aep::sCompInfo& comp : playback->Comps())
	{
		char numbers[192];
		std::snprintf(numbers, sizeof(numbers),
			",\"width\":%.0f,\"height\":%.0f,\"duration\":%.6f,\"frameRate\":%.6f,\"playable\":%s}", comp.m_fWidth,
			comp.m_fHeight, comp.m_fDuration, comp.m_fFrameRate, comp.m_bPlayable ? "true" : "false");
		json += (json.size() > 1 ? ",{\"id\":" : "{\"id\":") + std::to_string(comp.m_uId) + ",\"name\":" + Quote(comp.m_Name) +
			numbers;
	}
	json += "]";
	playback->SelectComp(playback->DefaultComp());
	s->playback = std::move(playback);
	s->loop = std::make_shared<aep::CPlayerLoop>(*s);
	s->loop->Start();
	return env->NewStringUTF(json.c_str());
}

/** Stops the frame clock and closes the project. */
JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeCloseProject(JNIEnv*, jclass, jlong handle)
{
	StopPlayback(*SessionOf(handle));
}

/** Shows comp `id`, paused at its first frame, at 1/`divisor` of its resolution; false when there is no such comp. */
JNIEXPORT jboolean JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeSelectComp(JNIEnv*, jclass, jlong handle,
	jint id, jint divisor)
{
	Session* s = SessionOf(handle);
	std::lock_guard<std::mutex> guard(s->lock);
	if (!s->playback || !s->playback->SelectComp(aep::u32(id)))
	{
		s->error = "no such comp";
		return JNI_FALSE;
	}
	s->playback->SetResolution(divisor);
	return JNI_TRUE;
}

JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeSetResolution(JNIEnv*, jclass, jlong handle, jint divisor)
{
	Session* s = SessionOf(handle);
	std::lock_guard<std::mutex> guard(s->lock);
	if (s->playback)
	{
		s->playback->SetResolution(divisor);
	}
}

JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeSetPlaying(JNIEnv*, jclass, jlong handle, jboolean playing)
{
	Session* s = SessionOf(handle);
	std::lock_guard<std::mutex> guard(s->lock);
	if (s->playback)
	{
		s->playback->SetPlaying(playing == JNI_TRUE, Now());
	}
}

/** Moves the playhead to comp time `time`, in seconds. */
JNIEXPORT void JNICALL Java_com_zionschxma_aev3_NativeEngine_nativeSeek(JNIEnv*, jclass, jlong handle, jdouble time)
{
	Session* s = SessionOf(handle);
	std::lock_guard<std::mutex> guard(s->lock);
	if (s->playback)
	{
		s->playback->Seek(time, Now());
	}
}

/**
 * {time, frame, frameCount, playing, shown, dropped, unsupported, planMs, renderMs, expressionStartupMs}, or null
 * with no project open.
 */
JNIEXPORT jdoubleArray JNICALL Java_com_zionschxma_aev3_NativeEngine_nativePlaybackState(JNIEnv* env, jclass, jlong handle)
{
	Session* s = SessionOf(handle);
	std::lock_guard<std::mutex> guard(s->lock);
	if (!s->playback)
	{
		return nullptr;
	}
	const aep::CPlaybackSession& p = *s->playback;
	const aep::sSessionStats& stats = p.Stats();
	const jdouble values[10] = { p.Time(), jdouble(p.Frame()), jdouble(p.FrameCount()), p.Playing() ? 1.0 : 0.0,
		jdouble(stats.m_iShown), jdouble(stats.m_iDropped), jdouble(stats.m_iUnsupported), stats.m_fPlanMs,
		stats.m_fRenderMs, stats.m_fExpressionStartupMs };
	jdoubleArray out = env->NewDoubleArray(10);
	env->SetDoubleArrayRegion(out, 0, 10, values);
	return out;
}

} /** extern "C" */
