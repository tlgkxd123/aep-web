/**
 * The QuickJS side of CExpressionEngine: starts the bundled script, hands it the project's bytes, pairs each C++
 * property that has an expression with the script's own, and converts values each way.
 */
#include "expressions.h"

#include <chrono>
#include <cmath>

#include "quickjs.h"

namespace aep
{

/** Generated from expressions/bundle.js at build time (cmake/embed.cmake). */
extern const unsigned char g_ExpressionBundle[];
extern const size_t g_ExpressionBundleSize;

/** A JS value the engine keeps alive until it is destroyed. */
struct CExpressionEngine::sHandle
{
	JSContext* m_pContext = nullptr;
	JSValue m_Value = JS_UNDEFINED;

	sHandle(JSContext* context, JSValue value) : m_pContext(context), m_Value(value) {}
	~sHandle() { JS_FreeValue(m_pContext, m_Value); }
	sHandle(const sHandle&) = delete;
	sHandle& operator=(const sHandle&) = delete;
};

namespace
{

/** Bytes to a string as TextDecoder does: UTF-8 with U+FFFD for bad sequences, or latin1. */
JSValue DecodeText(JSContext* context, JSValueConst, int argc, JSValueConst* argv)
{
	size_t size = 0;
	const u8* bytes = argc > 0 ? JS_GetUint8Array(context, &size, argv[0]) : nullptr;
	if (!bytes)
	{
		return JS_EXCEPTION;
	}
	const bool latin1 = argc > 1 && JS_ToBool(context, argv[1]) > 0;
	std::string out;
	out.reserve(size);
	const auto append = [&out](u32 code)
	{
		if (code < 0x80)
		{
			out += char(code);
		}
		else if (code < 0x800)
		{
			out += char(0xc0 | (code >> 6));
			out += char(0x80 | (code & 0x3f));
		}
		else if (code < 0x10000)
		{
			out += char(0xe0 | (code >> 12));
			out += char(0x80 | ((code >> 6) & 0x3f));
			out += char(0x80 | (code & 0x3f));
		}
		else
		{
			out += char(0xf0 | (code >> 18));
			out += char(0x80 | ((code >> 12) & 0x3f));
			out += char(0x80 | ((code >> 6) & 0x3f));
			out += char(0x80 | (code & 0x3f));
		}
	};
	for (size_t i = 0; i < size;)
	{
		const u8 b = bytes[i];
		if (latin1 || b < 0x80)
		{
			append(b);
			i++;
			continue;
		}
		const s32 n = b >= 0xf0 && b < 0xf5 ? 3 : b >= 0xe0 && b < 0xf0 ? 2 : b >= 0xc2 && b < 0xe0 ? 1 : -1;
		u32 code = n == 1 ? (b & 0x1f) : n == 2 ? (b & 0x0f) : (b & 0x07);
		/** n continuation bytes must follow. */
		bool ok = n > 0 && i + size_t(n) < size;
		for (s32 k = 1; ok && k <= n; k++)
		{
			const u8 c = bytes[i + size_t(k)];
			ok = (c & 0xc0) == 0x80;
			code = (code << 6) | (c & 0x3f);
		}
		static const u32 s_Minimum[4] = { 0, 0x80, 0x800, 0x10000 };
		ok = ok && code >= s_Minimum[n > 0 ? n : 0] && code <= 0x10ffff && !(code >= 0xd800 && code < 0xe000);
		append(ok ? code : 0xfffd);
		i += ok ? size_t(n) + 1 : 1;
	}
	return JS_NewStringLen(context, out.data(), out.size());
}

JSValue NewPoints(JSContext* context, const std::vector<sVec2>& points)
{
	JSValue array = JS_NewArray(context);
	for (size_t i = 0; i < points.size(); i++)
	{
		JSValue point = JS_NewArray(context);
		JS_SetPropertyUint32(context, point, 0, JS_NewFloat64(context, points[i].x));
		JS_SetPropertyUint32(context, point, 1, JS_NewFloat64(context, points[i].y));
		JS_SetPropertyUint32(context, array, u32(i), point);
	}
	return array;
}

/** A model value in the form src/aep/model.ts gives it: a number, an array, or a shape. */
JSValue ToJs(JSContext* context, const CValue& value)
{
	if (value.IsNumber())
	{
		return JS_NewFloat64(context, value.m_V[0]);
	}
	if (value.IsVector())
	{
		JSValue array = JS_NewArray(context);
		for (u32 i = 0; i < value.m_uCount; i++)
		{
			JS_SetPropertyUint32(context, array, i, JS_NewFloat64(context, value.m_V[i]));
		}
		return array;
	}
	if (value.IsShape())
	{
		const sShape& shape = *value.m_pShape;
		JSValue object = JS_NewObject(context);
		JS_SetPropertyStr(context, object, "closed", JS_NewBool(context, shape.m_bClosed));
		JS_SetPropertyStr(context, object, "vertices", NewPoints(context, shape.m_Vertices));
		JS_SetPropertyStr(context, object, "inTangents", NewPoints(context, shape.m_InTangents));
		JS_SetPropertyStr(context, object, "outTangents", NewPoints(context, shape.m_OutTangents));
		return object;
	}
	return JS_NULL;
}

bool ToNumber(JSContext* context, JSValueConst value, f64& out)
{
	return JS_IsNumber(value) && JS_ToFloat64(context, &out, value) == 0;
}

bool ToPoints(JSContext* context, JSValueConst object, const char* name, std::vector<sVec2>& out)
{
	JSValue array = JS_GetPropertyStr(context, object, name);
	int64_t length = 0;
	bool ok = JS_IsArray(array) && JS_GetLength(context, array, &length) == 0;
	for (int64_t i = 0; ok && i < length; i++)
	{
		JSValue point = JS_GetPropertyUint32(context, array, u32(i));
		JSValue x = JS_GetPropertyUint32(context, point, 0);
		JSValue y = JS_GetPropertyUint32(context, point, 1);
		sVec2 p;
		ok = ToNumber(context, x, p.x) && ToNumber(context, y, p.y);
		out.push_back(p);
		JS_FreeValue(context, x);
		JS_FreeValue(context, y);
		JS_FreeValue(context, point);
	}
	JS_FreeValue(context, array);
	return ok;
}

/** A value the script returned, back in model form; false when it is none the planner can use. */
bool FromJs(JSContext* context, JSValueConst value, CValue& out)
{
	f64 number = 0;
	if (ToNumber(context, value, number))
	{
		out = CValue::Number(number);
		return true;
	}
	if (JS_IsArray(value))
	{
		int64_t length = 0;
		if (JS_GetLength(context, value, &length) != 0 || length < 1 || length > CValue::MAX_COMPONENTS)
		{
			return false;
		}
		f64 parts[CValue::MAX_COMPONENTS];
		for (int64_t i = 0; i < length; i++)
		{
			JSValue part = JS_GetPropertyUint32(context, value, u32(i));
			const bool ok = ToNumber(context, part, parts[i]);
			JS_FreeValue(context, part);
			if (!ok)
			{
				return false;
			}
		}
		out = CValue::Vector(parts, u32(length));
		return true;
	}
	if (JS_IsObject(value))
	{
		auto shape = std::make_shared<sShape>();
		JSValue closed = JS_GetPropertyStr(context, value, "closed");
		shape->m_bClosed = JS_ToBool(context, closed) > 0;
		JS_FreeValue(context, closed);
		if (ToPoints(context, value, "vertices", shape->m_Vertices) && ToPoints(context, value, "inTangents", shape->m_InTangents) &&
			ToPoints(context, value, "outTangents", shape->m_OutTangents))
		{
			out = CValue::Shape(shape);
			return true;
		}
	}
	return false;
}

} /** namespace */

std::unique_ptr<CExpressionEngine> CExpressionEngine::Create(const CProject& project, std::string& error)
{
	std::unique_ptr<CExpressionEngine> engine(new CExpressionEngine());
	if (!engine->Start(project, error))
	{
		return nullptr;
	}
	return engine;
}

CExpressionEngine::~CExpressionEngine()
{
	m_Properties.clear();
	m_Layers.clear();
	m_pApi.reset();
	if (m_pContext)
	{
		JS_FreeContext(m_pContext);
	}
	if (m_pRuntime)
	{
		JS_FreeRuntime(m_pRuntime);
	}
}

std::string CExpressionEngine::Exception()
{
	JSValue exception = JS_GetException(m_pContext);
	const char* text = JS_ToCString(m_pContext, exception);
	std::string message = text ? text : "unknown error";
	if (text)
	{
		JS_FreeCString(m_pContext, text);
	}
	JS_FreeValue(m_pContext, exception);
	return message;
}

bool CExpressionEngine::Start(const CProject& project, std::string& error)
{
	using tClock = std::chrono::steady_clock;
	const tClock::time_point start = tClock::now();
	m_pRuntime = JS_NewRuntime();
	if (!m_pRuntime)
	{
		error = "cannot start QuickJS";
		return false;
	}
	/** Generous for one project's model; a runaway expression fails instead of taking the app down. */
	JS_SetMemoryLimit(m_pRuntime, size_t(512) << 20);
	JS_SetMaxStackSize(m_pRuntime, size_t(1) << 20);
	m_pContext = JS_NewContext(m_pRuntime);
	if (!m_pContext)
	{
		error = "cannot start QuickJS";
		return false;
	}

	JSValue global = JS_GetGlobalObject(m_pContext);
	JSValue native = JS_NewObject(m_pContext);
	JS_SetPropertyStr(m_pContext, native, "decodeText", JS_NewCFunction(m_pContext, DecodeText, "decodeText", 2));
	JS_SetPropertyStr(m_pContext, global, "aep_native", native);

	JSValue result = JS_Eval(m_pContext, reinterpret_cast<const char*>(g_ExpressionBundle), g_ExpressionBundleSize, "bundle.js",
		JS_EVAL_TYPE_GLOBAL);
	if (JS_IsException(result))
	{
		error = "the expression script failed to start: " + Exception();
		JS_FreeValue(m_pContext, global);
		return false;
	}
	JS_FreeValue(m_pContext, result);
	m_pApi.reset(new sHandle(m_pContext, JS_GetPropertyStr(m_pContext, global, "aep")));
	JS_FreeValue(m_pContext, global);

	JSValue load = JS_GetPropertyStr(m_pContext, m_pApi->m_Value, "load");
	JSValue bytes = JS_NewUint8ArrayCopy(m_pContext, project.m_Bytes.data(), project.m_Bytes.size());
	result = JS_Call(m_pContext, load, m_pApi->m_Value, 1, &bytes);
	JS_FreeValue(m_pContext, bytes);
	JS_FreeValue(m_pContext, load);
	if (JS_IsException(result))
	{
		error = "the expression script could not read the project: " + Exception();
		return false;
	}
	JS_FreeValue(m_pContext, result);

	for (const auto& entry : project.m_Items)
	{
		const CItem& item = *entry.second;
		if (item.m_eKind != ITEM_COMP)
		{
			continue;
		}
		for (const auto& layer : item.m_Layers)
		{
			MapLayer(item, *layer);
		}
	}
	m_fStartupMs = std::chrono::duration<f64, std::milli>(tClock::now() - start).count();
	return true;
}

void CExpressionEngine::MapLayer(const CItem& comp, const CLayer& layer)
{
	std::vector<std::pair<std::string, u32>> path;
	const size_t before = m_Properties.size();
	for (const auto& child : layer.m_Properties.m_Children)
	{
		/** Occurrences count among siblings with the same match name, as the script looks them up. */
		u32 occurrence = 0;
		for (const auto& other : layer.m_Properties.m_Children)
		{
			if (other.get() == child.get())
			{
				break;
			}
			occurrence += other->m_MatchName == child->m_MatchName ? 1 : 0;
		}
		path.assign(1, { child->m_MatchName, occurrence });
		MapNode(*child, comp, layer, path);
	}
	if (m_Properties.size() == before)
	{
		return;
	}
	JSValue find = JS_GetPropertyStr(m_pContext, m_pApi->m_Value, "layer");
	JSValue args[2] = { JS_NewFloat64(m_pContext, comp.m_uId), JS_NewFloat64(m_pContext, layer.m_iIndex) };
	JSValue found = JS_Call(m_pContext, find, m_pApi->m_Value, 2, args);
	JS_FreeValue(m_pContext, find);
	if (JS_IsObject(found))
	{
		m_Layers[&layer].reset(new sHandle(m_pContext, found));
	}
	else
	{
		JS_FreeValue(m_pContext, found);
	}
}

void CExpressionEngine::MapNode(const CPropertyNode& node, const CItem& comp, const CLayer& layer,
	std::vector<std::pair<std::string, u32>>& path)
{
	if (node.m_bGroup)
	{
		for (const auto& child : node.m_Children)
		{
			u32 occurrence = 0;
			for (const auto& other : node.m_Children)
			{
				if (other.get() == child.get())
				{
					break;
				}
				occurrence += other->m_MatchName == child->m_MatchName ? 1 : 0;
			}
			path.push_back({ child->m_MatchName, occurrence });
			MapNode(*child, comp, layer, path);
			path.pop_back();
		}
		return;
	}
	if (!node.m_bExpressionEnabled || node.m_Expression.empty())
	{
		return;
	}
	JSValue array = JS_NewArray(m_pContext);
	for (size_t i = 0; i < path.size(); i++)
	{
		JSValue step = JS_NewArray(m_pContext);
		JS_SetPropertyUint32(m_pContext, step, 0, JS_NewStringLen(m_pContext, path[i].first.data(), path[i].first.size()));
		JS_SetPropertyUint32(m_pContext, step, 1, JS_NewFloat64(m_pContext, path[i].second));
		JS_SetPropertyUint32(m_pContext, array, u32(i), step);
	}
	JSValue find = JS_GetPropertyStr(m_pContext, m_pApi->m_Value, "property");
	JSValue args[3] = { JS_NewFloat64(m_pContext, comp.m_uId), JS_NewFloat64(m_pContext, layer.m_iIndex), array };
	JSValue found = JS_Call(m_pContext, find, m_pApi->m_Value, 3, args);
	JS_FreeValue(m_pContext, array);
	JS_FreeValue(m_pContext, find);
	if (JS_IsObject(found))
	{
		m_Properties[&node].reset(new sHandle(m_pContext, found));
	}
	else
	{
		JS_FreeValue(m_pContext, found);
	}
}

void CExpressionEngine::BeginFrame()
{
	JSValue begin = JS_GetPropertyStr(m_pContext, m_pApi->m_Value, "beginFrame");
	JS_FreeValue(m_pContext, JS_Call(m_pContext, begin, m_pApi->m_Value, 0, nullptr));
	JS_FreeValue(m_pContext, begin);
}

void CExpressionEngine::TakeWarnings(std::vector<std::string>& out)
{
	JSValue take = JS_GetPropertyStr(m_pContext, m_pApi->m_Value, "warnings");
	JSValue list = JS_Call(m_pContext, take, m_pApi->m_Value, 0, nullptr);
	int64_t length = 0;
	if (JS_IsArray(list) && JS_GetLength(m_pContext, list, &length) == 0)
	{
		for (int64_t i = 0; i < length; i++)
		{
			JSValue item = JS_GetPropertyUint32(m_pContext, list, u32(i));
			if (const char* text = JS_ToCString(m_pContext, item))
			{
				out.push_back(text);
				JS_FreeCString(m_pContext, text);
			}
			JS_FreeValue(m_pContext, item);
		}
	}
	JS_FreeValue(m_pContext, list);
	JS_FreeValue(m_pContext, take);
	out.insert(out.end(), m_Errors.begin(), m_Errors.end());
	m_Errors.clear();
}

CValue CExpressionEngine::Evaluate(const CPropertyNode& prop, f64 compTime, const CLayer& layer, const CValue& pre)
{
	const auto property = m_Properties.find(&prop);
	const auto owner = m_Layers.find(&layer);
	/** Gradients and values the script has no form for stay as they are (engine.ts skips them too). */
	if (property == m_Properties.end() || owner == m_Layers.end() || pre.IsGradient() || pre.IsNone())
	{
		return pre;
	}
	JSValue evaluate = JS_GetPropertyStr(m_pContext, m_pApi->m_Value, "evaluate");
	JSValue args[4] = { property->second->m_Value, JS_NewFloat64(m_pContext, compTime), owner->second->m_Value, ToJs(m_pContext, pre) };
	JSValue result = JS_Call(m_pContext, evaluate, m_pApi->m_Value, 4, args);
	JS_FreeValue(m_pContext, args[3]);
	JS_FreeValue(m_pContext, evaluate);
	CValue out = pre;
	if (JS_IsException(result))
	{
		m_Errors.push_back("expression engine: " + Exception());
	}
	else if (!FromJs(m_pContext, result, out))
	{
		out = pre;
	}
	JS_FreeValue(m_pContext, result);
	return out;
}

} /** namespace aep */
