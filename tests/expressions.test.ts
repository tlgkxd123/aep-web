import { afterEach, describe, expect, test } from "vitest";
import { currentValue, setExpressionScope } from "../src/aep/evaluate.ts";
import { PropertyValueType, type CompItem, type Keyframe, type Layer, type Project, type Property, type PropertyGroup, type PropertyNode, type PropertyValue } from "../src/aep/model.ts";
import { compileExpression, ExpressionSecurityError, verifyOutput } from "../src/expressions/compile.ts";
import "../src/expressions/install.ts";

// --- a small synthetic project ------------------------------------------------------

function prop(matchName: string, name: string, value: PropertyValue, type: number, extra: Partial<Property> = {}): Property {
  return {
    kind: "property",
    matchName,
    name,
    propertyValueType: type,
    value,
    keyframes: [],
    expression: "",
    expressionEnabled: false,
    enabled: true,
    dimensionsSeparated: false,
    isSpatial: false,
    canVaryOverTime: true,
    ...extra,
  };
}

function group(matchName: string, name: string, children: PropertyNode[], extra: Partial<PropertyGroup> = {}): PropertyGroup {
  return { kind: "group", matchName, name, enabled: true, children, ...extra };
}

function transform(position = [80, 60, 0]): PropertyGroup {
  const { OneD, TwoD_SPATIAL, ThreeD } = PropertyValueType;
  return group("ADBE Transform Group", "Transform", [
    prop("ADBE Anchor Point", "Anchor Point", [0, 0, 0], TwoD_SPATIAL),
    prop("ADBE Position", "Position", position, TwoD_SPATIAL),
    prop("ADBE Scale", "Scale", [100, 100, 100], ThreeD),
    prop("ADBE Rotate Z", "Rotation", 0, OneD),
    prop("ADBE Opacity", "Opacity", 100, OneD),
  ]);
}

function slider(name: string, value: number): PropertyGroup {
  return group("ADBE Slider Control", name, [prop("ADBE Slider Control-0001", "Slider", value, PropertyValueType.OneD)], { isEffect: true, effectName: "Slider Control" });
}

let nextId = 1;
function layer(name: string, properties: PropertyNode[], extra: Partial<Layer> = {}): Layer {
  return {
    id: nextId++,
    index: 0,
    name,
    matchName: "ADBE AV Layer",
    layerType: "AVLayer",
    comment: "",
    sourceId: 0,
    startTime: 0,
    inPoint: 0,
    outPoint: 10,
    stretch: 100,
    enabled: true,
    threeDLayer: false,
    parentId: 0,
    width: 100,
    height: 50,
    properties,
    ...extra,
  } as Layer;
}

function project(layers: Layer[], engine = "javascript-1.0"): { project: Project; comp: CompItem } {
  layers.forEach((l, i) => (l.index = i + 1));
  const comp = {
    kind: "comp",
    typeName: "Composition",
    id: 100,
    name: "Main",
    comment: "",
    label: 0,
    parentFolderId: 0,
    width: 160,
    height: 120,
    duration: 10,
    frameRate: 24,
    frameDuration: 1 / 24,
    pixelAspect: 1,
    bgColor: [0, 0, 0],
    displayStartTime: 0,
    shutterAngle: 180,
    shutterPhase: -90,
    layers,
  } as unknown as CompItem;
  const items = new Map<number, CompItem>([[comp.id, comp]]);
  return { project: { version: "test", expressionEngine: engine, bitsPerChannel: 8, items, effectTypes: new Map(), effectParams: new Map(), warnings: [] } as unknown as Project, comp };
}

function key(time: number, value: PropertyValue): Keyframe {
  return {
    time,
    layerTime: time,
    value,
    inInterpolationType: 6612,
    outInterpolationType: 6612,
    inTemporalEase: [{ speed: 0, influence: 16.666 }],
    outTemporalEase: [{ speed: 0, influence: 16.666 }],
    spatialAutoBezier: false,
    spatialContinuous: false,
    temporalAutoBezier: false,
    temporalContinuous: false,
    roving: false,
    label: 0,
  };
}

const find = (l: Layer, matchName: string): Property => {
  let found: Property | undefined;
  const walk = (nodes: PropertyNode[]) => nodes.forEach((n) => (n.kind === "group" ? walk(n.children) : n.matchName === matchName && !found && (found = n)));
  walk(l.properties);
  return found!;
};

