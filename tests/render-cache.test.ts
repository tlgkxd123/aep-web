// Reusing layer images between frames: the keys that tell two frames' images apart (src/render/layerKeys.ts),
// the byte-budgeted cache holding them, and dropping WebGL calls that change no state (src/render/gl.ts).
import { afterEach, expect, it } from "vitest";
import { setExpressionEvaluator } from "../src/aep/evaluate.ts";
import {
  KeyframeInterpolationType,
  type CompItem,
  type FootageItem,
  type Item,
  type Keyframe,
  type Layer,
  type Project,
  type Property,
  type PropertyGroup,
  type PropertyNode,
  type PropertyValue,
} from "../src/aep/model.ts";
import { gpuName, isIntegratedGpu } from "../src/playback/viewer.ts";
import { ImageCache } from "../src/render/contentCache.ts";
import { filterRedundantState, type GL } from "../src/render/gl.ts";
import { LayerKeys, type KeyHost } from "../src/render/layerKeys.ts";
import { registerEffect } from "../src/render/registry.ts";

registerEffect("Test Cacheable", (input) => input, { cacheable: true });
registerEffect("Test Uncacheable", (input) => input);

let nextId = 1;
const { HOLD } = KeyframeInterpolationType;

function key(time: number, value: PropertyValue): Keyframe {
  return {
    time,
    layerTime: time,
    value,
    inInterpolationType: HOLD,
    outInterpolationType: HOLD,
    inTemporalEase: [],
    outTemporalEase: [],
    spatialAutoBezier: false,
    spatialContinuous: false,
    temporalAutoBezier: false,
    temporalContinuous: false,
    roving: false,
    label: 0,
  };
}

/** A property with `keys` [time, value] (hold keyframes), else the static `value`. */
function prop(matchName: string, value: PropertyValue, keys: [number, PropertyValue][] = []): Property {
  return {
    kind: "property",
    matchName,
    name: matchName,
    propertyValueType: 0,
    value,
    keyframes: keys.map(([t, v]) => key(t, v)),
    expression: "",
    expressionEnabled: false,
    enabled: true,
    dimensionsSeparated: false,
    isSpatial: false,
    canVaryOverTime: true,
  };
}

function group(matchName: string, children: PropertyNode[]): PropertyGroup {
  return { kind: "group", matchName, name: matchName, enabled: true, children };
}

function transform(opacity: Property = prop("ADBE Opacity", 100)): PropertyGroup {
  return group("ADBE Transform Group", [prop("ADBE Position", [50, 50, 0]), opacity]);
}

function layer(fields: Partial<Layer>): Layer {
  return {
    id: nextId++,
    index: 1,
    name: "layer",
    layerType: "AVLayer",
    sourceId: 0,
    startTime: 0,
    inPoint: 0,
    outPoint: 10,
    stretch: 100,
    enabled: true,
    solo: false,
    threeDLayer: false,
    adjustmentLayer: false,
    effectsActive: true,
    trackMatteType: 5012,
    trackMatteLayerId: 0,
    parentId: 0,
    timeRemapEnabled: false,
    properties: [transform()],
    ...fields,
  } as unknown as Layer;
}

const solid = { kind: "footage", id: 900, name: "solid", mainSource: { sourceType: "SolidSource", color: [1, 1, 1] }, width: 100, height: 100 } as unknown as FootageItem;
const movie = {
  kind: "footage",
  id: 901,
  name: "movie.mp4",
  hasVideo: true,
  frameRate: 30,
  duration: 10,
  mainSource: { sourceType: "FileSource", isStill: false, loop: 1, file: "movie.mp4" },
} as unknown as FootageItem;

function comp(id: number, layers: Layer[]): CompItem {
  return { kind: "comp", id, name: `comp ${id}`, width: 100, height: 100, frameRate: 30, frameDuration: 1 / 30, layers } as unknown as CompItem;
}

