// Registration of consecutive frames for the shake measurement (shake.ts): Gauss–Newton over a three-level
// pyramid of 8 × 8 block averages finds the shift, rotation and scale about the frame centre that carry the
// previous frame onto this one (inverse compositional), with Cauchy weights so that particles, bars and
// lettering moving on their own count little. Each level is normalized to zero mean and unit spread first,
// so brightness pulses are not motion. Free of the GPU so that workers (shakeWorker.ts) run it.

/** Frame pixels per thumbnail pixel. */
export const BLOCK = 8;
const LEVELS = 3;
/** Gauss–Newton steps per pyramid level, finest first. */
const STEPS = [2, 3, 6];
/** Thumbnail pixels left out along the edges (letterboxing, blocks the frame edge cuts). */
const BORDER = 2;
/** Cauchy tuning constant (95 % efficiency), in robust spreads of the residuals. */
const CAUCHY = 2.385;

/** Solves M x = v (n × n, row-major) by Gaussian elimination with partial pivoting; null when singular. */
export function solve(m: Float64Array, v: Float64Array, n: number): Float64Array | null {
  const a = Float64Array.from(m);
  const b = Float64Array.from(v);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r * n + c]) > Math.abs(a[p * n + c])) p = r;
    if (Math.abs(a[p * n + c]) < 1e-12) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) [a[c * n + k], a[p * n + k]] = [a[p * n + k], a[c * n + k]];
      [b[c], b[p]] = [b[p], b[c]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = a[r * n + c] / a[c * n + c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) a[r * n + k] -= f * a[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let c = n - 1; c >= 0; c--) {
    let s = b[c];
    for (let k = c + 1; k < n; k++) s -= a[c * n + k] * x[k];
    x[c] = s / a[c * n + c];
  }
  return x;
}

/** A pyramid level: normalized grey levels and their gradients, rows top first. */
export interface Level {
  width: number;
  height: number;
  value: Float32Array;
  gx: Float32Array;
  gy: Float32Array;
}

/** How the picture moved since the previous frame, about the frame centre. */
export interface FrameMotion {
  /** Shift, frame pixels (y down). */
  dx: number;
  dy: number;
  /** Rotation (radians, clockwise on screen) and log scale. */
  angle: number;
  logScale: number;
  /** Mean Cauchy weight: the share of the picture that moved together. */
  agreement: number;
}

function normalized(raw: Float32Array, width: number, height: number): Level {
  let sum = 0;
  let squares = 0;
  let n = 0;
  for (let y = BORDER; y < height - BORDER; y++) {
    for (let x = BORDER; x < width - BORDER; x++) {
      const v = raw[y * width + x];
      sum += v;
      squares += v * v;
      n++;
    }
  }
  const mean = n ? sum / n : 0;
  const spread = Math.sqrt(Math.max(1e-10, n ? squares / n - mean * mean : 0));
  const value = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) value[i] = (raw[i] - mean) / spread;
  const gx = new Float32Array(raw.length);
  const gy = new Float32Array(raw.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      gx[i] = 0.5 * (value[i + 1] - value[i - 1]);
      gy[i] = 0.5 * (value[i + width] - value[i - width]);
    }
  }
  return { width, height, value, gx, gy };
}

/** The pyramid of a grey picture (rows top first), finest level first. */
export function pyramid(grey: Float32Array, width: number, height: number): Level[] {
  const levels: Level[] = [];
  let raw = grey;
  let w = width;
  let h = height;
  for (let l = 0; l < LEVELS; l++) {
    levels.push(normalized(raw, w, h));
    if (l === LEVELS - 1) break;
    const hw = w >> 1;
    const hh = h >> 1;
    const half = new Float32Array(hw * hh);
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < hw; x++) {
        const i = 2 * y * w + 2 * x;
        half[y * hw + x] = 0.25 * (raw[i] + raw[i + 1] + raw[i + w] + raw[i + w + 1]);
      }
    }
    raw = half;
    w = hw;
    h = hh;
  }
  return levels;
}

/**
 * The similarity (about the picture centre) that carries `from` onto `to`, as the 2×3 matrix
 * [a, -b, tx, b, a, ty] in finest-level pixels, and the share of the picture that agrees with it.
 */
