// The expression evaluator installed into src/aep/evaluate.ts: compiles each
// property's expression once, runs it against the object model in api.ts, and
// turns the result back into a model value. A failing expression leaves the
// property at its pre-expression value and reports
// "Expression error on <layer> > <property>: ...".
import { currentValue, getExpressionScope, valueAtTime, type ExpressionScope } from "../aep/evaluate.ts";
import {
  isGradientValue,
  isShapeValue,
  PropertyValueType,
  type Layer,
  type Property,
  type PropertyValue,
} from "../aep/model.ts";
import { Api, expressionDimensions, shapeOf, textDocumentOf, type EvalFrame, type Host } from "./api.ts";
import { compileExpression, type CompiledExpression } from "./compile.ts";
import { ProjectIndex } from "./projectIndex.ts";
import { hashWords, noise, RandomStream, timeWords } from "./random.ts";
import { helpers, jsGlobals, unwrap } from "./sandbox.ts";
import * as V from "./vector.ts";

/** Properties whose values expressions cannot produce (markers, no-value groups; gradients are checked by value). */
const SKIPPED_TYPES = new Set<number>([PropertyValueType.MARKER, PropertyValueType.NO_VALUE]);

/** Values AE limits to 0..100 whatever the expression returns. */
const PERCENT = new Set(["ADBE Opacity", "ADBE Vector Group Opacity", "ADBE Vector Fill Opacity", "ADBE Vector Stroke Opacity", "ADBE Mask Opacity"]);

class CycleError extends Error {
  override name = "Error";
}

interface Frame extends EvalFrame {
  siblings: ReturnType<ProjectIndex["siblings"]>;
  /** Pre-expression value at `time`, computed on demand. */
  pre: { time: number; value: PropertyValue } | null;
  /** Set when the evaluation took part in a reference cycle. */
  cycle: boolean;
}

interface Result {
  value: PropertyValue;
  warning?: string;
}

const copy = (v: PropertyValue): PropertyValue => (Array.isArray(v) ? [...v] : isShapeValue(v) ? structuredCloneShape(v) : v);

function structuredCloneShape(s: import("../aep/model.ts").Shape) {
  return { closed: s.closed, vertices: s.vertices.map((p) => [...p]), inTangents: s.inTangents.map((p) => [...p]), outTangents: s.outTangents.map((p) => [...p]) };
}

const cleanMessage = (message: string) => message.replace(/\bv_(?=[A-Za-z_$])/g, "");

export class ExpressionEngine implements Host {
  readonly index = new ProjectIndex();
  readonly api: Api = new Api(this);
  private scope: ExpressionScope | undefined;
  private results = new WeakMap<Property, Map<number, Result>>();
  private readonly compiled = new WeakMap<Property, { source: string; legacy: boolean; result: CompiledExpression | Error }>();
  private readonly stack: Frame[] = [];
  private readonly globals: Readonly<Record<string, unknown>>;
  private readonly context: object;

  constructor() {
    this.globals = this.makeGlobals();
    this.context = this.makeContext();
  }

  frame(): Frame {
    const f = this.stack[this.stack.length - 1];
    if (!f) throw new Error("no expression is being evaluated");
    return f;
  }

  modelValue(prop: Property, layer: Layer, t: number): PropertyValue {
    const siblings = this.index.siblings(layer, prop);
    const own = this.stack[this.stack.length - 1]?.prop;
    if (prop === own || (own && prop.matchName === "ADBE Position" && siblings.includes(own))) return copy(valueAtTime(prop, t, layer, siblings));
    return copy(currentValue(prop, t, layer, siblings));
  }

  posterize(fps: number): void {
    const f = this.frame();
    f.time = fps > 0 ? Math.floor(f.time * fps + 1e-9) / fps : 0;
  }