function keysFor(items: Item[]): LayerKeys {
  const project = { items: new Map(items.map((i) => [i.id, i])) } as unknown as Project;
  const isActive = (l: Layer, t: number) => t >= l.inPoint && t < l.outPoint;
  const host: KeyHost = {
    project,
    drawOrder: (c, t) => [...c.layers].reverse().filter((l) => l.enabled && isActive(l, t)),
    matteLayerOf: () => undefined,
    isActive,
  };
  return new LayerKeys(host);
}

/** The keys of a layer at two times, each computed as in its own frame. */
function imageKeys(keys: LayerKeys, l: Layer, a: number, b: number): [string | null, string | null] {
  keys.newFrame();
  const first = keys.image(l, a);
  keys.newFrame();
  return [first, keys.image(l, b)];
}

afterEach(() => setExpressionEvaluator(undefined));

it("keys a static layer the same at every time, and leaves its transform to the placement key", () => {
  const still = layer({ sourceId: solid.id, properties: [transform(prop("ADBE Opacity", 100, [[0, 100], [1, 40]]))] });
  const keys = keysFor([solid]);
  const [a, b] = imageKeys(keys, still, 0.5, 1.5);
  expect(a).not.toBeNull();
  expect(a).toBe(b);
  const parent = comp(1, [still]);
  keys.newFrame();
  const before = keys.placement(still, parent, 0.5);
  keys.newFrame();
  expect(keys.placement(still, parent, 1.5)).not.toBe(before);
});

it("keys animated masks and effect values by their value at the time, holds included", () => {
  const masked = layer({
    sourceId: solid.id,
    properties: [
      transform(),
      group("ADBE Mask Parade", [group("ADBE Mask Atom", [prop("ADBE Mask Opacity", 100, [[0, 100], [1, 50]])])]),
      group("ADBE Effect Parade", [group("Test Cacheable", [prop("Test Cacheable-0001", 0, [[0, 1], [2, 2]])])]),
    ],
  });
  const keys = keysFor([solid]);
  const [held0, held1] = imageKeys(keys, masked, 0.2, 0.8);
  expect(held0).toBe(held1);
  const [before, after] = imageKeys(keys, masked, 0.5, 1.5);
  expect(before).not.toBe(after);
});

it("has no key for a layer with an effect that is not cacheable, and ignores effects without a renderer", () => {
  const keys = keysFor([solid]);
  const effects = (matchName: string) =>
    layer({ sourceId: solid.id, properties: [transform(), group("ADBE Effect Parade", [group(matchName, [prop(`${matchName}-0001`, 0)])])] });
  expect(keys.image(effects("Test Uncacheable"), 0)).toBeNull();
  expect(keys.image(effects("Test Not Registered"), 0)).not.toBeNull();
  // An adjustment layer's own image leaves its effects out: they run on the comp below it.
  expect(keys.image(effects("Test Uncacheable"), 0, false)).not.toBeNull();
});

it("follows the values of expressions, which may change without keyframes", () => {
  const driven = prop("ADBE Mask Opacity", 100);
  driven.expression = "time * 10";
  driven.expressionEnabled = true;
  const l = layer({ sourceId: solid.id, properties: [transform(), group("ADBE Mask Parade", [group("ADBE Mask Atom", [driven])])] });
  setExpressionEvaluator((_p, time) => Math.floor(time) * 10);
  const keys = keysFor([solid]);
  const [same0, same1] = imageKeys(keys, l, 0.2, 0.7);
  expect(same0).toBe(same1);
  const [a, b] = imageKeys(keys, l, 0.5, 1.5);
  expect(a).not.toBe(b);
});

it("keys a movie by the frame it shows", () => {
  const clip = layer({ sourceId: movie.id });
  const keys = keysFor([movie]);
  const [sameFrame0, sameFrame1] = imageKeys(keys, clip, 1 / 30 + 0.001, 2 / 30 - 0.001);
  expect(sameFrame0).toBe(sameFrame1);
  const [a, b] = imageKeys(keys, clip, 0, 1 / 30);
  expect(a).not.toBe(b);
});

