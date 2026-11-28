/**
 * Frame planning (src/native/plan.ts): what a comp draws at a time, as the native engine's plan, built in memory
 * straight from the project with no JavaScript, bridge or serialization in between.
 */
#pragma once

#include <string>
#include <vector>

#include "../src/plan.h"
#include "evaluate.h"
#include "model.h"
#include "transform.h"

namespace aep
{

struct sFramePlan
{
	aevk::Plan m_Plan;
	/** What the engine cannot render in this frame; empty when the plan is complete. */
	std::vector<std::string> m_Unsupported;
	/** Things skipped as the WebGL renderer skips them (comps nested too deep...). */
	std::vector<std::string> m_Warnings;
	/** Layers drawn with expressions, which this milestone evaluates pre-expression. */
	std::vector<std::string> m_Expressions;
};

class CFramePlanner
{
public:
	explicit CFramePlanner(const CProject& project) : m_Project(project) {}

	/**
	 * Expressions are applied with `evaluator` (CExpressionEngine), which must outlive the planner; without one, plans
	 * are pre-expression and sFramePlan::m_Expressions lists the layers whose expressions were skipped.
	 */
	void SetExpressions(IExpressionEvaluator* evaluator) { m_pExpressions = evaluator; }

	/** The plan of `comp` at composition time `time`, at `scale` of the comp's resolution (1/2 for Half...). */
	sFramePlan Build(const CItem& comp, f64 time, f64 scale = 1);

private:
	const CProject& m_Project;
	sFramePlan* m_pOut = nullptr;
	IExpressionEvaluator* m_pExpressions = nullptr;

	void PlanComp(const CItem& comp, f64 time, s32 depth, f64 scale, aevk::Comp& out);
	bool Placed(const CLayer& layer, const CItem& comp, f64 time, const sCamera* camera, s32 depth, f64 scale,
		bool adjustment, aevk::Layer& out);
	bool Content(const CLayer& layer, f64 time, s32 depth, f64 scale, aevk::Content& out);
	void Masks(const CLayer& layer, f64 time, f64 scale, std::vector<aevk::Mask>& out);
	void Unsupported(const std::string& what);
	void Warn(const std::string& what);
	void NoteExpressions(const CLayer& layer);
};

/** Pixels of a comp dimension rendered at `scale` (1/3 of 1920 is 640, not 641). */
f64 ScaledSize(f64 size, f64 scale);

} /** namespace aep */