  /** The `ExpressionEvaluator` for setExpressionEvaluator(). */
  readonly evaluate = (prop: Property, compTime: number, layer: Layer, pre: PropertyValue): PropertyValue => {
    const scope = getExpressionScope();
    if (!scope || !prop.expression || SKIPPED_TYPES.has(prop.propertyValueType) || isGradientValue(pre)) return pre;
    if (prop.propertyValueType === PropertyValueType.TEXT_DOCUMENT && !textDocumentOf(pre)) return pre;
    if (scope !== this.scope) {
      this.scope = scope;
      this.results = new WeakMap();
      this.index.add(scope.project);
    }
    let byTime = this.results.get(prop);
    const hit = byTime?.get(compTime);
    if (hit) {
      if (hit.warning) scope.warn(hit.warning);
      return copy(hit.value);
    }
    const open = this.stack.findIndex((f) => f.prop === prop);
    if (open >= 0) {
      for (let i = open; i < this.stack.length; i++) this.stack[i].cycle = true;
      throw new CycleError(`expression cycle: ${[...this.stack.slice(open), this.stack[open]].map((f) => this.describe(f.layer, f.prop)).join(" -> ")}`);
    }
    const comp = this.index.comp(layer);
    if (!comp) return pre;
    const result = this.run(prop, compTime, layer, pre, comp, scope);
    if (result.warning) scope.warn(result.warning);
    if (!result.cycle) {
      if (!byTime) this.results.set(prop, (byTime = new Map()));
      byTime.set(compTime, { value: result.value, warning: result.warning });
    }
    return copy(result.value);
  };

  private compile(prop: Property, legacy: boolean): CompiledExpression | Error {
    const source = prop.expression!;
    const cached = this.compiled.get(prop);
    if (cached && cached.source === source && cached.legacy === legacy) return cached.result;
    let result: CompiledExpression | Error;
    try {
      result = compileExpression(source, { legacy });
    } catch (error) {
      result = error instanceof Error ? error : new Error(String(error));
    }
    this.compiled.set(prop, { source, legacy, result });
    return result;
  }

  private describe(layer: Layer, prop: Property): string {
    return [layer.name, ...this.index.path(layer, prop).map((n) => n.name)].join(" > ");
  }

  private run(prop: Property, compTime: number, layer: Layer, pre: PropertyValue, comp: import("../aep/model.ts").CompItem, scope: ExpressionScope): Result & { cycle: boolean } {
    const compiled = this.compile(prop, scope.project.expressionEngine === "extendscript");
    const fail = (error: unknown, cycle = false) => {
      const e = error as { name?: unknown; message?: unknown };
      const text = error instanceof Error || (e && typeof e === "object" && "message" in e) ? `${String(e.name ?? "Error")}: ${cleanMessage(String(e.message))}` : `uncaught ${cleanMessage(String(error))}`;
      return { value: pre, warning: `Expression error on ${this.describe(layer, prop)}: ${text}`, cycle };
    };
    if (compiled instanceof Error) return fail(compiled);
    const frame: Frame = {
      prop,
      layer,
      comp,
      project: scope.project,
      time: compTime,
      seedOffset: 0,
      timeless: false,
      siblings: this.index.siblings(layer, prop),
      pre: { time: compTime, value: pre },
      cycle: false,
    };
    this.stack.push(frame);
    let value: PropertyValue;
    try {
      // A property object as the result stands for its value, read while the frame is still current.
      value = this.toModel(prop, layer, compiled.run(helpers, this.globals, this.context), pre);
    } catch (error) {
      return fail(error, frame.cycle);
    } finally {
      this.stack.pop();
    }
    if (frame.cycle) return fail(new Error("the expression is part of a reference cycle"), true);
    return { value, cycle: false };
  }