export function register(from: Level[], to: Level[]): { matrix: number[]; agreement: number } {
  // m maps `from`'s centred coordinates to `to`'s.
  const m = [1, 0, 0, 0, 1, 0];
  let agreement = 0;
  const hessian = new Float64Array(16);
  const gradient = new Float64Array(4);
  for (let l = LEVELS - 1; l >= 0; l--) {
    if (l < LEVELS - 1) {
      m[2] *= 2;
      m[5] *= 2;
    }
    const t = from[l];
    const im = to[l];
    const tw = t.width;
    const iw = im.width;
    const value = im.value;
    const cx = tw / 2;
    const cy = t.height / 2;
    const maxX = im.width - 1;
    const maxY = im.height - 1;
    let scale = 0;
    for (let step = 0; step < STEPS[l]; step++) {
      const [m0, m1, m2, m3, m4, m5] = m;
      if (step === 0) {
        // Robust spread of the residuals from every third pixel.
        const sample: number[] = [];
        for (let y = BORDER; y < t.height - BORDER; y += 3) {
          const uy = y + 0.5 - cy;
          for (let x = BORDER; x < tw - BORDER; x += 3) {
            const ux = x + 0.5 - cx;
            const qx = m0 * ux + m1 * uy + m2 + cx - 0.5;
            const qy = m3 * ux + m4 * uy + m5 + cy - 0.5;
            if (!(qx >= 0 && qy >= 0 && qx < maxX && qy < maxY)) continue;
            const x0 = Math.floor(qx);
            const y0 = Math.floor(qy);
            const fx = qx - x0;
            const i = y0 * iw + x0;
            const top = value[i] + (value[i + 1] - value[i]) * fx;
            const bottom = value[i + iw] + (value[i + iw + 1] - value[i + iw]) * fx;
            sample.push(Math.abs(top + (bottom - top) * (qy - y0) - t.value[y * tw + x]));
          }
        }
        sample.sort((a, b) => a - b);
        scale = CAUCHY * Math.max(0.02, 1.4826 * (sample[sample.length >> 1] ?? 1));
      }
      let h00 = 0, h01 = 0, h02 = 0, h03 = 0, h11 = 0, h12 = 0, h13 = 0, h22 = 0, h23 = 0, h33 = 0;
      let g0 = 0, g1 = 0, g2 = 0, g3 = 0;
      let weights = 0;
      let count = 0;
      for (let y = BORDER; y < t.height - BORDER; y++) {
        const uy = y + 0.5 - cy;
        for (let x = BORDER; x < tw - BORDER; x++) {
          const ux = x + 0.5 - cx;
          const qx = m0 * ux + m1 * uy + m2 + cx - 0.5;
          const qy = m3 * ux + m4 * uy + m5 + cy - 0.5;
          if (!(qx >= 0 && qy >= 0 && qx < maxX && qy < maxY)) continue;
          const x0 = Math.floor(qx);
          const y0 = Math.floor(qy);
          const fx = qx - x0;
          const k = y0 * iw + x0;
          const top = value[k] + (value[k + 1] - value[k]) * fx;
          const bottom = value[k + iw] + (value[k + iw + 1] - value[k + iw]) * fx;
          const i = y * tw + x;
          const e = top + (bottom - top) * (qy - y0) - t.value[i];
          // Steepest descent images: ∇T · ∂W/∂p at p = 0.
          const s0 = t.gx[i];
          const s1 = t.gy[i];
          const s2 = s0 * ux + s1 * uy;
          const s3 = s1 * ux - s0 * uy;
          const r = e / scale;
          const w = 1 / (1 + r * r);
          const we = w * e;
          g0 += s0 * we;
          g1 += s1 * we;
          g2 += s2 * we;
          g3 += s3 * we;
          const w0 = w * s0;
          const w1 = w * s1;
          const w2 = w * s2;
          h00 += w0 * s0;
          h01 += w0 * s1;
          h02 += w0 * s2;
          h03 += w0 * s3;
          h11 += w1 * s1;
          h12 += w1 * s2;
          h13 += w1 * s3;
          h22 += w2 * s2;
          h23 += w2 * s3;
          h33 += w * s3 * s3;
          weights += w;
          count++;
        }
      }
      if (count < 16) return { matrix: [1, 0, 0, 0, 1, 0], agreement: 0 };
      hessian.set([h00, h01, h02, h03, h01, h11, h12, h13, h02, h12, h22, h23, h03, h13, h23, h33]);
      gradient.set([g0, g1, g2, g3]);
      agreement = weights / count;
      const delta = solve(hessian, gradient, 4);
      if (!delta) break;
      // m ← m ∘ W(delta)⁻¹, W(p): u ↦ [[1 + p2, -p3], [p3, 1 + p2]] u + (p0, p1).
      const a = 1 + delta[2];
      const b = delta[3];
      const det = a * a + b * b;
      const i00 = a / det;
      const i01 = b / det;
      const i10 = -b / det;
      const i11 = a / det;
      const itx = -(i00 * delta[0] + i01 * delta[1]);
      const ity = -(i10 * delta[0] + i11 * delta[1]);
      m[0] = m0 * i00 + m1 * i10;
      m[1] = m0 * i01 + m1 * i11;
      m[2] = m0 * itx + m1 * ity + m2;
      m[3] = m3 * i00 + m4 * i10;
      m[4] = m3 * i01 + m4 * i11;
      m[5] = m3 * itx + m4 * ity + m5;
      if (Math.abs(delta[0]) + Math.abs(delta[1]) < 1e-3 && Math.abs(delta[2]) + Math.abs(delta[3]) < 1e-5) break;
    }
  }
  return { matrix: m, agreement };
}

/** The motion `register` found, in frame pixels. */
export function motionOf(matrix: number[], agreement: number, block = BLOCK): FrameMotion {
  return {
    dx: matrix[2] * block,
    dy: matrix[5] * block,
    angle: Math.atan2(matrix[3], matrix[0]),
    logScale: 0.5 * Math.log(Math.max(1e-6, matrix[0] * matrix[4] - matrix[1] * matrix[3])),
    agreement,
  };
}

/** The motion between two thumbnails (`width` × `height` block averages, rows top first). */
export function thumbnailMotion(from: Float32Array, to: Float32Array, width: number, height: number): FrameMotion {
  const { matrix, agreement } = register(pyramid(from, width, height), pyramid(to, width, height));
  return motionOf(matrix, agreement);
}

/** A registration job for a worker, and its answer. */
export interface ShakeJob {
  id: number;
  width: number;
  height: number;
  from: Float32Array;
  to: Float32Array;
}
export type ShakeReply = { id: number; motion: FrameMotion };
