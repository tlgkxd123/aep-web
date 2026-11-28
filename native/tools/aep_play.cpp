/**
 * A comp parsed, planned and rendered end to end in C++, with the time each stage takes: the path an app takes on a
 * phone with no JavaScript, WebView bridge or wire format in between.
 *
 *   aep-play [--comp name] [--frames n] [--scale s] [--wire] [--expressions] project.aep
 *
 * It parses the project, then plans and renders n frames spread over the comp's duration (60 by default) and prints
 * one JSON line with the median milliseconds of each stage. --wire also encodes and decodes each plan as the bridge
 * does today, to show what the in-memory path saves. --expressions applies expressions (a build with
 * AEP_EXPRESSIONS) and reports how long their engine took to start. Without --comp it plays the first comp that renders completely.
 */
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

#include "engine.h"
#include "parse.h"
#include "planner.h"
#include "wire.h"
#if AEP_EXPRESSIONS
#include "expressions.h"
#endif

namespace
{

using aep::f64;
using aep::s32;
using aep::u32;
using aep::u8;
using tClock = std::chrono::steady_clock;

f64 MsSince(tClock::time_point start)
{
	return std::chrono::duration<f64, std::milli>(tClock::now() - start).count();
}

f64 Median(std::vector<f64> values)
{
	if (values.empty())
	{
		return 0;
	}
	std::sort(values.begin(), values.end());
	return values[values.size() / 2];
}

f64 Max(const std::vector<f64>& values)
{
	return values.empty() ? 0 : *std::max_element(values.begin(), values.end());
}

/** Whether `comp` plans with nothing unsupported at its first frame. */
bool Plays(const aep::CProject& project, const aep::CItem& comp, f64 scale)
{
	aep::CFramePlanner planner(project);
	return planner.Build(comp, 0, scale).m_Unsupported.empty();
}

} /** namespace */

