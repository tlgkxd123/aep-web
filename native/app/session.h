/**
 * A project playing in a native window: the project parsed once, frames planned in C++ ahead of the playhead, rendered
 * into the RAM preview cache and presented, with no JavaScript, WebView bridge or wire format in the frame loop. The
 * desktop viewer (tools/aep_viewer.cpp) and the Android player (android/aevk_jni.cpp) both drive one from their own
 * frame clock (docs/native-port.md, milestone M2).
 */
#pragma once

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "engine.h"
#include "model.h"
#include "planner.h"
#include "playback.h"

namespace aep
{

/** A comp the session can play, as a host lists it. */
struct sCompInfo
{
	u32 m_uId = 0;
	std::string m_Name;
	f64 m_fWidth = 0;
	f64 m_fHeight = 0;
	f64 m_fDuration = 0;
	f64 m_fFrameRate = 24;
	/** Whether its first frame plans with nothing the engine cannot draw. */
	bool m_bPlayable = false;
};

/** What the session has been doing, for a host's overlay or log. */
struct sSessionStats
{
	/** Smoothed milliseconds to plan one frame, and to render one. */
	f64 m_fPlanMs = 0;
	f64 m_fRenderMs = 0;
	/** Frames presented, and frames that came due while playing but were never shown. */
	s64 m_iShown = 0;
	s64 m_iDropped = 0;
	/** Frames whose plans have something the engine cannot draw yet (text, effects...). */
	s64 m_iUnsupported = 0;
	/** Milliseconds the expression engine took to start, 0 without one. */
	f64 m_fExpressionStartupMs = 0;
};

class CPlaybackSession
{
public:
	/**
	 * A session on `bytes` (an .aep file) drawing with `engine`, which must outlive it. With `expressions`, it evaluates
	 * them as the web app does (a build with AEP_EXPRESSIONS); otherwise properties keep their pre-expression values.
	 * Null with `error` set when the project cannot be read.
	 */
	static std::unique_ptr<CPlaybackSession> Create(aevk::Engine& engine, std::vector<u8> bytes, bool expressions,
		size_t cacheBytes, std::string& error);
	~CPlaybackSession();

	CPlaybackSession(const CPlaybackSession&) = delete;
	CPlaybackSession& operator=(const CPlaybackSession&) = delete;

	const std::vector<sCompInfo>& Comps() const { return m_Comps; }
	/** The first playable comp, or the first comp, or 0 when the project has none. */
	u32 DefaultComp() const;
	/** Shows comp `id` from its first frame, paused; false when there is no such comp. */
	bool SelectComp(u32 id);
	const sCompInfo* Comp() const { return m_pInfo; }

	/** Renders at 1/`divisor` of the comp's resolution (1 Full, 2 Half, 3 Third, 4 Quarter). */
	void SetResolution(s32 divisor);
	s32 Resolution() const { return m_iDivisor; }

	/** Starts or stops playback; `now` is the host's frame clock in seconds. */
	void SetPlaying(bool playing, f64 now);
	bool Playing() const { return m_bPlaying; }
	/** Moves the playhead to the frame at comp time `time` (and restarts the clock when playing). */
	void Seek(f64 time, f64 now);
	/** Moves the playhead by `frames`, wrapping around the comp. */
	void Step(s32 frames, f64 now);
	s64 Frame() const { return m_iFrame; }
	f64 Time() const;
	s64 FrameCount() const;

	/**
	 * Whether Tick presents the due frame into the engine's window itself (the default). An app that draws its own
	 * interface around the frame turns it off and draws CurrentFrame with Engine::presentUi.
	 */
	void SetPresenting(bool presenting) { m_bPresenting = presenting; }
	/** The frame at the playhead as the last Tick rendered it; null when it could not be drawn. */
	const std::shared_ptr<aevk::Frame>& CurrentFrame() const { return m_pCurrent; }
	/** Why the frame at the playhead cannot be drawn natively (empty when it can). */
	const std::vector<std::string>& CurrentUnsupported() const;
	/** The comp's background color, straight RGB. */
	void Background(float rgb[3]) const;

	const CProject& Project() const { return *m_pProject; }
	/** The comp being shown, or null. */
	const CItem* CompItem() const { return m_pComp; }

	/** Asks the next Tick to present even when the playhead has not moved (after a resize or expose). */
	void Invalidate() { m_bDirty = true; }

	/**
	 * Moves the playhead to `now` when playing, plans and renders frames ahead of it for up to `budgetMs`, and presents
	 * the frame that is due into the engine's window. True when it presented; false with `error` set when the due frame
	 * could not be drawn, and false with `error` empty when nothing needed presenting.
	 */
	bool Tick(f64 now, f64 budgetMs, std::string& error);

	const sSessionStats& Stats() const { return m_Stats; }

private:
	CPlaybackSession(aevk::Engine& engine, size_t cacheBytes);

	/** Plans `frame` and queues it unless it is queued, cached or known to be unsupported; false when unsupported. */
	bool Prepare(s64 frame);
	std::string View() const;
	aevk::PlaybackSpan Span() const;

	aevk::Engine& m_Engine;
	aevk::Player m_Player;
	std::unique_ptr<CProject> m_pProject;
	std::unique_ptr<IExpressionEvaluator> m_pExpressions;
	std::unique_ptr<CFramePlanner> m_pPlanner;
	std::vector<sCompInfo> m_Comps;
	const sCompInfo* m_pInfo = nullptr;
	const CItem* m_pComp = nullptr;
	s32 m_iDivisor = 1;
	bool m_bPlaying = false;
	bool m_bDirty = true;
	bool m_bPresenting = true;
	std::shared_ptr<aevk::Frame> m_pCurrent;
	s64 m_iFrame = 0;
	s64 m_iShownFrame = -1;
	/** Playback's clock: when it last restarted and the comp time it restarted at, and the slot last shown since. */
	f64 m_fOriginTime = 0;
	f64 m_fOriginCompTime = 0;
	s64 m_iShownSlot = 0;
	/** Frames of the current view whose plans the engine cannot draw, with what it cannot draw. */
	std::map<s64, std::vector<std::string>> m_Unsupported;
	sSessionStats m_Stats;
};

} /** namespace aep */
