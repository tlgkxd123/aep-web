// The analysis half of Audio Spectrum, fitted to After Effects renders of test
// tones: a Hamming window of Audio Duration that starts half its length after
// the layer time plus Audio Offset, over the mean of the audio's channels;
// band k of N is read at f0 + k (f1 − f0) / N as 2 |X(f)| / Σw, so a sine of
// amplitude A reads A.
//
// The DFT is evaluated at exactly the band frequencies with a chirp-z
// (Bluestein) transform: two FFTs of the next power of two above
// window + bands samples per frame, plus one cached FFT of the chirp per setting.

export interface SpectrumSettings {
  startFrequency: number;
  endFrequency: number;
  bands: number;
  /** Window length in milliseconds. */
  durationMs: number;
}

/**
 * Share of the window that lies before the analysed time (layer time plus
 * Audio Offset). After Effects starts the window half its length after that time.
 */
export const WINDOW_PLACEMENT = -0.5;

interface FftTables {
  /** Bit-reversed index of each index. */
  reverse: Uint32Array;
  /** cos and sin of 2πk/n, k < n/2. */
  cos: Float64Array;
  sin: Float64Array;
}
const fftTables = new Map<number, FftTables>();

function tablesFor(n: number): FftTables {
  let t = fftTables.get(n);
  if (t) return t;
  const reverse = new Uint32Array(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    reverse[i] = j;
  }
  const cos = new Float64Array(n >> 1);
  const sin = new Float64Array(n >> 1);
  for (let k = 0; k < n >> 1; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / n);
    sin[k] = Math.sin((2 * Math.PI * k) / n);
  }
  t = { reverse, cos, sin };
  if (fftTables.size > 16) fftTables.clear();
  fftTables.set(n, t);
  return t;
}

