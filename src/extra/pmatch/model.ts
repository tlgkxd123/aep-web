// A particle world model learned from a reference video (train.ts). Particles are
// born at an emitter one unit in front of a pinhole camera and fly in straight
// lines through particle space; a global clock driven by the music sets how fast
// particle time passes, and a zoom driven by the music scales the picture. What a
// particle is (its velocity, birth offset, size, brightness, life and sprite) is
// drawn from a bank of prototypes fitted to tracked particles, with kernel jitter.
//
// Screen coordinates are the reference's, relative to the emitter and in units of
// the frame height (y down): a particle at (x, y, z) is seen at (x, y) / z. Its
// size and light follow depth by learned exponents: z^-sizeDepth, z^-lightDepth
// (1 is a real perspective; 0 keeps sprites the same however near they come).
// The whole picture may also shake, as Sapphire S_Shake shakes it (shake.ts).
import type { ShakeModel } from "./shake.ts";

export const MODEL_VERSION = 1;
const MAGIC = 0x4d574d50; // "PMWM", little endian

/** Floats per prototype. */
export const PROTO_STRIDE = 10;
/** Offsets in a prototype: velocity (units per clock second), birth offset from the emitter, size and amplitude at depth 1, life (clock seconds), sprite class. */
export const P_VX = 0;
export const P_VY = 1;
export const P_VZ = 2;
export const P_OX = 3;
export const P_OY = 4;
export const P_OZ = 5;
export const P_SIZE = 6;
export const P_AMP = 7;
export const P_LIFE = 8;
export const P_SPRITE = 9;

/** Jitter scales: log speed, direction (radians), log size, log amplitude, log life. */
export const JITTER_COUNT = 5;
/** Samples of the opacity-over-life curve, birth to death. */
export const LIFE_SAMPLES = 32;
/** Particles closer to the camera than this are not drawn. */
export const NEAR_Z = 0.05;

export interface SpriteBank {
  /** Texels per side of each template. */
  size: number;
  /** Half the template's width in units of the particle's size. */
  reach: number;
  count: number;
  /** count × size × size luminance, peak 1, rows top first. */
  data: Float32Array;
  /** count × 3 colour each sprite's light is tinted by. */
  tint: Float32Array;
}

export interface Dynamics {
  /** Audio feature rate (frames per second) and features per frame (audio.ts). */
  rate: number;
  inputs: number;
  hidden: number;
  /** Seconds the picture follows the audio by. */
  lag: number;
  /**
   * W1 (hidden × inputs), b1 (hidden), W2 (2 × hidden), b2 (2), skip (2 × inputs):
   * out = W2 tanh(W1 f + b1) + b2 + skip f, giving log clock speed and log zoom.
   */
  weights: Float32Array;
}

export interface ModelSource {
  name: string;
  width: number;
  height: number;
  frameRate: number;
  /** x of the mirror axis in source pixels, null when the reference is not mirrored. */
  mirrorAxis: number | null;
  /** Emitter position in source pixels. */
  center: [number, number];
  /** Training window in seconds of the reference. */
  train: [number, number];
}

export interface ParticleWorldModel {
  version: number;
  /** Births per clock second. */
  rate: number;
  /** Clock seconds already run at time 0, so the first frame is as full as later ones. */
  preRun: number;
  sizeDepth: number;
  lightDepth: number;
  prototypes: Float32Array;
  /** Sampling weight of each prototype. */
  weights: Float32Array;
  jitter: Float32Array;
  opacityOverLife: Float32Array;
  sprites: SpriteBank;
  dynamics: Dynamics;
  /** How the reference's picture shakes; null when it does not (or the model predates shakes). */
  shake: ShakeModel | null;
  source: ModelSource;
  /** Training measurements shown to the user. */
  report: Record<string, number>;
}

export function prototypeCount(model: ParticleWorldModel): number {
  return model.prototypes.length / PROTO_STRIDE;
}