const siblingsOf = (l: Layer, p: Property): PropertyNode[] => {
  let out: PropertyNode[] = l.properties;
  const walk = (nodes: PropertyNode[]) => nodes.forEach((n) => (n === p ? (out = nodes) : n.kind === "group" && walk(n.children)));
  walk(l.properties);
  return out;
};

/** Evaluates `source` as the expression of `matchName` on the first layer (Rotation by default). */
function run(source: string, opts: { time?: number; matchName?: string; layers?: Layer[]; engine?: string } = {}) {
  const layers = opts.layers ?? [layer("A", [transform(), group("ADBE Effect Parade", "Effects", [slider("Amount", 7)])]), layer("B", [transform([10, 20, 0])])];
  const { project: p } = project(layers, opts.engine);
  const target = find(layers[0], opts.matchName ?? "ADBE Rotate Z");
  target.expression = source;
  target.expressionEnabled = true;
  const warnings: string[] = [];
  setExpressionScope({ project: p, warn: (m) => warnings.push(m) });
  const value = currentValue(target, opts.time ?? 0, layers[0], siblingsOf(layers[0], target));
  return { value, warnings };
}

const value = (source: string, opts?: Parameters<typeof run>[1]) => {
  const r = run(source, opts);
  if (r.warnings.length) throw new Error(r.warnings.join("\n"));
  return r.value;
};

const error = (source: string, opts?: Parameters<typeof run>[1]) => {
  const r = run(source, opts);
  expect(r.warnings).toHaveLength(1);
  return r.warnings[0];
};

afterEach(() => setExpressionScope(undefined));

// --- security -----------------------------------------------------------------------

describe("the sandbox keeps expressions away from the host", () => {
  const escapes = [
    'this.constructor.constructor("return window")()',
    '[].constructor.constructor("return globalThis")()',
    "[].constructor",
    '({}).constructor.constructor("return this")()',
    '"".constructor.constructor("return this")()',
    "(()=>{}).constructor",
    'Math.max.constructor("return this")()',
    "var f = function(){}; f.constructor",
    'var k = "constr" + "uctor"; [][k][k]("return this")()',
    'var k = {toString(){ return "constructor" }}; [][k]',
    "const {constructor: c} = []; c",
    "const {constructor: {constructor: F}} = []; F",
    "[].__proto__",
    "Object.prototype",
    "var o = {}; o.__proto__ = null",
    "({__proto__: null})",
    "(function(){ return arguments.callee })()",
    "(function f(){ return f.caller })()",
    '[].__lookupGetter__("x")',
    "import('data:text/javascript,1')",
    "fetch('https://example.com')",
    "window",
    "document",
    "globalThis",
    "self",
    "process",
    "require",
    "setTimeout(function(){}, 0)",
    "Function('return this')()",
    "eval('1')",
    "Reflect",
    "Proxy",
    "Promise",
    "localStorage",
    "XMLHttpRequest",
    "WebAssembly",
    "Symbol",
    "Error.prepareStackTrace = function(){}",
    "Math.max = function(){}",
    "thisLayer.name = 'x'",
    "delete Math.max",
    "Object.keys.x = 1",
    "async function f(){}",
    "function* g(){}",
    "with ({}) {}",
    "new.target",
    "class A extends Object {}",
    "label: for(;;) { break label; } this.constructor",
    "for (;;) {}",
    "while (true) {}",
    "(() => this)().constructor",
  ];
  for (const source of escapes) {
    test(source, () => {
      const r = run(source);
      expect(r.warnings, `expression ${source} was accepted with value ${JSON.stringify(r.value)}`).toHaveLength(1);
      expect(r.value).toBe(0);
    });
  }

  test("generated code only names helper parameters and renamed bindings", () => {
    const { code } = compileExpression("var x = [1,2] + value; function f(a){ return a * 2 } f(x)[0] + thisComp.layer(1).index");
    expect(() => verifyOutput(code)).not.toThrow();
    expect(() => verifyOutput("window.alert(1)")).toThrow(ExpressionSecurityError);
    expect(() => verifyOutput("$$h.constructor")).toThrow(ExpressionSecurityError);
    expect(() => verifyOutput("this")).toThrow(ExpressionSecurityError);
  });

  test("API objects cannot be modified or used to reach their internals", () => {
    expect(error("thisLayer.foo = 1")).toMatch(/cannot be modified/);
    expect(error("thisComp.layer(1).transform.constructor")).toMatch(/not allowed/);
    expect(error("Object.entries(thisLayer).length > 0 ? 1 : thisLayer.valueOf.constructor")).toMatch(/not allowed/);
  });

  test("a runaway loop stops at the iteration budget", () => {
    expect(error("var i = 0; while (true) { i++ } i")).toMatch(/loop budget/);
  });
});

