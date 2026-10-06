// Rasterizes a layer's masks into one coverage image in layer space.
import { valueAtTime } from "../aep/evaluate.ts";
import type { Layer, Property, PropertyGroup, Shape } from "../aep/model.ts";

const MaskMode = { NONE: 6812, ADD: 6813, SUBTRACT: 6814, INTERSECT: 6815, LIGHTEN: 6816, DARKEN: 6817, DIFFERENCE: 6818 } as const;

type Canvas2D = OffscreenCanvasRenderingContext2D;

function child(group: PropertyGroup, matchName: string): Property | undefined {
  const node = group.children.find((c) => c.matchName === matchName);
  return node?.kind === "property" ? node : undefined;
}

function numberAt(prop: Property | undefined, time: number, layer: Layer, fallback: number): number {
  if (!prop) return fallback;
  const v = valueAtTime(prop, time, layer);
  return typeof v === "number" ? v : Array.isArray(v) ? (v[0] ?? fallback) : fallback;
}

/**
 * AE's mask feather: a Gaussian with sigma = feather / 2.4, truncated at the
 * feather radius, applied separably to the coverage. The canvas `blur()`
 * filter only approximates a Gaussian (and differently per browser), so the
 * convolution is done here.
 */
function featherCoverage(coverage: Float32Array, w: number, h: number, feather: number): Float32Array {
  const sigma = feather / 2.4;
  const radius = Math.ceil(feather);
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) sum += kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const pass = (src: Float32Array, horizontal: boolean) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = horizontal ? Math.min(w - 1, Math.max(0, x + k)) : x;
          const sy = horizontal ? y : Math.min(h - 1, Math.max(0, y + k));
          acc += src[sy * w + sx] * kernel[k + radius];
        }
        out[y * w + x] = acc;
      }
    }
    return out;
  };
  return pass(pass(coverage, true), false);
}

function tracePath(ctx: Canvas2D, shape: Shape): void {
  const { vertices: v, inTangents: inT, outTangents: outT } = shape;
  if (!v.length) return;
  ctx.moveTo(v[0][0], v[0][1]);
  const segments = shape.closed ? v.length : v.length - 1;
  for (let i = 0; i < segments; i++) {
    const a = v[i];
    const b = v[(i + 1) % v.length];
    const c1 = [a[0] + outT[i][0], a[1] + outT[i][1]];
    const c2 = [b[0] + inT[(i + 1) % v.length][0], b[1] + inT[(i + 1) % v.length][1]];
    ctx.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], b[0], b[1]);
  }
  if (shape.closed) ctx.closePath();
}

/**
 * Coverage of the layer's enabled masks at `time`, as straight alpha in an
 * RGBA buffer of `(width + 2*pad) x (height + 2*pad)`, rows top to bottom.
 * Returns null when the layer has no active mask.
 */
export function maskCoverage(layer: Layer, time: number, width: number, height: number, pad: number): Uint8ClampedArray | null {
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Mask Parade");
  const masks = (parade?.children ?? []).filter(
    (n): n is PropertyGroup => n.kind === "group" && !!n.mask && n.enabled && n.mask.maskMode !== MaskMode.NONE,
  );
  if (!masks.length) return null;
  const w = width + 2 * pad;
  const h = height + 2 * pad;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  let accumulated: Float32Array | null = null;

  for (const mask of masks) {
    const shapeProp = child(mask, "ADBE Mask Shape");
    const shape = shapeProp ? valueAtTime(shapeProp, time, layer) : null;
    const opacity = numberAt(child(mask, "ADBE Mask Opacity"), time, layer, 100) / 100;
    const featherProp = child(mask, "ADBE Mask Feather");
    const featherValue = featherProp ? valueAtTime(featherProp, time, layer) : null;
    const feather = Array.isArray(featherValue) ? Math.max(featherValue[0] ?? 0, featherValue[1] ?? 0) : 0;
    const expansion = numberAt(child(mask, "ADBE Mask Offset"), time, layer, 0);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(pad, pad);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#fff";
    if (shape && typeof shape === "object" && !Array.isArray(shape)) {
      ctx.beginPath();
      tracePath(ctx, shape);
      ctx.fill("nonzero");
      if (expansion > 0) {
        ctx.lineWidth = expansion * 2;
        ctx.lineJoin = "round";
        ctx.stroke();
      }
    }
    const pixels = ctx.getImageData(0, 0, w, h).data;
    let shapeCoverage: Float32Array = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) shapeCoverage[i] = pixels[i * 4 + 3] / 255;
    if (feather > 0) shapeCoverage = featherCoverage(shapeCoverage, w, h, feather);
    const inverted = mask.mask!.inverted;
    const mode = mask.mask!.maskMode;
    if (!accumulated) {
      // A stack that starts by removing coverage starts from a fully covered layer.
      const startFull = mode === MaskMode.SUBTRACT || mode === MaskMode.INTERSECT || mode === MaskMode.DARKEN;
      accumulated = new Float32Array(w * h).fill(startFull ? 1 : 0);
    }
    for (let i = 0; i < w * h; i++) {
      let c = shapeCoverage[i];
      if (inverted) c = 1 - c;
      c *= opacity;
      const a = accumulated[i];
      switch (mode) {
        case MaskMode.ADD:
          accumulated[i] = a + c - a * c;
          break;
        case MaskMode.SUBTRACT:
          accumulated[i] = a * (1 - c);
          break;
        case MaskMode.INTERSECT:
          accumulated[i] = a * c;
          break;
        case MaskMode.LIGHTEN:
          accumulated[i] = Math.max(a, c);
          break;
        case MaskMode.DARKEN:
          accumulated[i] = Math.min(a, c);
          break;
        case MaskMode.DIFFERENCE:
          accumulated[i] = Math.abs(a - c);
          break;
      }
    }
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) out[i * 4 + 3] = Math.round(accumulated![i] * 255);
  return out;
}