it("keys a nested comp by what it draws at its own time: values, active layers and time remapping", () => {
  const child = layer({ sourceId: solid.id, outPoint: 3, properties: [transform(prop("ADBE Opacity", 100, [[0, 100], [1, 60]]))] });
  const inner = comp(2, [child]);
  const pre = layer({ sourceId: inner.id });
  const keys = keysFor([solid, inner]);
  const [held0, held1] = imageKeys(keys, pre, 0.2, 0.8);
  expect(held0).toBe(held1);
  const [moved0, moved1] = imageKeys(keys, pre, 0.5, 1.5);
  expect(moved0).not.toBe(moved1);
  const [during, after] = imageKeys(keys, pre, 2.5, 3.5);
  expect(during).not.toBe(after);

  // Time remapping that holds the nested comp at 0.5 s draws the same image all along.
  const remapped = layer({ sourceId: inner.id, timeRemapEnabled: true, properties: [transform(), prop("ADBE Time Remapping", 0.5)] });
  const [r0, r1] = imageKeys(keys, remapped, 0.5, 4);
  expect(r0).toBe(r1);
});

it("keys a nested comp by its adjustment layers' effects, which change what is below them", () => {
  const adjustment = (matchName: string, value: Property) =>
    layer({ sourceId: solid.id, adjustmentLayer: true, properties: [transform(), group("ADBE Effect Parade", [group(matchName, [value])])] });
  const animated = comp(5, [adjustment("Test Cacheable", prop("Test Cacheable-0001", 0, [[0, 1], [1, 2]])), layer({ sourceId: solid.id })]);
  const uncacheable = comp(6, [adjustment("Test Uncacheable", prop("Test Uncacheable-0001", 0)), layer({ sourceId: solid.id })]);
  const keys = keysFor([solid, animated, uncacheable]);
  const [a, b] = imageKeys(keys, layer({ sourceId: animated.id }), 0.5, 1.5);
  expect(a).not.toBe(b);
  expect(keys.image(layer({ sourceId: uncacheable.id }), 0)).toBeNull();
  keys.newFrame();
  const parts = keys.parts(uncacheable, 0)!;
  // Bottom first: the plain layer is keyed, the adjustment layer above it is not.
  expect(parts[0]).not.toBeNull();
  expect(parts[1]).toBeNull();
});

it("lists the movie frames a comp shows through its nested comps, without rendering", () => {
  const inner = comp(3, [layer({ sourceId: movie.id, startTime: 1 })]);
  const outer = comp(4, [layer({ sourceId: inner.id }), layer({ sourceId: movie.id })]);
  const keys = keysFor([movie, inner, outer]);
  const seen: [number, number][] = [];
  keys.footage(outer, 2, (item, frame) => seen.push([item.id, frame]));
  expect(seen.sort((a, b) => a[1] - b[1])).toEqual([
    [movie.id, 30],
    [movie.id, 60],
  ]);
});

it("names the GPU the browser renders on and tells built-in GPUs from dedicated ones", () => {
  const intel = gpuName("ANGLE (Intel, Intel(R) UHD Graphics (0x00009A60) Direct3D11 vs_5_0 ps_5_0, D3D11)");
  const nvidia = gpuName("ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Laptop GPU (0x0000249D) Direct3D11 vs_5_0 ps_5_0, D3D11)");
  expect(intel).toBe("Intel(R) UHD Graphics");
  expect(nvidia).toBe("NVIDIA GeForce RTX 3070 Laptop GPU");
  expect(isIntegratedGpu(intel)).toBe(true);
  expect(isIntegratedGpu(nvidia)).toBe(false);
  expect(isIntegratedGpu("AMD Radeon(TM) Graphics")).toBe(true);
  expect(isIntegratedGpu("AMD Radeon RX 6800 XT")).toBe(false);
  expect(isIntegratedGpu("Intel(R) Arc(TM) A770 Graphics")).toBe(false);
});