/** In-place radix-2 complex FFT of a power-of-two length (sign −1 forward, +1 inverse, unscaled). */
export function fft(re: Float64Array, im: Float64Array, sign: number): void {
  const n = re.length;
  if (n < 2) return;
  const { reverse, cos, sin } = tablesFor(n);
  for (let i = 1; i < n; i++) {
    const j = reverse[i];
    if (i < j) {
      let t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }
  // The first two stages need no twiddle multiplications.
  for (let a = 0; a < n; a += 2) {
    const tr = re[a + 1];
    const ti = im[a + 1];
    re[a + 1] = re[a] - tr;
    im[a + 1] = im[a] - ti;
    re[a] += tr;
    im[a] += ti;
  }
  if (n >= 4) {
    for (let a = 0; a < n; a += 4) {
      let tr = re[a + 2];
      let ti = im[a + 2];
      re[a + 2] = re[a] - tr;
      im[a + 2] = im[a] - ti;
      re[a] += tr;
      im[a] += ti;
      // Times e^{sign·iπ/2}.
      tr = -sign * im[a + 3];
      ti = sign * re[a + 3];
      re[a + 3] = re[a + 1] - tr;
      im[a + 3] = im[a + 1] - ti;
      re[a + 1] += tr;
      im[a + 1] += ti;
    }
  }
  // Then pairs of stages in one pass: blocks of `size` (spans h) and of 2·size (spans size).
  let size = 8;
  for (; 2 * size <= n; size <<= 2) {
    const h = size >> 1;
    const s1 = n / size;
    const s2 = s1 >> 1;
    for (let start = 0; start < n; start += 2 * size) {
      for (let k = 0; k < h; k++) {
        const w1r = cos[k * s1];
        const w1i = sign * sin[k * s1];
        const w2r = cos[k * s2];
        const w2i = sign * sin[k * s2];
        const a0 = start + k;
        const a1 = a0 + h;
        const a2 = a0 + size;
        const a3 = a2 + h;
        let xr = re[a1] * w1r - im[a1] * w1i;
        let xi = re[a1] * w1i + im[a1] * w1r;
        const b0r = re[a0] + xr;
        const b0i = im[a0] + xi;
        const b1r = re[a0] - xr;
        const b1i = im[a0] - xi;
        xr = re[a3] * w1r - im[a3] * w1i;
        xi = re[a3] * w1i + im[a3] * w1r;
        const b2r = re[a2] + xr;
        const b2i = im[a2] + xi;
        const b3r = re[a2] - xr;
        const b3i = im[a2] - xi;
        xr = b2r * w2r - b2i * w2i;
        xi = b2r * w2i + b2i * w2r;
        re[a0] = b0r + xr;
        im[a0] = b0i + xi;
        re[a2] = b0r - xr;
        im[a2] = b0i - xi;
        // The second span's twiddle is w2 · e^{sign·iπ/2}.
        xr = -sign * (b3r * w2i + b3i * w2r);
        xi = sign * (b3r * w2r - b3i * w2i);
        re[a1] = b1r + xr;
        im[a1] = b1i + xi;
        re[a3] = b1r - xr;
        im[a3] = b1i - xi;
      }
    }
  }
  if (size <= n) {
    const half = size >> 1;
    const stride = n / size;
    for (let k = 0; k < half; k++) {
      const wr = cos[k * stride];
      const wi = sign * sin[k * stride];
      const b = k + half;
      const tr = re[b] * wr - im[b] * wi;
      const ti = re[b] * wi + im[b] * wr;
      re[b] = re[k] - tr;
      im[b] = im[k] - ti;
      re[k] += tr;
      im[k] += ti;
    }
  }
}

interface Plan {
  length: number;
  bands: number;
  size: number;
  windowSum: number;
  /** Pre-chirp per input sample, times the window: w[n] · e^{−iπ Δ n²} · e^{−2πi φ0 n}. */
  preRe: Float64Array;
  preIm: Float64Array;
  /** FFT of the chirp filter e^{iπ Δ m²}, m = −(length−1)..bands−1, wrapped. */
  filterRe: Float64Array;
  filterIm: Float64Array;
  /** Scratch for one analysis. */
  re: Float64Array;
  im: Float64Array;
}

const plans = new Map<string, Plan>();

function plan(rate: number, length: number, settings: SpectrumSettings): Plan {
  const { startFrequency: f0, endFrequency: f1, bands } = settings;
  const key = `${rate}:${length}:${bands}:${f0}:${f1}`;
  let p = plans.get(key);
  if (p) return p;
  // Frequencies in cycles per sample.
  const delta = (f1 - f0) / bands / rate;
  const phi0 = f0 / rate;
  let size = 1;
  while (size < length + bands - 1) size <<= 1;
  const window = new Float64Array(length);
  let windowSum = 0;
  for (let n = 0; n < length; n++) {
    window[n] = length > 1 ? 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (length - 1)) : 1;
    windowSum += window[n];
  }
  // n·k = (n² + k² − (k − n)²) / 2, so X_k = e^{−iπΔk²} Σ_n x_n e^{−2πiφ0 n} e^{−iπΔn²} e^{iπΔ(k−n)²}.
  const chirp = (m: number) => Math.PI * delta * ((m * m) % (2 / delta || Infinity));
  const preRe = new Float64Array(length);
  const preIm = new Float64Array(length);
  for (let n = 0; n < length; n++) {
    const a = -chirp(n) - 2 * Math.PI * ((phi0 * n) % 1);
    preRe[n] = window[n] * Math.cos(a);
    preIm[n] = window[n] * Math.sin(a);
  }
  const filterRe = new Float64Array(size);
  const filterIm = new Float64Array(size);
  for (let m = -(length - 1); m < bands; m++) {
    const at = (m + size) % size;
    filterRe[at] = Math.cos(chirp(m));
    filterIm[at] = Math.sin(chirp(m));
  }
  fft(filterRe, filterIm, -1);
  p = { length, bands, size, windowSum, preRe, preIm, filterRe, filterIm, re: new Float64Array(size), im: new Float64Array(size) };
  if (plans.size > 64) plans.clear();
  plans.set(key, p);
  return p;
}