// --- language -----------------------------------------------------------------------

describe("language", () => {
  test("the last expression statement is the result", () => {
    expect(value("1; 2; 3")).toBe(3);
    expect(value("var x = 5; x * 2")).toBe(10);
    expect(value("let y = 2; const z = 3; y + z")).toBe(5);
    expect(value("if (time > 1) 10; else if (time > 0.5) 20; else 30")).toBe(30);
    expect(value("x = 4; x")).toBe(4);
    expect(value("function sq(v) { return v * v } sq(6)")).toBe(36);
    expect(value("var r = 0; for (var i = 0; i < 4; i++) r += i; r")).toBe(6);
    expect(value("[1, 2, 3].map(v => v * 2).reduce((a, b) => a + b)")).toBe(12);
    expect(value("var s = 0; for (const v of [1, 2]) { s += v } s")).toBe(3);
    expect(value("try { throw new Error('x') } catch (e) { 9 }")).toBe(9);
    expect(value("`${1 + 1}`.length")).toBe(1);
  });

  test("vector arithmetic", () => {
    const pos = { matchName: "ADBE Position" };
    expect(value("[1, 2] + [3, 4]", pos)).toEqual([4, 6, 0]);
    expect(value("[10, 20] - [1, 2]", pos)).toEqual([9, 18, 0]);
    expect(value("value * 2", pos)).toEqual([160, 120, 0]);
    expect(value("2 * value", pos)).toEqual([160, 120, 0]);
    expect(value("value / 2", pos)).toEqual([40, 30, 0]);
    expect(value("-value", pos)).toEqual([-80, -60, 0]);
    expect(value("var v = value; v += [1, 1]; v", pos)).toEqual([81, 61, 0]);
    expect(value("[1, 2] + 5", pos)).toEqual([6, 2, 0]);
  });

  test("a 2D layer's Position is 2D in expressions; a 3D layer's is 3D", () => {
    const flat = [layer("A", [transform([80, 60, 0])])];
    expect(value("value", { matchName: "ADBE Position", layers: flat })).toEqual([80, 60, 0]);
    expect(value("transform.position.value.length", { layers: [layer("A", [transform()])] })).toBe(2);
    const deep = [layer("A", [transform([1, 2, 3])], { threeDLayer: true })];
    expect(value("[value.length, 0, 0]", { matchName: "ADBE Position", layers: deep })).toEqual([3, 0, 0]);
  });

  test("Legacy ExtendScript engine: top-level this is thisLayer", () => {
    expect(value("this.index", { engine: "extendscript" })).toBe(1);
    expect(value("this_layer.index + this_comp.numLayers", { engine: "extendscript" })).toBe(3);
  });

  test("errors keep the pre-expression value and say where they happened", () => {
    const r = run("undefinedThing + 1");
    expect(r.value).toBe(0);
    expect(r.warnings[0]).toBe("Expression error on A > Transform > Rotation: ReferenceError: undefinedThing is not defined");
    expect(error("var a = 1; a()")).toMatch(/: TypeError: a is not a function$/);
    expect(error("[1, 2]")).toMatch(/dimension 1, not 2/);
    expect(error("1 +")).toMatch(/SyntaxError/);
  });
});

// --- API ----------------------------------------------------------------------------