export function dynamicsWeightCount(inputs: number, hidden: number): number {
  return hidden * inputs + hidden + 2 * hidden + 2 + 2 * inputs;
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function packFloats(values: Float32Array): string {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return base64(bytes);
}

function unpackFloats(text: unknown, expected?: number): Float32Array {
  if (typeof text !== "string") throw new Error("model array is missing");
  const bytes = fromBase64(text);
  if (bytes.length % 4 || (expected !== undefined && bytes.length !== expected * 4)) throw new Error("model array has the wrong length");
  const view = new DataView(bytes.buffer);
  return Float32Array.from({ length: bytes.length / 4 }, (_, i) => view.getFloat32(i * 4, true));
}

/** The model as stored in the effect's Model parameter: magic, version, then JSON. */
export function encodeModel(model: ParticleWorldModel): Uint8Array {
  const json = JSON.stringify({
    rate: model.rate,
    preRun: model.preRun,
    sizeDepth: model.sizeDepth,
    lightDepth: model.lightDepth,
    prototypes: packFloats(model.prototypes),
    weights: packFloats(model.weights),
    jitter: packFloats(model.jitter),
    opacityOverLife: packFloats(model.opacityOverLife),
    sprites: { ...model.sprites, data: packFloats(model.sprites.data), tint: packFloats(model.sprites.tint) },
    dynamics: { ...model.dynamics, weights: packFloats(model.dynamics.weights) },
    shake: model.shake,
    source: model.source,
    report: model.report,
  });
  const text = new TextEncoder().encode(json);
  const out = new Uint8Array(8 + text.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, MODEL_VERSION, true);
  out.set(text, 8);
  return out;
}

const finite = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`model ${what} is not a number`);
  return v;
};

function decodeShake(raw: Record<string, unknown>): ShakeModel {
  const weights = raw.weights;
  if (!Array.isArray(weights) || weights.length > 64) throw new Error("model shake is malformed");
  const shake: ShakeModel = {
    frequency: finite(raw.frequency, "shake frequency"),
    x: finite(raw.x, "shake x"),
    y: finite(raw.y, "shake y"),
    tilt: finite(raw.tilt, "shake tilt"),
    bias: finite(raw.bias, "shake bias"),
    weights: weights.map((w) => finite(w, "shake weight")),
    lag: finite(raw.lag, "shake lag"),
    level: finite(raw.level, "shake level"),
  };
  if (shake.frequency <= 0 || shake.x < 0 || shake.y < 0 || shake.tilt < 0) throw new Error("model shake is malformed");
  return shake;
}

/** Reads a stored model; throws on anything that is not a well-formed model of this version. */
export function decodeModel(bytes: Uint8Array): ParticleWorldModel {
  if (bytes.length < 8) throw new Error("model data is too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) throw new Error("not a Particle Match model");
  const version = view.getUint32(4, true);
  if (version !== MODEL_VERSION) throw new Error(`model version ${version} is not supported`);
  const raw = JSON.parse(new TextDecoder().decode(bytes.subarray(8)));
  const prototypes = unpackFloats(raw.prototypes);
  if (!prototypes.length || prototypes.length % PROTO_STRIDE) throw new Error("model prototypes are malformed");
  const count = prototypes.length / PROTO_STRIDE;
  const s = raw.sprites ?? {};
  const spriteSize = finite(s.size, "sprite size");
  const spriteCount = finite(s.count, "sprite count");
  if (spriteSize < 1 || spriteSize > 256 || spriteCount < 1 || spriteCount > 64) throw new Error("model sprites are malformed");
  const d = raw.dynamics ?? {};
  const inputs = finite(d.inputs, "dynamics inputs");
  const hidden = finite(d.hidden, "dynamics size");
  const model: ParticleWorldModel = {
    version,
    rate: finite(raw.rate, "rate"),
    preRun: finite(raw.preRun, "pre-run"),
    sizeDepth: finite(raw.sizeDepth, "size depth"),
    lightDepth: finite(raw.lightDepth, "light depth"),
    prototypes,
    weights: unpackFloats(raw.weights, count),
    jitter: unpackFloats(raw.jitter, JITTER_COUNT),
    opacityOverLife: unpackFloats(raw.opacityOverLife, LIFE_SAMPLES),
    sprites: {
      size: spriteSize,
      reach: finite(s.reach, "sprite reach"),
      count: spriteCount,
      data: unpackFloats(s.data, spriteCount * spriteSize * spriteSize),
      tint: unpackFloats(s.tint, spriteCount * 3),
    },
    dynamics: {
      rate: finite(d.rate, "feature rate"),
      inputs,
      hidden,
      lag: finite(d.lag, "lag"),
      weights: unpackFloats(d.weights, dynamicsWeightCount(inputs, hidden)),
    },
    shake: raw.shake ? decodeShake(raw.shake) : null,
    source: raw.source,
    report: raw.report ?? {},
  };
  for (let i = 0; i < count; i++) {
    const sprite = prototypes[i * PROTO_STRIDE + P_SPRITE];
    if (!(sprite >= 0 && sprite < spriteCount)) throw new Error("model prototype has no sprite");
  }
  return model;
}