/** Samples in the analysis window. */
export function windowLength(rate: number, durationMs: number): number {
  return Math.max(1, Math.round((durationMs / 1000) * rate));
}

/** Index of the window's first sample for analysed time `time` (seconds, t = index / rate). */
export function windowStart(time: number, rate: number, length: number, placement = WINDOW_PLACEMENT): number {
  return Math.round(time * rate - length * placement);
}

/** Length in samples of the short Hamming window whose response shapes averaged spectra. */
export const AVERAGING_LENGTH = 92;

const rolloffs = new Map<string, Float32Array>();

/**
 * Duration Averaging, as far as it is measured: every band reads the window's
 * Hamming-weighted mean, 2 |Σ w x| / Σw, times the normalised response at the
 * band frequency of an AVERAGING_LENGTH-sample Hamming window. After Effects
 * draws tones larger than this: about 4× for a steady 440 Hz sine and far more
 * where one starts or stops, which stays under a pixel at ordinary Maximum
 * Heights but not in the thousands.
 */
export function analyseAveraged(samples: Float32Array, rate: number, settings: SpectrumSettings): Float32Array {
  const bands = Math.max(0, Math.floor(settings.bands));
  const out = new Float32Array(bands);
  const length = samples.length;
  if (!bands || !length) return out;
  let windowSum = 0;
  let mean = 0;
  for (let n = 0; n < length; n++) {
    const w = length > 1 ? 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (length - 1)) : 1;
    windowSum += w;
    mean += w * samples[n];
  }
  const dc = (2 * Math.abs(mean)) / windowSum;
  const key = `${rate}:${bands}:${settings.startFrequency}:${settings.endFrequency}`;
  let rolloff = rolloffs.get(key);
  if (!rolloff) {
    rolloff = new Float32Array(bands);
    const L = AVERAGING_LENGTH;
    const h = Array.from({ length: L }, (_, m) => 0.54 - 0.46 * Math.cos((2 * Math.PI * m) / (L - 1)));
    const sum = h.reduce((a, b) => a + b, 0);
    for (let k = 0; k < bands; k++) {
      const f = (settings.startFrequency + (k * (settings.endFrequency - settings.startFrequency)) / bands) / rate;
      let re = 0;
      let im = 0;
      for (let m = 0; m < L; m++) {
        re += h[m] * Math.cos(2 * Math.PI * f * m);
        im -= h[m] * Math.sin(2 * Math.PI * f * m);
      }
      rolloff[k] = Math.hypot(re, im) / sum;
    }
    if (rolloffs.size > 64) rolloffs.clear();
    rolloffs.set(key, rolloff);
  }
  for (let k = 0; k < bands; k++) out[k] = dc * rolloff[k];
  return out;
}

/** Band magnitudes (in sample amplitude) of a window of `windowLength` mono samples. */
export function analyse(samples: Float32Array, rate: number, settings: SpectrumSettings): Float32Array {
  const bands = Math.max(0, Math.floor(settings.bands));
  const out = new Float32Array(bands);
  const length = samples.length;
  if (!bands || !length) return out;
  const p = plan(rate, length, { ...settings, bands });
  const { re, im } = p;
  re.fill(0, length);
  im.fill(0, length);
  // The chirp phases are taken relative to the window start; |X| does not depend on that origin.
  for (let n = 0; n < length; n++) {
    const s = samples[n];
    re[n] = s * p.preRe[n];
    im[n] = s * p.preIm[n];
  }
  fft(re, im, -1);
  for (let i = 0; i < p.size; i++) {
    const r = re[i] * p.filterRe[i] - im[i] * p.filterIm[i];
    im[i] = re[i] * p.filterIm[i] + im[i] * p.filterRe[i];
    re[i] = r;
  }
  fft(re, im, 1);
  const scale = 2 / p.windowSum / p.size;
  for (let k = 0; k < bands; k++) out[k] = Math.hypot(re[k], im[k]) * scale;
  return out;
}
