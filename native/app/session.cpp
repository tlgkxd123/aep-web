/**
 * See session.h.
 */
#include "session.h"

#include <algorithm>
#include <chrono>
#include <cmath>

#include "parse.h"
#if AEP_EXPRESSIONS
#include "expressions.h"
#endif

namespace aep
{

namespace
{

/** Frames planned ahead of the playhead at most; each holds its plan's images until it is rendered. */
const s32 kLookahead = 12;
/** Plans the player keeps queued at most. */
const size_t kMaxQueued = 48;
/** Share of a tick's budget that planning ahead may use; rendering ahead gets the rest. */
const f64 kPlanShare = 0.5;

using tClock = std::chrono::steady_clock;

f64 MsSince(tClock::time_point start)
{
	return std::chrono::duration<f64, std::milli>(tClock::now() - start).count();
}

f64 Smooth(f64 average, f64 sample)
{
	return average > 0 ? average + (sample - average) * 0.2 : sample;
}

} /** namespace */

CPlaybackSession::CPlaybackSession(aevk::Engine& engine, size_t cacheBytes)
	: m_Engine(engine)
	, m_Player(engine, cacheBytes, kMaxQueued)
{
}

CPlaybackSession::~CPlaybackSession()
{
	/** The player's frames go before the planner and the project their plans came from. */
	m_Player.invalidate("");
	m_pPlanner.reset();
	m_pExpressions.reset();
}

std::unique_ptr<CPlaybackSession> CPlaybackSession::Create(aevk::Engine& engine, std::vector<u8> bytes, bool expressions,
	size_t cacheBytes, std::string& error)
{
	std::unique_ptr<CPlaybackSession> session(new CPlaybackSession(engine, cacheBytes));
	session->m_pProject = std::make_unique<CProject>();
	if (!ParseProject(std::move(bytes), *session->m_pProject, error))
	{
		return nullptr;
	}
	session->m_pPlanner = std::make_unique<CFramePlanner>(*session->m_pProject);
	if (expressions)
	{
#if AEP_EXPRESSIONS
		const tClock::time_point start = tClock::now();
		std::unique_ptr<CExpressionEngine> evaluator = CExpressionEngine::Create(*session->m_pProject, error);
		if (!evaluator)
		{
			return nullptr;
		}
		session->m_Stats.m_fExpressionStartupMs = MsSince(start);
		session->m_pExpressions = std::move(evaluator);
		session->m_pPlanner->SetExpressions(session->m_pExpressions.get());
#else
		error = "this build evaluates no expressions (configure it with -DAEP_EXPRESSIONS=ON)";
		return nullptr;
#endif
	}

	for (const auto& entry : session->m_pProject->m_Items)
	{
		const CItem& item = *entry.second;
		if (item.m_eKind != ITEM_COMP)
		{
			continue;
		}
		sCompInfo info;
		info.m_uId = item.m_uId;
		info.m_Name = item.m_Name;
		info.m_fWidth = item.m_fWidth;
		info.m_fHeight = item.m_fHeight;
		info.m_fDuration = item.m_fDuration;
		info.m_fFrameRate = item.m_fFrameRate > 0 ? item.m_fFrameRate : 24;
		info.m_bPlayable = session->m_pPlanner->Build(item, 0, 1).m_Unsupported.empty();
		session->m_Comps.push_back(std::move(info));
	}
	return session;
}

u32 CPlaybackSession::DefaultComp() const
{
	for (const sCompInfo& info : m_Comps)
	{
		if (info.m_bPlayable)
		{
			return info.m_uId;
		}
	}
	return m_Comps.empty() ? 0 : m_Comps.front().m_uId;
}

bool CPlaybackSession::SelectComp(u32 id)
{
	const CItem* comp = m_pProject->Item(id);
	if (!comp || comp->m_eKind != ITEM_COMP)
	{
		return false;
	}
	for (const sCompInfo& info : m_Comps)
	{
		if (info.m_uId == id)
		{
			m_pInfo = &info;
		}
	}
	m_pComp = comp;
	m_iFrame = 0;
	m_iShownFrame = -1;
	m_Unsupported.clear();
	m_pCurrent.reset();
	m_bDirty = true;
	m_bPlaying = false;
	return true;
}

void CPlaybackSession::SetResolution(s32 divisor)
{
	divisor = std::max(1, std::min(divisor, 8));
	if (divisor == m_iDivisor)
	{
		return;
	}
	m_iDivisor = divisor;
	m_Unsupported.clear();
	m_bDirty = true;
}

s64 CPlaybackSession::FrameCount() const
{
	if (!m_pInfo)
	{
		return 1;
	}
	return std::max<s64>(1, s64(std::ceil(m_pInfo->m_fDuration * m_pInfo->m_fFrameRate - 1e-6)));
}

f64 CPlaybackSession::Time() const
{
	return m_pInfo ? f64(m_iFrame) / m_pInfo->m_fFrameRate : 0;
}

aevk::PlaybackSpan CPlaybackSession::Span() const
{
	aevk::CompTiming timing;
	timing.duration = m_pInfo ? m_pInfo->m_fDuration : 0;
	timing.frameRate = m_pInfo ? m_pInfo->m_fFrameRate : 24;
	timing.workAreaStart = 0;
	timing.workAreaDuration = timing.duration;
	aevk::PreviewSettings settings;
	settings.range = aevk::PreviewSettings::Range::Comp;
	settings.fromCurrent = true;
	settings.loop = true;
	return aevk::playbackSpan(timing, m_fOriginCompTime, settings);
}

void CPlaybackSession::SetPlaying(bool playing, f64 now)
{
	m_bPlaying = playing;
	m_fOriginTime = now;
	m_fOriginCompTime = Time();
	m_iShownSlot = 0;
	m_bDirty = true;
}

void CPlaybackSession::Seek(f64 time, f64 now)
{
	if (!m_pInfo)
	{
		return;
	}
	const s64 count = FrameCount();
	m_iFrame = std::max<s64>(0, std::min<s64>(count - 1, s64(std::floor(time * m_pInfo->m_fFrameRate + 1e-6))));
	m_bDirty = true;
	if (m_bPlaying)
	{
		SetPlaying(true, now);
	}
}

void CPlaybackSession::Step(s32 frames, f64 now)
{
	const s64 count = FrameCount();
	m_iFrame = ((m_iFrame + frames) % count + count) % count;
	m_bDirty = true;
	if (m_bPlaying)
	{
		SetPlaying(true, now);
	}
}

const std::vector<std::string>& CPlaybackSession::CurrentUnsupported() const
{
	static const std::vector<std::string> s_None;
	const auto it = m_Unsupported.find(m_iFrame);
	return it == m_Unsupported.end() ? s_None : it->second;
}

void CPlaybackSession::Background(float rgb[3]) const
{
	for (s32 i = 0; i < 3; i++)
	{
		rgb[i] = m_pComp ? float(m_pComp->m_BgColor[i]) : 0.0f;
	}
}

std::string CPlaybackSession::View() const
{
	return std::to_string(m_pComp ? m_pComp->m_uId : 0) + "@" + std::to_string(m_iDivisor);
}

bool CPlaybackSession::Prepare(s64 frame)
{
	const std::string view = View();
	if (m_Player.cached(view, frame) || m_Player.queued(view, frame))
	{
		return true;
	}
	if (m_Unsupported.count(frame))
	{
		return false;
	}
	const tClock::time_point start = tClock::now();
	sFramePlan plan = m_pPlanner->Build(*m_pComp, f64(frame) / m_pInfo->m_fFrameRate, 1.0 / m_iDivisor);
	m_Stats.m_fPlanMs = Smooth(m_Stats.m_fPlanMs, MsSince(start));
	if (!plan.m_Unsupported.empty())
	{
		m_Unsupported[frame] = std::move(plan.m_Unsupported);
		m_Stats.m_iUnsupported++;
		return false;
	}
	m_Player.queue(view, frame, std::move(plan.m_Plan));
	return true;
}

bool CPlaybackSession::Tick(f64 now, f64 budgetMs, std::string& error)
{
	error.clear();
	if (!m_pComp)
	{
		return false;
	}
	const tClock::time_point start = tClock::now();
	const aevk::PlaybackSpan span = Span();
	s64 slot = 0;
	if (m_bPlaying)
	{
		slot = aevk::dueSlot(span, 0, now - m_fOriginTime);
		const std::optional<aevk::Slot> due = aevk::slotTime(span, slot);
		if (due)
		{
			m_iFrame = std::min<s64>(FrameCount() - 1, s64(std::floor(due->time * m_pInfo->m_fFrameRate + 1e-6)));
		}
		if (slot > m_iShownSlot + 1 && m_iShownFrame >= 0)
		{
			m_Stats.m_iDropped += slot - m_iShownSlot - 1;
		}
	}

	bool presented = false;
	if (m_bDirty || m_iFrame != m_iShownFrame)
	{
		if (!Prepare(m_iFrame))
		{
			error = "this frame has something the native engine cannot draw yet";
			if (!m_bPresenting && m_pCurrent)
			{
				/** The host shows that it cannot be drawn instead of the last frame. */
				m_pCurrent.reset();
				m_iShownFrame = m_iFrame;
				m_bDirty = false;
				presented = true;
			}
		}
		else if (!m_bPresenting)
		{
			if (std::shared_ptr<aevk::Frame> frame = m_Player.frame(View(), m_iFrame, error))
			{
				m_pCurrent = std::move(frame);
				presented = true;
				m_iShownFrame = m_iFrame;
				m_bDirty = false;
				m_Stats.m_iShown++;
				m_iShownSlot = slot;
			}
		}
		else
		{
			float background[3];
			Background(background);
			if (m_Player.show(View(), m_iFrame, aevk::PresentRect(), background, error))
			{
				presented = true;
				m_iShownFrame = m_iFrame;
				m_bDirty = false;
				m_Stats.m_iShown++;
				m_iShownSlot = slot;
			}
		}
	}

	if (m_bPlaying)
	{
		for (s32 i = 1; i <= kLookahead && MsSince(start) < budgetMs * kPlanShare; i++)
		{
			const std::optional<aevk::Slot> ahead = aevk::slotTime(span, slot + i);
			if (ahead)
			{
				Prepare(std::min<s64>(FrameCount() - 1, s64(std::floor(ahead->time * m_pInfo->m_fFrameRate + 1e-6))));
			}
		}
		std::string ignored;
		m_Player.renderAhead(std::max(0.0, budgetMs - MsSince(start)), ignored);
	}
	m_Stats.m_fRenderMs = m_Player.renderMs();
	return presented;
}

} /** namespace aep */