  /** Converts an expression result to the property's model value. */
  private toModel(prop: Property, layer: Layer, result: unknown, pre: PropertyValue): PropertyValue {
    if (prop.propertyValueType === PropertyValueType.SHAPE || isShapeValue(pre)) {
      const shape = shapeOf(result);
      if (!shape) throw new TypeError("the result of a path expression must be a path (use createPath() or a path property)");
      return structuredCloneShape(shape);
    }
    const r = unwrap(result);
    const doc = textDocumentOf(pre);
    if (prop.propertyValueType === PropertyValueType.TEXT_DOCUMENT && doc) {
      // Paragraphs are CR-separated in text documents.
      return { ...doc, text: String(r ?? "").replace(/\r\n|\n/g, "\r") } as unknown as PropertyValue;
    }
    const dims = expressionDimensions(prop, layer, pre);
    if (dims === 0) throw new TypeError("the property's value cannot be set by an expression");
    const finite = (x: unknown) => {
      const n = typeof x === "boolean" ? Number(x) : (unwrap(x) as number);
      if (typeof n !== "number" || !Number.isFinite(n)) throw new TypeError("the expression result must be a finite number");
      return n;
    };
    let value: PropertyValue;
    if (dims === 1) {
      if (Array.isArray(r)) {
        if (r.length !== 1) throw new TypeError(`the expression result must be of dimension 1, not ${r.length}`);
        value = finite(r[0]);
      } else value = finite(r);
    } else {
      if (!Array.isArray(r)) throw new TypeError(`the expression result must be of dimension ${dims}, not 1`);
      const v = (r as unknown[]).map(finite);
      const model = pre as number[];
      if (v.length < dims) {
        if (prop.propertyValueType === PropertyValueType.COLOR && v.length === 3) v.push(1);
        else throw new TypeError(`the expression result must be of dimension ${dims}, not ${v.length}`);
      }
      value = v.slice(0, dims);
      while ((value as number[]).length < model.length) (value as number[]).push(model[(value as number[]).length]);
    }
    if (typeof value === "number") {
      if (PERCENT.has(prop.matchName)) value = Math.min(100, Math.max(0, value));
      if (prop.min !== undefined) value = Math.max(prop.min, value);
      if (prop.max !== undefined) value = Math.min(prop.max, value);
    }
    return value;
  }

  // --- what expressions see -------------------------------------------------------------

  private preValue(f: Frame): PropertyValue {
    if (!f.pre || f.pre.time !== f.time) f.pre = { time: f.time, value: valueAtTime(f.prop, f.time, f.layer, f.siblings) };
    return f.pre.value;
  }

  private makeContext(): object {
    const ctx = {};
    const getter = (name: string, get: () => unknown) => Object.defineProperty(ctx, name, { get, enumerable: false });
    const thisComp = () => this.api.comp(this.frame().comp);
    const thisLayer = () => this.api.layer(this.frame().layer, this.frame().comp);
    const thisProperty = () => this.api.property(this.frame().prop, this.frame().layer, this.frame().comp);
    getter("time", () => this.frame().time);
    getter("value", () => {
      const f = this.frame();
      return this.api.toExpression(f.prop, f.layer, copy(this.preValue(f)));
    });
    getter("thisComp", thisComp);
    getter("thisLayer", thisLayer);
    getter("thisProperty", thisProperty);
    getter("thisProject", () => this.api.project(this.frame().project));
    getter("colorDepth", () => this.frame().project.bitsPerChannel);
    getter("this_comp", thisComp);
    getter("this_layer", thisLayer);
    getter("this_property", thisProperty);
    return Object.freeze(ctx);
  }

  private rng(): RandomStream {
    const f = this.frame();
    if (!f.rng) {
      const path = this.index.path(f.layer, f.prop).map((n) => this.index.indexInParent(f.layer, n));
      const t = f.timeless ? [0, 0] : timeWords(f.time);
      f.rng = new RandomStream(hashWords(0x72616e64, f.layer.index, ...path, Math.round(f.seedOffset * 1000), ...t));
    }
    return f.rng;
  }

