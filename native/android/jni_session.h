/**
 * One NativeEngine handle (android/app/src/main/java/.../NativeEngine.java): the engine, the player the web app hands
 * plans to (aevk_jni.cpp), and the project playing in C++ on its own frame clock (aep_player_jni.cpp). Every call takes
 * the lock, since the plugin's calls, the surface's callbacks and the frame clock run on different threads.
 */
#pragma once

#include <memory>
#include <mutex>
#include <string>

#include "engine.h"
#include "playback.h"
#include "session.h"

namespace aep
{
class CPlayerLoop;
} /** namespace aep */

struct Session
{
	std::mutex lock;
	std::unique_ptr<aevk::Engine> engine;
	std::unique_ptr<aevk::Player> player;
	/** The frame nativeRenderFrame rendered, until nativeReadFrame or nativeWriteFrame takes its pixels. */
	std::shared_ptr<aevk::Frame> frame;
	std::string error;
	/** The project playing in C++, and the thread whose frame clock drives it (aep_player_jni.cpp). */
	std::unique_ptr<aep::CPlaybackSession> playback;
	std::shared_ptr<aep::CPlayerLoop> loop;
};

/** Stops the frame clock and closes the project; called without the lock held, before the session goes. */
void StopPlayback(Session& session);
