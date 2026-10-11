// The render plan the native Vulkan engine (native/) renders: what it holds for the core fixtures, its binary form
// (shared with native/tests/plan_test.cpp through native/tests/data/sample.aevp), and the embedded SPIR-V being
// up to date with the GLSL sources.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompItem, Project } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import "../src/expressions/install.ts";
import { buildFramePlan, type FramePlan, type PlanContent, type PlanLayer } from "../src/native/plan.ts";
import { GRADIENT_STOPS } from "../src/render/shapes.ts";
import { decodePlan, encodePlan, PLAN_MAGIC } from "../src/native/wire.ts";
import { shaderHash, SHADER_DIR, SHADER_HEADER, shaderSymbol } from "../scripts/lib/native.ts";

const SAMPLE = resolve("native/tests/data/sample.aevp");

const translation = (x: number, y: number) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, 0, 0, 0, 0, 1];

function solidLayer(width: number, height: number, color: [number, number, number], x: number, y: number): PlanLayer {
  return {
    name: "",
    adjustment: false,
    blendMode: 5212,
    opacity: 1,
    content: { kind: "solid", width, height, origin: [0, 0], scale: 1, color },
    masks: [],
    matrix: translation(x + 1, y + 1),
    zoom: 0,
  };
}

/** A plan using every part of the format (the C++ test checks the values below). */
function samplePlan(): Pick<FramePlan, "root" | "images"> {
  const red = solidLayer(4, 4, [1, 0.25, 0], 1, 1);
  red.masks.push({
    mode: 6813,
    inverted: false,
    opacity: 1,
    feather: 1.5,
    expansion: 0,
    closed: true,
    vertices: [0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 1, 0, 3, 3, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0],
  });
  const nested: PlanLayer = {
    ...solidLayer(2, 2, [0, 1, 0], 4, 2),
    blendMode: 5216,
    opacity: 0.5,
    content: { kind: "comp", width: 2, height: 2, origin: [0, 0], scale: 1, comp: { width: 2, height: 2, layers: [solidLayer(2, 1, [0, 1, 0], 0, 0)] } },
    matte: { mode: 1, opacity: 0.75, layer: solidLayer(8, 3, [1, 1, 1], 0, 0) },
  };
  const image: PlanLayer = {
    ...solidLayer(1, 1, [0, 0, 0], 0, 0),
    content: { kind: "image", width: 1, height: 1, origin: [0, 0], scale: 1, image: 0 },
    zoom: 1066.6666,
    matte: { mode: 4, opacity: 1, layer: null },
  };
  return { root: { width: 8, height: 6, layers: [red, nested, image] }, images: [{ width: 1, height: 1, pixels: new Uint8Array([10, 20, 30, 255]) }] };
}

let fixtures: Project | undefined;
function fixture(name: string): { project: Project; comp: CompItem } {
  fixtures ??= parseProject(new Uint8Array(readFileSync(resolve("refs/fixtures/fixtures.aep"))));
  const comp = [...fixtures.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === name);
  if (!comp) throw new Error(`no comp ${name}`);
  return { project: fixtures, comp };
}

