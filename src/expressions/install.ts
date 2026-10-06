import { setExpressionEvaluator } from "../aep/evaluate.ts";
import { ExpressionEngine } from "./engine.ts";

export const expressionEngine = new ExpressionEngine();
setExpressionEvaluator(expressionEngine.evaluate);
