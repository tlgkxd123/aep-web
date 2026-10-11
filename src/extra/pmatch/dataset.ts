// What the PyTorch trainer (ml/pmatch/pmatch/dataset.py) learns from: the browser's
// analysis of a reference window as a safetensors file. Tracks with their points,
// whether the tiles around each track's ends were analysed (particles there may
// have come out from behind something or gone behind it), sprite crops resampled
// to a common spread, the shake's Amplitude per frame and the sound's features.
import { FEATURES, type AudioFeatures } from "./audio.ts";
import type { VideoAnalysis } from "./pipeline.ts";
import { encodeSafetensors, type Tensor } from "./safetensors.ts";
import type { MeasuredShake } from "./shake.ts";
import { canonical, TEMPLATE, TEMPLATE_REACH, TEMPLATE_SIGMA } from "./sprites.ts";
import { MIN_PEAK, type Track } from "./track.ts";

export const DATASET_VERSION = 1;
/** Floats per track point: frame, x, y, flux, peak, spread, whiteness, back. */
export const POINT_FLOATS = 8;
/** Tiles around a track's end that must have been analysed for the particle to count as seen there. */
const CLEAR_REACH = 2;

export interface DatasetInput {
  name: string;
  /** Training window, seconds of the video. */
  from: number;
  to: number;
  analysis: VideoAnalysis;
  tracks: readonly Track[];
  /** Where the particles stream out of, frame pixels. */
  center: [number, number];
  features: AudioFeatures | null;
  shake: MeasuredShake;
}

export function encodeDataset(input: DatasetInput): Uint8Array<ArrayBuffer> {
  const { analysis, tracks, features, shake } = input;
  const { info, options, columns, rows } = analysis;
  const first = analysis.frames[0].index;
  const frames = analysis.frames[analysis.frames.length - 1].index - first + 1;
  const maskAt = new Map(analysis.frames.map((f, k) => [f.index, analysis.masks[k]]));
  const clearAround = (frame: number, x: number, y: number) => {
    const mask = maskAt.get(frame);
    if (!mask) return false;
    const tx = Math.floor((x - options.region[0]) / options.tile);
    const ty = Math.floor((y - options.region[1]) / options.tile);
    for (let dy = -CLEAR_REACH; dy <= CLEAR_REACH; dy++) {
      for (let dx = -CLEAR_REACH; dx <= CLEAR_REACH; dx++) {
        const cx = tx + dx;
        const cy = ty + dy;
        if (cx < 0 || cy < 0 || cx >= columns || cy >= rows || !mask[cy * columns + cx]) return false;
      }
    }
    return true;
  };

  const count = tracks.reduce((n, t) => n + t.points.length, 0);
  const points = new Float32Array(count * POINT_FLOATS);
  const trackStart = new Int32Array(tracks.length + 1);
  const clear = new Uint8Array(tracks.length * 2);
  let at = 0;
  tracks.forEach((t, i) => {
    trackStart[i] = at / POINT_FLOATS;
    for (const p of t.points) {
      points.set([p.frame, p.x, p.y, p.flux, p.peak, p.spread, p.whiteness, p.back], at);
      at += POINT_FLOATS;
    }
    const a = t.points[0];
    const b = t.points[t.points.length - 1];
    clear[i * 2] = clearAround(a.frame, a.x, a.y) ? 1 : 0;
    clear[i * 2 + 1] = clearAround(b.frame, b.x, b.y) ? 1 : 0;
  });
  trackStart[tracks.length] = count;

  const canonicals = analysis.crops.map((crop) => ({ crop, c: canonical(crop) })).filter((x) => x.c !== null);
  const cropTemplates = new Float32Array(canonicals.length * TEMPLATE * TEMPLATE);
  const cropSigma = new Float32Array(canonicals.length);
  const cropTint = new Float32Array(canonicals.length * 3);
  const cropAt = new Float32Array(canonicals.length * 3);
  canonicals.forEach(({ crop, c }, i) => {
    cropTemplates.set(c!.template, i * TEMPLATE * TEMPLATE);
    cropSigma[i] = c!.sigma;
    cropTint.set(c!.tint, i * 3);
    cropAt.set([crop.frame, crop.x, crop.y], i * 3);
  });

  const featureFrames = features && features.dims === FEATURES ? features.frames : 0;
  const tensors: Record<string, Tensor> = {
    features: { data: featureFrames ? features!.data : new Float32Array(0), shape: [featureFrames, FEATURES] },
    points: { data: points, shape: [count, POINT_FLOATS] },
    track_start: { data: trackStart, shape: [tracks.length + 1] },
    clear: { data: clear, shape: [tracks.length, 2] },
    crop_templates: { data: cropTemplates, shape: [canonicals.length, TEMPLATE, TEMPLATE] },
    crop_sigma: { data: cropSigma, shape: [canonicals.length] },
    crop_tint: { data: cropTint, shape: [canonicals.length, 3] },
    crop_at: { data: cropAt, shape: [canonicals.length, 3] },
  };
  if (shake.shake) {
    const envelope = new Float32Array(frames);
    const valid = new Uint8Array(frames);
    analysis.frames.forEach((f, k) => {
      envelope[f.index - first] = shake.envelope[k];
      valid[f.index - first] = shake.valid[k];
    });
    tensors.shake_envelope = { data: envelope, shape: [frames] };
    tensors.shake_valid = { data: valid, shape: [frames] };
  }
  const meta = {
    version: DATASET_VERSION,
    name: input.name,
    width: info.width,
    height: info.height,
    frameRate: info.frameRate,
    first,
    frames,
    train: [input.from, input.to],
    region: options.region,
    tile: options.tile,
    mirrorAxis: analysis.mirror?.axis ?? null,
    mirrorScore: analysis.mirror?.score ?? analysis.mirrorScore,
    center: input.center,
    featureRate: features?.rate ?? 100,
    minPeak: MIN_PEAK,
    template: { size: TEMPLATE, reach: TEMPLATE_REACH, sigma: TEMPLATE_SIGMA },
    shake: shake.shake ? { ...shake.shake, rms: shake.report.rms, tiltRms: shake.report.tiltRms } : null,
  };
  return encodeSafetensors(tensors, { pmatch: JSON.stringify(meta) });
}
