/**
 * Audio Spectrum's analysis (src/render/effects/audioSpectrumAnalysis.ts): band magnitudes of a Hamming window of
 * mono samples, read at exactly the band frequencies with a chirp-z (Bluestein) transform, so a sine of amplitude A
 * reads A.
 */
#pragma once
#include <cstddef>
#include <vector>

namespace aevk {

struct SpectrumSettings {
  double startFrequency = 20;
  double endFrequency = 2000;
  double bands = 64;
  /** Window length in milliseconds. */
  double durationMs = 90;
};

/** Share of the window that lies before the analysed time: After Effects starts it half its length after that time. */
constexpr double kWindowPlacement = -0.5;

/** In-place radix-2 complex FFT of a power-of-two length (sign -1 forward, +1 inverse, unscaled). */
void fft(double* re, double* im, size_t n, int sign);
/** Samples in the analysis window. */
double windowLength(double rate, double durationMs);
/** Index of the window's first sample for analysed time `time` (seconds, t = index / rate). */
double windowStart(double time, double rate, double length, double placement = kWindowPlacement);
/** Band magnitudes (in sample amplitude) of a window of mono samples. */
std::vector<float> analyse(const std::vector<float>& samples, double rate, const SpectrumSettings& settings);
/** Duration Averaging, as far as it is measured (analyseAveraged). */
std::vector<float> analyseAveraged(const std::vector<float>& samples, double rate, const SpectrumSettings& settings);

}  // namespace aevk