  private makeGlobals(): Readonly<Record<string, unknown>> {
    const frame = () => this.frame();
    const fps = () => 1 / frame().comp.frameDuration;
    const displayTime = (t: unknown) => (t === undefined ? frame().time + frame().comp.displayStartTime : V.scalar(t));
    const ranged = (sample: () => number, args: unknown[]) => {
      if (args.length === 0) return sample();
      const [a, b] = args.length === 1 ? [0, V.num(args[0])] : [V.num(args[0]), V.num(args[1])];
      if (!Array.isArray(a) && !Array.isArray(b)) return a + (b - a) * sample();
      const lo = V.vec(a);
      const hi = V.vec(b);
      const n = Math.max(Array.isArray(a) ? lo.length : 0, Array.isArray(b) ? hi.length : 0);
      return Array.from({ length: n }, (_, i) => {
        const l = Array.isArray(a) ? (lo[i] ?? 0) : (a as number);
        const h = Array.isArray(b) ? (hi[i] ?? 0) : (b as number);
        return l + (h - l) * sample();
      });
    };
    const timecode = (t: number, base: number) => {
      const frames = Math.floor(t * base + 1e-6);
      const f = Math.abs(frames);
      const b = Math.round(base);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${frames < 0 ? "-" : ""}${Math.floor(f / (b * 3600))}:${pad(Math.floor(f / (b * 60)) % 60)}:${pad(Math.floor(f / b) % 60)}:${pad(f % b)}`;
    };
    const ae: Record<string, unknown> = {
      comp: (name: unknown) => {
        const found = this.index.compByName(frame().project, String(unwrap(name)));
        if (!found) throw new Error(`no composition named '${String(unwrap(name))}'`);
        return this.api.comp(found);
      },
      footage: (name: unknown) => {
        const found = this.index.footageByName(frame().project, String(unwrap(name)));
        if (!found) throw new Error(`no footage named '${String(unwrap(name))}'`);
        return this.api.footage(found);
      },
      posterizeTime: (rate: unknown) => {
        this.posterize(V.scalar(rate));
      },
      linear: (...args: unknown[]) => V.interpolate(V.EASES.linear, args),
      ease: (...args: unknown[]) => V.interpolate(V.EASES.ease, args),
      easeIn: (...args: unknown[]) => V.interpolate(V.EASES.easeIn, args),
      easeOut: (...args: unknown[]) => V.interpolate(V.EASES.easeOut, args),
      clamp: V.clamp,
      add: (a: unknown, b: unknown) => helpers.add(V.num(a), V.num(b)),
      sub: (a: unknown, b: unknown) => helpers.sub(V.num(a), V.num(b)),
      mul: (a: unknown, b: unknown) => helpers.mul(V.num(a), V.num(b)),
      div: (a: unknown, b: unknown) => helpers.div(V.num(a), V.num(b)),
      length: V.length,
      normalize: V.normalize,
      dot: V.dot,
      cross: V.cross,
      lookAt: V.lookAt,
      degreesToRadians: (d: unknown) => (V.scalar(d) * Math.PI) / 180,
      radiansToDegrees: (r: unknown) => (V.scalar(r) * 180) / Math.PI,
      rgbToHsl: V.rgbToHsl,
      hslToRgb: V.hslToRgb,
      hexToRgb: V.hexToRgb,
      timeToFrames: (t?: unknown, rate?: unknown, isDuration?: unknown) => {
        const frames = displayTime(t) * (rate === undefined ? fps() : V.scalar(rate));
        return unwrap(isDuration) ? Math.round(frames) : Math.floor(frames + 1e-6);
      },
      framesToTime: (frames: unknown, rate?: unknown) => V.scalar(frames) / (rate === undefined ? fps() : V.scalar(rate)),
      timeToTimecode: (t?: unknown, base: unknown = 30) => timecode(displayTime(t), V.scalar(base)),
      timeToNTSCTimecode: (t?: unknown) => timecode(displayTime(t), 30),
      timeToCurrentFormat: (t?: unknown, rate?: unknown) => timecode(displayTime(t), rate === undefined ? fps() : V.scalar(rate)),
      timeToFeetAndFrames: (t?: unknown, rate?: unknown, framesPerFoot: unknown = 16) => {
        const frames = Math.floor(displayTime(t) * (rate === undefined ? fps() : V.scalar(rate)) + 1e-6);
        const per = V.scalar(framesPerFoot);
        return `${Math.floor(frames / per)}+${String(frames % per).padStart(2, "0")}`;
      },
      random: (...args: unknown[]) => ranged(() => this.rng().next(), args),
      gaussRandom: (...args: unknown[]) => ranged(() => 0.5 + this.rng().gaussian() * (0.5 / 1.6448536269514722), args),
      seedRandom: (offset: unknown, timeless: unknown = false) => {
        const f = frame();
        f.seedOffset = V.scalar(offset);
        f.timeless = !!unwrap(timeless);
        f.rng = undefined;
      },
      noise: (p: unknown) => noise(V.vec(p)),
      createPath: (...args: unknown[]) => this.api.createPath(...args),
      $: Object.freeze({ writeln: () => undefined, write: () => undefined, engineName: "aep-web" }),
    };
    return Object.freeze({ ...jsGlobals, ...ae });
  }
}