int main(int argc, char** argv)
{
	std::string path, compName;
	s32 frames = 60;
	f64 scale = 1;
	bool wire = false;
	bool expressions = false;
	for (s32 i = 1; i < argc; i++)
	{
		if (!std::strcmp(argv[i], "--comp") && i + 1 < argc)
		{
			compName = argv[++i];
		}
		else if (!std::strcmp(argv[i], "--frames") && i + 1 < argc)
		{
			frames = std::max(1, std::atoi(argv[++i]));
		}
		else if (!std::strcmp(argv[i], "--scale") && i + 1 < argc)
		{
			scale = std::strtod(argv[++i], nullptr);
		}
		else if (!std::strcmp(argv[i], "--wire"))
		{
			wire = true;
		}
		else if (!std::strcmp(argv[i], "--expressions"))
		{
			expressions = true;
		}
		else
		{
			path = argv[i];
		}
	}
	if (path.empty())
	{
		std::fprintf(stderr, "usage: aep-play [--comp name] [--frames n] [--scale s] [--wire] project.aep\n");
		return 2;
	}

	std::string error;
	std::vector<u8> bytes;
	aep::CProject project;
	const tClock::time_point parseStart = tClock::now();
	if (!aep::ReadFileBytes(path, bytes, error) || !aep::ParseProject(std::move(bytes), project, error))
	{
		std::printf("{\"error\":\"%s\"}\n", error.c_str());
		return 1;
	}
	const f64 parseMs = MsSince(parseStart);
	aep::IExpressionEvaluator* evaluator = nullptr;
	f64 expressionStartupMs = 0;
#if AEP_EXPRESSIONS
	std::unique_ptr<aep::CExpressionEngine> engineJs;
	if (expressions)
	{
		engineJs = aep::CExpressionEngine::Create(project, error);
		if (!engineJs)
		{
			std::printf("{\"error\":\"%s\"}\n", error.c_str());
			return 1;
		}
		evaluator = engineJs.get();
		expressionStartupMs = engineJs->StartupMs();
	}
#else
	if (expressions)
	{
		std::fprintf(stderr, "this build has no expressions (configure with -DAEP_EXPRESSIONS=ON)\n");
		return 2;
	}
#endif

	const aep::CItem* comp = nullptr;
	for (const auto& entry : project.m_Items)
	{
		const aep::CItem& item = *entry.second;
		if (item.m_eKind != aep::ITEM_COMP)
		{
			continue;
		}
		if (compName.empty() ? Plays(project, item, scale) : item.m_Name == compName)
		{
			comp = &item;
			break;
		}
	}
	if (!comp)
	{
		std::printf("{\"error\":\"no comp to play\"}\n");
		return 1;
	}

	/** The project's folder holds its footage and sounds, as After Effects' Collect Files leaves them. */
	aevk::EngineOptions options;
	options.mediaFolders.push_back(std::filesystem::absolute(path).parent_path().string());
	std::unique_ptr<aevk::Engine> engine = aevk::Engine::create(options, error);
	if (!engine)
	{
		std::printf("{\"error\":\"%s\"}\n", error.c_str());
		return 2;
	}

	/** One untimed frame first fills the engine's pool of render targets. */
	std::vector<f64> plan, encode, decode, record, gpu, render;
	s32 unsupported = 0;
	for (s32 i = -1; i < frames; i++)
	{
		const f64 time = i < 0 ? 0 : comp->m_fDuration * f64(i) / f64(frames);
		tClock::time_point start = tClock::now();
		aep::CFramePlanner planner(project);
		planner.SetExpressions(evaluator);
		aep::sFramePlan framePlan = planner.Build(*comp, time, scale);
		const f64 planned = MsSince(start);
		if (!framePlan.m_Unsupported.empty())
		{
			unsupported++;
		}
		aevk::Plan* toRender = &framePlan.m_Plan;
		aevk::Plan decoded;
		f64 encoded = 0, decodedMs = 0;
		if (wire)
		{
			start = tClock::now();
			const std::vector<u8> encodedBytes = aep::EncodePlan(framePlan.m_Plan);
			encoded = MsSince(start);
			start = tClock::now();
			if (!aevk::decodePlan(encodedBytes.data(), encodedBytes.size(), decoded, error))
			{
				std::printf("{\"error\":\"%s\"}\n", error.c_str());
				return 1;
			}
			decodedMs = MsSince(start);
			toRender = &decoded;
		}
		start = tClock::now();
		std::shared_ptr<aevk::Frame> frame = engine->renderFrame(*toRender, error);
		const f64 rendered = MsSince(start);
		if (!frame)
		{
			std::printf("{\"error\":\"%s\"}\n", error.c_str());
			return 1;
		}
		if (i < 0)
		{
			continue;
		}
		const aevk::FrameTimings& timings = engine->lastTimings();
		plan.push_back(planned);
		encode.push_back(encoded);
		decode.push_back(decodedMs);
		record.push_back(timings.recordMs);
		gpu.push_back(timings.gpuMs);
		render.push_back(rendered);
	}

	const aevk::DeviceInfo& device = engine->device();
	std::printf("{\"project\":\"%s\",\"comp\":\"%s\",\"width\":%.0f,\"height\":%.0f,\"layers\":%zu,\"frames\":%d,\"unsupportedFrames\":%d,"
		"\"device\":\"%s\",\"software\":%s,\"parseMs\":%.3f,\"planMs\":%.3f,\"planMaxMs\":%.3f,",
		path.c_str(), comp->m_Name.c_str(), aep::ScaledSize(comp->m_fWidth, scale), aep::ScaledSize(comp->m_fHeight, scale),
		comp->m_Layers.size(), frames, unsupported, device.name.c_str(), device.software ? "true" : "false", parseMs, Median(plan), Max(plan));
	if (evaluator)
	{
		std::printf("\"expressionStartupMs\":%.3f,", expressionStartupMs);
	}
	if (wire)
	{
		std::printf("\"encodeMs\":%.3f,\"decodeMs\":%.3f,", Median(encode), Median(decode));
	}
	std::printf("\"recordMs\":%.3f,\"gpuMs\":%.3f,\"renderMs\":%.3f}\n", Median(record), Median(gpu), Median(render));
	return 0;
}
