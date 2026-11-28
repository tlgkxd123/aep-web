/**
 * Expressions in the native core (docs/native-port.md, M3). The app's own expression engine (src/expressions), with
 * its parser and evaluator, is bundled into native/core/expressions/bundle.js and runs in an embedded QuickJS, so an
 * expression gives the same result in the native app as in the web app. The C++ planner calls it only for the
 * properties that have an expression; everything else is evaluated in C++.
 *
 * Built only with AEP_EXPRESSIONS (CMake option); without it, plans are pre-expression and list the layers whose
 * expressions they skipped.
 */
#pragma once

#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

#include "evaluate.h"
#include "model.h"

struct JSRuntime;
struct JSContext;

namespace aep
{

class CExpressionEngine final : public IExpressionEvaluator
{
public:
	/** An engine over `project` (which must outlive it); null with `error` set when the script cannot start. */
	static std::unique_ptr<CExpressionEngine> Create(const CProject& project, std::string& error);
	~CExpressionEngine() override;

	/** Starts a frame: results cached for the previous one are dropped, as the TypeScript planner does per frame. */
	void BeginFrame() override;
	/** Expression errors reported since BeginFrame ("Expression error on <layer> > <property>: ..."). */
	void TakeWarnings(std::vector<std::string>& out) override;

	CValue Evaluate(const CPropertyNode& prop, f64 compTime, const CLayer& layer, const CValue& pre) override;

	/** Milliseconds spent starting the script and parsing the project on its side. */
	f64 StartupMs() const { return m_fStartupMs; }
	/** Properties with an expression the engine found its counterpart for. */
	size_t PropertyCount() const { return m_Properties.size(); }

private:
	struct sHandle;

	CExpressionEngine() = default;
	bool Start(const CProject& project, std::string& error);
	void MapLayer(const CItem& comp, const CLayer& layer);
	void MapNode(const CPropertyNode& node, const CItem& comp, const CLayer& layer, std::vector<std::pair<std::string, u32>>& path);
	std::string Exception();

	JSRuntime* m_pRuntime = nullptr;
	JSContext* m_pContext = nullptr;
	std::unique_ptr<sHandle> m_pApi;
	std::unordered_map<const CPropertyNode*, std::unique_ptr<sHandle>> m_Properties;
	std::unordered_map<const CLayer*, std::unique_ptr<sHandle>> m_Layers;
	std::vector<std::string> m_Errors;
	f64 m_fStartupMs = 0;
};

} /** namespace aep */