describe("API", () => {
  test("context and layer attributes", () => {
    expect(value("time * 10", { time: 2 })).toBe(20);
    expect(value("thisComp.numLayers + thisComp.width / 160")).toBe(3);
    expect(value("thisLayer.index + index")).toBe(2);
    expect(value("thisComp.layer('B').index")).toBe(2);
    expect(value("thisComp.layer(thisLayer, 1).index")).toBe(2);
    expect(value("thisComp.layer('B').transform.position[1]")).toBe(20);
    expect(value("thisComp.layer('B').position[0]")).toBe(10);
    expect(value("width + height")).toBe(150);
    expect(value("thisComp.frameDuration * 24")).toBe(1);
    expect(value("hasParent ? 1 : 2")).toBe(2);
    expect(value("name == 'A' ? 1 : 0")).toBe(1);
    expect(value("thisProperty.name == 'Rotation' ? 1 : 0")).toBe(1);
    expect(value("thisProperty.propertyGroup(1).name == 'Transform' ? 1 : 0")).toBe(1);
    expect(value("thisProperty.propertyIndex")).toBe(4);
  });

  test("effects and parameters", () => {
    expect(value("effect('Amount')('Slider')")).toBe(7);
    expect(value("effect('Amount')(1) * 2")).toBe(14);
    expect(value("effect('Amount').param(1) + 1")).toBe(8);
    expect(value("thisLayer.effect(1)('Slider').value")).toBe(7);
  });

  test("interpolation and math", () => {
    expect(value("linear(0.5, 0, 1, 0, 100)")).toBe(50);
    expect(value("linear(2, 0, 1, 0, 100)")).toBe(100);
    expect(value("linear(0.25, 0, 100)")).toBe(25);
    expect(value("ease(0.5, 0, 1, 0, 100)")).toBeCloseTo(50, 6);
    expect(value("clamp(150, 0, 100)")).toBe(100);
    expect(value("length([3, 4])")).toBe(5);
    expect(value("length([1, 1], [4, 5])")).toBe(5);
    expect(value("dot([1, 2], [3, 4])")).toBe(11);
    expect(value("radiansToDegrees(Math.PI)")).toBe(180);
    expect(value("degreesToRadians(180)")).toBeCloseTo(Math.PI, 12);
    expect(value("normalize([0, 5])[1]")).toBe(1);
    expect(value("cross([1, 0, 0], [0, 1, 0])[2]")).toBe(1);
    expect(value("timeToFrames(1)")).toBe(24);
    expect(value("framesToTime(12)")).toBe(0.5);
  });

  test("cross-property references read post-expression values; cycles fail", () => {
    const a = layer("A", [transform()]);
    const b = layer("B", [transform()]);
    find(b, "ADBE Rotate Z").expression = "45";
    find(b, "ADBE Rotate Z").expressionEnabled = true;
    expect(value("thisComp.layer('B').rotation + 1", { layers: [a, b] })).toBe(46);

    const c = layer("A", [transform()]);
    const d = layer("B", [transform()]);
    find(d, "ADBE Rotate Z").expression = "thisComp.layer('A').rotation + 1";
    find(d, "ADBE Rotate Z").expressionEnabled = true;
    const r = run("thisComp.layer('B').rotation + 1", { layers: [c, d] });
    expect(r.value).toBe(0);
    expect(r.warnings.join("\n")).toMatch(/cycle/);
  });

  test("valueAtTime on self is the pre-expression value", () => {
    const a = layer("A", [transform()]);
    const rot = find(a, "ADBE Rotate Z");
    rot.keyframes = [key(0, 0), key(1, 100)];
    rot.keyframes.forEach((k) => (k.inInterpolationType = k.outInterpolationType = 6612));
    expect(value("valueAtTime(1) + 1", { layers: [a] })).toBe(101);
    expect(value("thisProperty.numKeys * 10 + key(2).time", { layers: [a] })).toBe(21);
  });

  test("loopOut cycles keyframes", () => {
    const a = layer("A", [transform()]);
    const rot = find(a, "ADBE Rotate Z");
    rot.keyframes = [key(0, 0), key(1, 100)];
    expect(value("loopOut('cycle')", { layers: [a], time: 1.5 })).toBeCloseTo(value("valueAtTime(0.5)", { layers: [a], time: 0 }) as number, 9);
    expect(value("loopOut('offset')", { layers: [a], time: 2 })).toBeCloseTo(200, 9);
    expect(value("loopOut('pingpong')", { layers: [a], time: 2 })).toBeCloseTo(0, 9);
  });

  test("posterizeTime quantizes time and value", () => {
    expect(value("posterizeTime(4); time", { time: 0.6 })).toBe(0.5);
  });

  test("random is deterministic per layer, property, seed and time", () => {
    const r1 = value("random()");
    expect(value("random()")).toBe(r1);
    expect(value("seedRandom(5, true); random()")).not.toBe(r1);
    expect(value("seedRandom(5, true); random()", { time: 1 })).toBe(value("seedRandom(5, true); random()", { time: 2 }));
    const r = value("random(10, 20)") as number;
    expect(r).toBeGreaterThanOrEqual(10);
    expect(r).toBeLessThan(20);
  });
});
