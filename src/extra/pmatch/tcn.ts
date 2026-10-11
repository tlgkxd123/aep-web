// Evaluates the world model's audio network (model.ts Dynamics) over a whole feature
// track, as PyTorch evaluates ml/pmatch/pmatch/nets.py AudioTCN: convolutions are
// cross-correlations over channel-major rows, zero-padded at the track's ends.
import type { Dynamics } from "./model.ts";

/** Outputs (frames × outputs, frame-major) for `frames` feature frames of `d.inputs` features each (frame-major). */
export function runDynamics(d: Dynamics, features: ArrayLike<number>, frames: number): Float32Array {
  const { inputs: I, channels: C, kernel: K, outputs: O, weights } = d;
  let at = 0;
  const take = (n: number) => weights.subarray(at, (at += n));
  const x = new Float64Array(I * frames);
  for (let t = 0; t < frames; t++) for (let i = 0; i < I; i++) x[i * frames + t] = features[t * I + i];
  const row = (buffer: Float64Array, c: number) => buffer.subarray(c * frames, (c + 1) * frames);
  /** out[o] = b[o] + Σ_i w[o, i] · src[i], over rows of `frames`. */
  const pointwise = (out: Float64Array, src: Float64Array, w: Float32Array, b: Float32Array | null, outs: number, ins: number, add: boolean) => {
    for (let o = 0; o < outs; o++) {
      const dst = row(out, o);
      if (!add) dst.fill(0);
      if (b) for (let t = 0; t < frames; t++) dst[t] += b[o];
      for (let i = 0; i < ins; i++) {
        const wi = w[o * ins + i];
        if (wi === 0) continue;
        const s = row(src, i);
        for (let t = 0; t < frames; t++) dst[t] += wi * s[t];
      }
    }
  };

  const h = new Float64Array(C * frames);
  pointwise(h, x, take(C * I), take(C), C, I, false);
  const u = new Float64Array(C * frames);
  for (const dilation of d.dilations) {
    const convW = take(C * C * K);
    const convB = take(C);
    for (let o = 0; o < C; o++) {
      const dst = row(u, o);
      dst.fill(convB[o]);
      for (let i = 0; i < C; i++) {
        const s = row(h, i);
        for (let k = 0; k < K; k++) {
          const wk = convW[(o * C + i) * K + k];
          if (wk === 0) continue;
          const shift = (k - (K - 1) / 2) * dilation;
          const from = Math.max(0, -shift);
          const to = Math.min(frames, frames - shift);
          for (let t = from; t < to; t++) dst[t] += wk * s[t + shift];
        }
      }
      for (let t = 0; t < frames; t++) dst[t] /= 1 + Math.exp(-dst[t]);
    }
    pointwise(h, u, take(C * C), take(C), C, C, true);
  }
  const y = new Float64Array(O * frames);
  pointwise(y, h, take(O * C), take(O), O, C, false);
  pointwise(y, x, take(O * I), null, O, I, true);
  const out = new Float32Array(frames * O);
  for (let o = 0; o < O; o++) for (let t = 0; t < frames; t++) out[t * O + o] = y[o * frames + t];
  return out;
}

/** Frames the network's outputs depend on around each frame. */
export function receptiveField(d: Dynamics): number {
  return 1 + (d.kernel - 1) * d.dilations.reduce((s, v) => s + v, 0);
}

/** The outputs for silence (features of 0, away from a track's ends). */
export function quietDynamics(d: Dynamics): Float32Array {
  const frames = 2 * receptiveField(d) + 1;
  return runDynamics(d, new Float32Array(frames * d.inputs), frames).slice(((frames - 1) / 2) * d.outputs, ((frames + 1) / 2) * d.outputs);
}