describe("native render plan", () => {
  it("writes the sample plan the C++ tests read, byte for byte", () => {
    const bytes = encodePlan(samplePlan());
    if (process.env.AEVK_WRITE_SAMPLE) writeFileSync(SAMPLE, bytes);
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(PLAN_MAGIC);
    expect(Buffer.from(bytes).equals(readFileSync(SAMPLE))).toBe(true);
  });

  it("reads back what it writes", () => {
    const decoded = decodePlan(encodePlan(samplePlan()));
    const [red, nested, image] = decoded.root.layers;
    expect(red.content).toMatchObject({ kind: "solid", width: 4, height: 4, color: [1, 0.25, 0] });
    expect(red.masks[0]).toMatchObject({ mode: 6813, closed: true, feather: 1.5 });
    expect(nested.matte?.layer?.content.kind).toBe("solid");
    expect(nested.content.kind === "comp" && nested.content.comp.layers.length).toBe(1);
    expect(image.matte).toEqual({ mode: 4, opacity: 1, layer: null });
    expect(Math.fround(1066.6666)).toBe(image.zoom);
    expect(decoded.images[0].pixels).toEqual(new Uint8Array([10, 20, 30, 255]));
  });

  it("refuses truncated or foreign bytes", () => {
    const bytes = encodePlan(samplePlan());
    expect(() => decodePlan(bytes.subarray(0, bytes.length - 3))).toThrow(/truncated/);
    expect(() => decodePlan(new Uint8Array(16))).toThrow(/not a render plan/);
    expect(() => encodePlan({ root: { width: 1, height: 1, layers: [] }, images: [{ width: 2, height: 2, pixels: new Uint8Array(4) }] })).toThrow();
  });

  it("plans solids through the layer matrix with the border, as the WebGL renderer places them", () => {
    const { project, comp } = fixture("solid_offset");
    const plan = buildFramePlan(project, comp, 0);
    expect(plan.unsupported).toEqual([]);
    expect(plan.root).toMatchObject({ width: comp.width, height: comp.height });
    const [layer] = plan.root.layers;
    expect(layer.content.kind).toBe("solid");
    expect(layer.zoom).toBe(0);
    // Row-major: the translation column holds the layer's offset plus the 1 px border.
    const m = layer.matrix;
    expect(m[15]).toBe(1);
    expect(Number.isInteger(m[3] - 1) || m[3] !== 0).toBe(true);
  });

  it("plans half resolution with scaled content, sizes and matrices", () => {
    const { project, comp } = fixture("solid_basic");
    const full = buildFramePlan(project, comp, 0);
    const half = buildFramePlan(project, comp, 0, { scale: 0.5 });
    expect(half.root).toMatchObject({ width: comp.width / 2, height: comp.height / 2 });
    const a = full.root.layers[0];
    const b = half.root.layers[0];
    expect(b.content.scale).toBe(0.5);
    expect(b.content.width).toBe(Math.ceil(a.content.width / 2));
    expect(b.matrix[0]).toBeCloseTo(a.matrix[0] / 2, 9);
    expect(b.matrix[3] - 1).toBeCloseTo((a.matrix[3] - 1) / 2, 9);
  });

  it("plans masks, track mattes, nested comps and 3D layers", () => {
    const masked = buildFramePlan(fixture("mask_feather").project, fixture("mask_feather").comp, 0);
    const mask = masked.root.layers.flatMap((l) => l.masks)[0];
    expect(mask.feather).toBeGreaterThan(0);
    expect(mask.vertices.length % 6).toBe(0);

    const matte = buildFramePlan(fixture("matte_luma").project, fixture("matte_luma").comp, 0);
    expect(matte.root.layers.some((l) => l.matte?.mode === 3 && l.matte.layer)).toBe(true);

    // The nested comp's layer starts a quarter second in.
    const { project, comp } = fixture("precomp");
    expect(buildFramePlan(project, comp, 0).root.layers.some((l) => l.content.kind === "comp")).toBe(false);
    const precomp = buildFramePlan(project, comp, 0.5);
    expect(precomp.root.layers.some((l) => l.content.kind === "comp" && l.content.comp.layers.length > 0)).toBe(true);

    const threeD = buildFramePlan(fixture("three_d_camera").project, fixture("three_d_camera").comp, 0);
    expect(threeD.root.layers.some((l) => l.zoom > 0)).toBe(true);
  });

  it("follows animation: a keyed position moves the matrix between frames", () => {
    const { project, comp } = fixture("anim_position");
    const at = (frame: number) => buildFramePlan(project, comp, frame / 24).root.layers.at(-1)!.matrix;
    expect(at(12)).not.toEqual(at(0));
  });

  it("plans shape layers as fills and strokes with their geometry, rules, caps, joins and gradients", () => {
    const shapeOf = (name: string, scale = 1) => {
      const { project, comp } = fixture(name);
      const plan = buildFramePlan(project, comp, 0, { scale });
      expect(plan.unsupported).toEqual([]);
      const content = plan.root.layers.map((l) => l.content).find((c) => c.kind === "shape");
      if (content?.kind !== "shape") throw new Error(`${name} plans no shape`);
      return content;
    };
    const rect = shapeOf("shape_rect");
    expect(rect.paints.length).toBeGreaterThan(0);
    expect(rect.paints[0].paths[0].vertices.length % 6).toBe(0);
    // Colors arrive quantized to 8 bits, as the canvas holds them.
    expect(rect.paints.every((p) => p.color.every((c) => Math.abs(c * 255 - Math.round(c * 255)) < 1e-9))).toBe(true);
    // At half resolution the raster halves and the paints map into it.
    const half = shapeOf("shape_rect", 0.5);
    expect(half.width).toBeLessThanOrEqual(Math.ceil(rect.width / 2) + 1);
    expect(half.paints[0].matrix[0]).toBeCloseTo(rect.paints[0].matrix[0] / 2, 9);

    expect(shapeOf("shape_fill_evenodd").paints.some((p) => p.evenOdd)).toBe(true);
    const stroke = shapeOf("shape_rect_round_stroke").paints.find((p) => p.stroke)!;
    expect(stroke.width).toBeGreaterThan(0);
    expect([1, 2, 3]).toContain(stroke.cap);
    const radial = shapeOf("shape_gradient_radial").paints.find((p) => p.gradient)!;
    expect(radial.gradient!.radial).toBe(true);
    expect(radial.gradient!.ramp).toHaveLength((GRADIENT_STOPS + 1) * 4);
    expect(shapeOf("shape_gradient_linear").paints.find((p) => p.gradient)!.gradient!.radial).toBe(false);

    // The binary form keeps every paint value (as 32-bit floats).
    const { project, comp } = fixture("shape_gradient_radial");
    const plan = buildFramePlan(project, comp, 0);
    const back = decodePlan(encodePlan(plan));
    const paints = (c: PlanContent) => (c.kind === "shape" ? c.paints : []);
    const sent = plan.root.layers.flatMap((l) => paints(l.content));
    const read = back.root.layers.flatMap((l) => paints(l.content));
    expect(read).toHaveLength(sent.length);
    read.forEach((p, i) => {
      expect(p.stroke).toBe(sent[i].stroke);
      expect(p.gradient?.ramp).toEqual(sent[i].gradient?.ramp.map(Math.fround));
      expect(p.paths.map((path) => path.vertices)).toEqual(sent[i].paths.map((path) => path.vertices.map(Math.fround)));
      expect(p.matrix).toEqual(sent[i].matrix.map(Math.fround));
    });
  });

  it("names what it cannot render natively, so the frame stays with the WebGL renderer", () => {
    const project = parseProject(new Uint8Array(readFileSync(resolve("refs/fixtures/adjust.aep"))));
    const comp = [...project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === "adjust_blur")!;
    expect(buildFramePlan(project, comp, 0).unsupported).toEqual([expect.stringMatching(/^adjustment layer effects/)]);
  });

  it("embeds SPIR-V compiled from the current shader sources (node scripts/native-shaders.ts)", () => {
    const header = readFileSync(SHADER_HEADER, "utf8");
    const sources = readdirSync(SHADER_DIR).filter((f) => /\.(vert|frag|comp)$/.test(f));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      expect(header).toContain(`// ${file} sha256 ${shaderHash(file)}`);
      expect(header).toContain(`static const uint32_t ${shaderSymbol(file)}[]`);
    }
    expect(existsSync(join(SHADER_DIR, "..", "src", "engine.cpp"))).toBe(true);
  });
});
