/**
 * Plans built in C++ for a list of jobs, for the parity check against the TypeScript planner (scripts/native-parity.ts).
 *
 *   aep-plan jobs.tsv outdir
 *
 * Each line of jobs.tsv is a job: project path, comp id, composition time and scale, separated by tabs. For job i, the
 * tool writes outdir/i.aevp (the plan in the engine's wire format) and outdir/i.txt (what the plan cannot render, one
 * item a line). A project is parsed once for all its jobs in a row. The last line on stdout is a JSON summary with the
 * time parsing and planning took.
 */
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "parse.h"
#include "planner.h"
#include "wire.h"

namespace
{

using aep::f64;
using aep::u32;
using aep::s32;
using aep::u8;
using tClock = std::chrono::steady_clock;

struct sJob
{
	std::string m_Project;
	u32 m_uCompId = 0;
	f64 m_fTime = 0;
	f64 m_fScale = 1;
};

f64 MsSince(tClock::time_point start)
{
	return std::chrono::duration<f64, std::milli>(tClock::now() - start).count();
}

/** The jobs in `path`, or false when it cannot be read. */
bool ReadJobs(const std::string& path, std::vector<sJob>& jobs)
{
	std::ifstream in(path);
	if (!in)
	{
		return false;
	}
	std::string line;
	while (std::getline(in, line))
	{
		if (line.empty())
		{
			continue;
		}
		std::istringstream fields(line);
		sJob job;
		std::string id, time, scale;
		std::getline(fields, job.m_Project, '\t');
		std::getline(fields, id, '\t');
		std::getline(fields, time, '\t');
		std::getline(fields, scale, '\t');
		job.m_uCompId = u32(std::strtoul(id.c_str(), nullptr, 10));
		job.m_fTime = std::strtod(time.c_str(), nullptr);
		job.m_fScale = scale.empty() ? 1 : std::strtod(scale.c_str(), nullptr);
		jobs.push_back(job);
	}
	return true;
}

} /** namespace */

int main(int argc, char** argv)
{
	if (argc < 3)
	{
		std::fprintf(stderr, "usage: aep-plan jobs.tsv outdir\n");
		return 2;
	}
	std::vector<sJob> jobs;
	if (!ReadJobs(argv[1], jobs))
	{
		std::fprintf(stderr, "cannot read %s\n", argv[1]);
		return 2;
	}
	const std::string outDir = argv[2];

	std::unique_ptr<aep::CProject> project;
	std::string loaded;
	f64 parseMs = 0, planMs = 0;
	s32 failures = 0, projects = 0;
	for (size_t i = 0; i < jobs.size(); i++)
	{
		const sJob& job = jobs[i];
		const std::string base = outDir + "/" + std::to_string(i);
		if (job.m_Project != loaded)
		{
			loaded = job.m_Project;
			project.reset(new aep::CProject());
			std::vector<u8> bytes;
			std::string error;
			const tClock::time_point start = tClock::now();
			const bool ok = aep::ReadFileBytes(job.m_Project, bytes, error) && aep::ParseProject(std::move(bytes), *project, error);
			parseMs += MsSince(start);
			projects++;
			if (!ok)
			{
				std::printf("{\"project\":\"%s\",\"error\":\"%s\"}\n", job.m_Project.c_str(), error.c_str());
				project.reset();
			}
		}
		const aep::CItem* comp = project ? project->Item(job.m_uCompId) : nullptr;
		if (!comp || comp->m_eKind != aep::ITEM_COMP)
		{
			std::ofstream(base + ".txt") << "error: no comp " << job.m_uCompId << "\n";
			failures++;
			continue;
		}
		const tClock::time_point start = tClock::now();
		aep::CFramePlanner planner(*project);
		const aep::sFramePlan plan = planner.Build(*comp, job.m_fTime, job.m_fScale);
		planMs += MsSince(start);

		std::ofstream unsupported(base + ".txt");
		for (const std::string& item : plan.m_Unsupported)
		{
			unsupported << item << "\n";
		}
		if (plan.m_Unsupported.empty())
		{
			const std::vector<u8> bytes = aep::EncodePlan(plan.m_Plan);
			std::ofstream(base + ".aevp", std::ios::binary).write(reinterpret_cast<const char*>(bytes.data()), std::streamsize(bytes.size()));
		}
	}
	std::printf("{\"jobs\":%zu,\"projects\":%d,\"failures\":%d,\"parseMs\":%.3f,\"planMs\":%.3f}\n", jobs.size(), projects, failures,
		parseMs, planMs);
	return failures ? 1 : 0;
}
