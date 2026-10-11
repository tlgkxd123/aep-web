// The pixel criterion renders are held to against After Effects' reference frames (AGENTS.md, "Verification"),
// shared by pixel-report.ts (the WebGL renderer) and native-report.ts (the Vulkan engine).

/** A pixel counts as different when any premultiplied channel is off by more than this (of 255). */
export const CHANNEL_TOLERANCE = 3;
/**
 * AE's rasterizer spreads edge coverage slightly differently from the
 * browser's, so differences on hard edges are measured separately: a pixel is
 * an edge pixel when the reference changes by more than EDGE_CONTRAST within
 * its 3x3 neighbourhood. Gradients and feathers stay below that contrast.
 */
export const EDGE_CONTRAST = 48;
/** A frame passes when at most this share of its non-edge pixels differ... */
export const INTERIOR_TOLERANCE = 0.001;
/** ...and its mean error over all pixels stays within this (of 255). */
export const MEAN_TOLERANCE = 1;
/** Known approximations must still keep their mean error within this. */
export const KNOWN_MEAN_LIMIT = 1;

export interface FrameComparison {
  /** Share of all pixels that differ. */
  badShare: number;
  /** Share of all pixels that differ away from the reference's edges. */
  interiorShare: number;
  maxDiff: number;
  meanDiff: number;
  /** The worst channel difference per pixel times 8, as opaque grey RGBA. */
  diff: Uint8Array;
}

const premul = (d: Uint8Array, i: number, c: number) => (c === 3 ? d[i + 3] : (d[i + c] * d[i + 3]) / 255);

/** Compares straight-alpha RGBA frames of the same size (rows top first). */
export function compareFrames(ref: Uint8Array, ours: Uint8Array, width: number, height: number): FrameComparison {
  const isEdge = (p: number) => {
    const x = p % width;
    const y = Math.floor(p / width);
    for (let c = 0; c < 4; c++) {
      let lo = 255;
      let hi = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.min(width - 1, Math.max(0, x + dx));
          const ny = Math.min(height - 1, Math.max(0, y + dy));
          const v = premul(ref, (ny * width + nx) * 4, c);
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
      if (hi - lo > EDGE_CONTRAST) return true;
    }
    return false;
  };
  let bad = 0;
  let interiorBad = 0;
  let maxDiff = 0;
  let sum = 0;
  const diff = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    let worst = 0;
    for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(premul(ours, p * 4, c) - premul(ref, p * 4, c)));
    if (worst > CHANNEL_TOLERANCE) {
      bad++;
      if (!isEdge(p)) interiorBad++;
    }
    maxDiff = Math.max(maxDiff, worst);
    sum += worst;
    const v = Math.min(255, Math.round(worst * 8));
    diff.set([v, v, v, 255], p * 4);
  }
  return { badShare: bad / (width * height), interiorShare: interiorBad / (width * height), maxDiff, meanDiff: sum / (width * height), diff };
}

/** Whether a frame meets the criterion outright. */
export const passes = (c: Pick<FrameComparison, "interiorShare" | "meanDiff">): boolean => c.interiorShare <= INTERIOR_TOLERANCE && c.meanDiff <= MEAN_TOLERANCE;

/** Whether a frame's difference is large enough to be worth a diff sheet. */
export const worthASheet = (c: Pick<FrameComparison, "interiorShare" | "meanDiff" | "badShare">): boolean =>
  c.interiorShare > INTERIOR_TOLERANCE || c.meanDiff > MEAN_TOLERANCE || c.badShare > 0.01;

/** Reference | ours | diff side by side, RGBA. */
export function diffSheet(ref: Uint8Array, ours: Uint8Array, diff: Uint8Array, width: number, height: number): Uint8Array {
  const sheet = new Uint8Array(width * 3 * height * 4);
  for (let y = 0; y < height; y++) {
    sheet.set(ref.subarray(y * width * 4, (y + 1) * width * 4), y * width * 3 * 4);
    sheet.set(ours.subarray(y * width * 4, (y + 1) * width * 4), (y * width * 3 + width) * 4);
    sheet.set(diff.subarray(y * width * 4, (y + 1) * width * 4), (y * width * 3 + 2 * width) * 4);
  }
  return sheet;
}