it("keeps cached images within a byte budget, least recently used dropped first", () => {
  const disposed: string[] = [];
  const cache = new ImageCache<string>(100, (v) => disposed.push(v));
  const [a, b, c] = [{}, {}, {}];
  expect(cache.set(a, "k", "A", 40)).toBe(true);
  cache.set(b, "k", "B", 40);
  expect(cache.get(a, "k")).toBe("A");
  expect(cache.get(a, "other")).toBeUndefined();
  cache.set(c, "k", "C", 40);
  expect(disposed).toEqual(["B"]);
  expect(cache.bytes).toBe(80);
  cache.set(a, "k2", "A2", 10);
  expect(disposed).toEqual(["B", "A"]);
  expect(cache.set(b, "k", "huge", 101)).toBe(false);
  cache.clear();
  expect(disposed.sort()).toEqual(["A", "A2", "B", "C"]);
  expect(cache.bytes).toBe(0);
});

it("drops WebGL calls that would change no state, and forgets what deleting an object unbinds", () => {
  const calls: string[] = [];
  class FakeGL {
    TEXTURE0 = 0x84c0;
    TEXTURE1 = 0x84c1;
    TEXTURE_2D = 0x0de1;
    FRAMEBUFFER = 0x8d40;
    READ_FRAMEBUFFER = 0x8ca8;
    DRAW_FRAMEBUFFER = 0x8ca9;
    BLEND = 0x0be2;
  }
  const proto = FakeGL.prototype as unknown as Record<string, unknown>;
  for (const name of [
    "useProgram",
    "bindFramebuffer",
    "bindVertexArray",
    "activeTexture",
    "bindTexture",
    "viewport",
    "scissor",
    "clearColor",
    "blendFunc",
    "blendEquation",
    "blendFuncSeparate",
    "blendEquationSeparate",
    "enable",
    "disable",
    "pixelStorei",
    "uniform1i",
    "uniform1f",
    "uniform2f",
    "uniform2i",
    "uniform3f",
    "uniform3i",
    "uniform4f",
    "uniform4i",
    "uniform1fv",
    "uniform2fv",
    "uniform3fv",
    "uniform4fv",
    "uniform1iv",
    "uniform2iv",
    "uniform3iv",
    "uniform4iv",
    "uniformMatrix2fv",
    "uniformMatrix3fv",
    "uniformMatrix4fv",
    "deleteProgram",
    "deleteFramebuffer",
    "deleteVertexArray",
    "deleteTexture",
  ]) {
    proto[name] = (...args: unknown[]) => calls.push(`${name}(${args.map((a) => (typeof a === "object" ? "o" : String(a))).join(",")})`);
  }
  const gl = new FakeGL() as unknown as GL;
  filterRedundantState(gl);
  const [program, fb, texture, location] = [{}, {}, {}, {}] as [WebGLProgram, WebGLFramebuffer, WebGLTexture, WebGLUniformLocation];

  gl.useProgram(program);
  gl.useProgram(program);
  gl.uniform1i(location, 0);
  gl.uniform1i(location, 0);
  gl.uniform1i(location, 1);
  gl.disable(gl.BLEND);
  gl.disable(gl.BLEND);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fb);
  gl.viewport(0, 0, 10, 10);
  gl.viewport(0, 0, 10, 10);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  expect(calls).toEqual([
    "useProgram(o)",
    "uniform1i(o,0)",
    "uniform1i(o,1)",
    "disable(3042)",
    "bindFramebuffer(36160,o)",
    "viewport(0,0,10,10)",
    "bindTexture(3553,o)",
    "activeTexture(33985)",
    "bindTexture(3553,o)",
    "activeTexture(33984)",
  ]);

  // Deleting bound objects unbinds them, so binding them (or others) again goes through.
  calls.length = 0;
  gl.deleteFramebuffer(fb);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteTexture(texture);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.deleteProgram(program);
  gl.useProgram(program);
  expect(calls).toEqual(["deleteFramebuffer(o)", "deleteTexture(o)", "deleteProgram(o)", "useProgram(o)"]);
});
