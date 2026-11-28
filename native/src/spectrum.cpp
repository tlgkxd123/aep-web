/** Audio Spectrum's analysis (spectrum.h), as audioSpectrumAnalysis.ts computes it, operation for operation. */
#include "spectrum.h"

#include <cmath>
#include <map>
#include <memory>
#include <string>
#include <tuple>

namespace aevk {
namespace {

struct FftTables {
  /** Bit-reversed index of each index. */
  std::vector<uint32_t> reverse;
  /** cos and sin of 2 pi k / n, k < n / 2. */
  std::vector<double> cos, sin;
};

const FftTables& tablesFor(size_t n) {
  static std::map<size_t, std::unique_ptr<FftTables>> tables;
  auto it = tables.find(n);
  if (it != tables.end()) return *it->second;
  auto t = std::make_unique<FftTables>();
  t->reverse.assign(n, 0);
  for (size_t i = 1, j = 0; i < n; i++) {
    size_t bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    t->reverse[i] = uint32_t(j);
  }
  t->cos.resize(n >> 1);
  t->sin.resize(n >> 1);
  for (size_t k = 0; k < (n >> 1); k++) {
    t->cos[k] = std::cos((2 * M_PI * double(k)) / double(n));
    t->sin[k] = std::sin((2 * M_PI * double(k)) / double(n));
  }
  if (tables.size() > 16) tables.clear();
  return *(tables[n] = std::move(t));
}

/** Math.round: half up. */
double jsRound(double v) { return std::floor(v + 0.5); }

/** The Hamming window's value at n of length (1 for a single sample). */
double hamming(double n, double length) { return length > 1 ? 0.54 - 0.46 * std::cos((2 * M_PI * n) / (length - 1)) : 1; }

struct Plan {
  size_t length = 0, bands = 0, size = 0;
  double windowSum = 0;
  /** Pre-chirp per input sample, times the window. */
  std::vector<double> preRe, preIm;
  /** FFT of the chirp filter, wrapped. */
  std::vector<double> filterRe, filterIm;
  /** Scratch for one analysis. */
  std::vector<double> re, im;
};

Plan& planFor(double rate, size_t length, size_t bands, double f0, double f1) {
  static std::map<std::tuple<double, size_t, size_t, double, double>, std::unique_ptr<Plan>> plans;
  const auto key = std::make_tuple(rate, length, bands, f0, f1);
  auto it = plans.find(key);
  if (it != plans.end()) return *it->second;
  auto p = std::make_unique<Plan>();
  /** Frequencies in cycles per sample. */
  const double delta = (f1 - f0) / double(bands) / rate;
  const double phi0 = f0 / rate;
  size_t size = 1;
  while (size < length + bands - 1) size <<= 1;
  std::vector<double> window(length);
  double windowSum = 0;
  for (size_t n = 0; n < length; n++) {
    window[n] = hamming(double(n), double(length));
    windowSum += window[n];
  }
  /** n k = (n^2 + k^2 - (k - n)^2) / 2: the chirp's phase, its square taken modulo a whole turn's period (JS's %). */
  double period = 2 / delta;
  if (period == 0 || std::isnan(period)) period = INFINITY;
  const auto chirp = [&](double m) { return M_PI * delta * std::fmod(m * m, period); };
  p->preRe.resize(length);
  p->preIm.resize(length);
  for (size_t n = 0; n < length; n++) {
    const double a = -chirp(double(n)) - 2 * M_PI * std::fmod(phi0 * double(n), 1.0);
    p->preRe[n] = window[n] * std::cos(a);
    p->preIm[n] = window[n] * std::sin(a);
  }
  p->filterRe.assign(size, 0);
  p->filterIm.assign(size, 0);
  for (long long m = -(long long)(length - 1); m < (long long)bands; m++) {
    const size_t at = size_t((m + (long long)size) % (long long)size);
    p->filterRe[at] = std::cos(chirp(double(m)));
    p->filterIm[at] = std::sin(chirp(double(m)));
  }
  fft(p->filterRe.data(), p->filterIm.data(), size, -1);
  p->length = length;
  p->bands = bands;
  p->size = size;
  p->windowSum = windowSum;
  p->re.assign(size, 0);
  p->im.assign(size, 0);
  if (plans.size() > 64) plans.clear();
  return *(plans[key] = std::move(p));
}

/** Length in samples of the short Hamming window whose response shapes averaged spectra. */
constexpr int kAveragingLength = 92;

}  // namespace

void fft(double* re, double* im, size_t n, int sign) {
  if (n < 2) return;
  const FftTables& t = tablesFor(n);
  const double* cos = t.cos.data();
  const double* sin = t.sin.data();
  for (size_t i = 1; i < n; i++) {
    const size_t j = t.reverse[i];
    if (i < j) {
      std::swap(re[i], re[j]);
      std::swap(im[i], im[j]);
    }
  }
  /** The first two stages need no twiddle multiplications. */
  for (size_t a = 0; a < n; a += 2) {
    const double tr = re[a + 1], ti = im[a + 1];
    re[a + 1] = re[a] - tr;
    im[a + 1] = im[a] - ti;
    re[a] += tr;
    im[a] += ti;
  }
  if (n >= 4) {
    for (size_t a = 0; a < n; a += 4) {
      double tr = re[a + 2], ti = im[a + 2];
      re[a + 2] = re[a] - tr;
      im[a + 2] = im[a] - ti;
      re[a] += tr;
      im[a] += ti;
      /** Times e^{sign i pi / 2}. */
      tr = -sign * im[a + 3];
      ti = sign * re[a + 3];
      re[a + 3] = re[a + 1] - tr;
      im[a + 3] = im[a + 1] - ti;
      re[a + 1] += tr;
      im[a + 1] += ti;
    }
  }
  /** Then pairs of stages in one pass: blocks of `size` (spans h) and of 2 size (spans size). */
  size_t size = 8;
  for (; 2 * size <= n; size <<= 2) {
    const size_t h = size >> 1;
    const size_t s1 = n / size;
    const size_t s2 = s1 >> 1;
    for (size_t start = 0; start < n; start += 2 * size) {
      for (size_t k = 0; k < h; k++) {
        const double w1r = cos[k * s1], w1i = sign * sin[k * s1];
        const double w2r = cos[k * s2], w2i = sign * sin[k * s2];
        const size_t a0 = start + k, a1 = a0 + h, a2 = a0 + size, a3 = a2 + h;
        double xr = re[a1] * w1r - im[a1] * w1i;
        double xi = re[a1] * w1i + im[a1] * w1r;
        const double b0r = re[a0] + xr, b0i = im[a0] + xi;
        const double b1r = re[a0] - xr, b1i = im[a0] - xi;
        xr = re[a3] * w1r - im[a3] * w1i;
        xi = re[a3] * w1i + im[a3] * w1r;
        const double b2r = re[a2] + xr, b2i = im[a2] + xi;
        const double b3r = re[a2] - xr, b3i = im[a2] - xi;
        xr = b2r * w2r - b2i * w2i;
        xi = b2r * w2i + b2i * w2r;
        re[a0] = b0r + xr;
        im[a0] = b0i + xi;
        re[a2] = b0r - xr;
        im[a2] = b0i - xi;
        /** The second span's twiddle is w2 e^{sign i pi / 2}. */
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
    const size_t half = size >> 1;
    const size_t stride = n / size;
    for (size_t k = 0; k < half; k++) {
      const double wr = cos[k * stride], wi = sign * sin[k * stride];
      const size_t b = k + half;
      const double tr = re[b] * wr - im[b] * wi;
      const double ti = re[b] * wi + im[b] * wr;
      re[b] = re[k] - tr;
      im[b] = im[k] - ti;
      re[k] += tr;
      im[k] += ti;
    }
  }
}

double windowLength(double rate, double durationMs) { return std::fmax(1, jsRound((durationMs / 1000) * rate)); }

double windowStart(double time, double rate, double length, double placement) { return jsRound(time * rate - length * placement + 1e-6); }

std::vector<float> analyse(const std::vector<float>& samples, double rate, const SpectrumSettings& settings) {
  const double b = std::floor(settings.bands);
  const size_t bands = b > 0 ? size_t(b) : 0;
  std::vector<float> out(bands, 0.0f);
  const size_t length = samples.size();
  if (!bands || !length) return out;
  Plan& p = planFor(rate, length, bands, settings.startFrequency, settings.endFrequency);
  double* re = p.re.data();
  double* im = p.im.data();
  std::fill(p.re.begin() + long(length), p.re.end(), 0.0);
  std::fill(p.im.begin() + long(length), p.im.end(), 0.0);
  for (size_t n = 0; n < length; n++) {
    const double s = samples[n];
    re[n] = s * p.preRe[n];
    im[n] = s * p.preIm[n];
  }
  fft(re, im, p.size, -1);
  for (size_t i = 0; i < p.size; i++) {
    const double r = re[i] * p.filterRe[i] - im[i] * p.filterIm[i];
    im[i] = re[i] * p.filterIm[i] + im[i] * p.filterRe[i];
    re[i] = r;
  }
  fft(re, im, p.size, 1);
  const double scale = 2 / p.windowSum / double(p.size);
  for (size_t k = 0; k < bands; k++) out[k] = float(std::hypot(re[k], im[k]) * scale);
  return out;
}

std::vector<float> analyseAveraged(const std::vector<float>& samples, double rate, const SpectrumSettings& settings) {
  const double b = std::floor(settings.bands);
  const size_t bands = b > 0 ? size_t(b) : 0;
  std::vector<float> out(bands, 0.0f);
  const size_t length = samples.size();
  if (!bands || !length) return out;
  double windowSum = 0, mean = 0;
  for (size_t n = 0; n < length; n++) {
    const double w = hamming(double(n), double(length));
    windowSum += w;
    mean += w * samples[n];
  }
  const double dc = (2 * std::fabs(mean)) / windowSum;
  static std::map<std::tuple<double, size_t, double, double>, std::vector<float>> rolloffs;
  const auto key = std::make_tuple(rate, bands, settings.startFrequency, settings.endFrequency);
  auto it = rolloffs.find(key);
  if (it == rolloffs.end()) {
    std::vector<float> rolloff(bands);
    double h[kAveragingLength];
    double sum = 0;
    for (int m = 0; m < kAveragingLength; m++) sum += (h[m] = hamming(m, kAveragingLength));
    for (size_t k = 0; k < bands; k++) {
      const double f = (settings.startFrequency + (double(k) * (settings.endFrequency - settings.startFrequency)) / double(bands)) / rate;
      double re = 0, im = 0;
      for (int m = 0; m < kAveragingLength; m++) {
        re += h[m] * std::cos(2 * M_PI * f * m);
        im -= h[m] * std::sin(2 * M_PI * f * m);
      }
      rolloff[k] = float(std::hypot(re, im) / sum);
    }
    if (rolloffs.size() > 64) rolloffs.clear();
    it = rolloffs.emplace(key, std::move(rolloff)).first;
  }
  for (size_t k = 0; k < bands; k++) out[k] = float(dc * double(it->second[k]));
  return out;
}

}  // namespace aevk
