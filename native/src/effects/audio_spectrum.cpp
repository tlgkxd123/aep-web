/**
 * Audio Spectrum (ADBE AudSpect), as src/render/effects/audioSpectrum.ts draws it: the spectrum of the sound the plan
 * names (media.h, spectrum.h), laid out along the Start/End line, the effect's mask or the polar path, and drawn as
 * capsules in one instanced draw per run with the effect's own shaders.
 */
#include <algorithm>
#include <array>
#include <cmath>
#include <list>
#include <map>
#include <sstream>
#include <unordered_map>

#include "../media.h"
#include "../spectrum.h"
#include "effects.h"
#include "stock.h"

namespace aevk {
namespace {

/** Bar height per unit of Maximum Height and of magnitude. */
constexpr double kHeightScale = 0.535;
/** The colour runs Inside to Outside over at least this many pixels from the axis. */
constexpr double kMinColorRadius = 2;
constexpr int kDigital = 1, kLines = 2, kDots = 3;
constexpr int kSideA = 1, kSideB = 2, kSideBoth = 3;
constexpr int kBezierSteps = 64;

/** Width of the opacity ramp across a capsule edge. */
double rampWidth(double thickness, double softness) { return 1 + softness * std::max(0.0, thickness - 1); }

/** Position and derivative of a cubic bezier (a, c1, c2, b as x, y pairs) at `t`. */
std::array<double, 4> bezier(const std::array<double, 8>& c, double t) {
  const double u = 1 - t;
  const double x = u * u * u * c[0] + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6];
  const double y = u * u * u * c[1] + 3 * u * u * t * c[3] + 3 * u * t * t * c[5] + t * t * t * c[7];
  const double dx = 3 * u * u * (c[2] - c[0]) + 6 * u * t * (c[4] - c[2]) + 3 * t * t * (c[6] - c[4]);
  const double dy = 3 * u * u * (c[3] - c[1]) + 6 * u * t * (c[5] - c[3]) + 3 * t * t * (c[7] - c[5]);
  return {x, y, dx, dy};
}

/** A path flattened for arc-length lookup (Polyline in audioSpectrum.ts). */
struct Polyline {
  std::vector<double> lengths;
  std::vector<size_t> segment;
  std::vector<double> param;
  std::vector<std::array<double, 8>> controls;
};

Polyline flatten(const EffectPath& path) {
  Polyline line;
  const size_t n = path.vertices.size() / 6;
  if (!n) return line;
  const auto v = [&](size_t i, size_t k) { return double(path.vertices[i * 6 + k]); };
  const size_t count = path.closed ? n : n - 1;
  double px = v(0, 0), py = v(0, 1);
  line.lengths.push_back(0);
  line.segment.push_back(0);
  line.param.push_back(0);
  for (size_t i = 0; i < count; i++) {
    const size_t j = (i + 1) % n;
    const double ax = v(i, 0), ay = v(i, 1), bx = v(j, 0), by = v(j, 1);
    const bool straight = !v(i, 4) && !v(i, 5) && !v(j, 2) && !v(j, 3);
    /** Straight segments get controls at the thirds, so the cubic moves along them at constant speed. */
    const std::array<double, 8> c = straight ? std::array<double, 8>{ax, ay, ax + (bx - ax) / 3, ay + (by - ay) / 3, bx - (bx - ax) / 3, by - (by - ay) / 3, bx, by}
                                             : std::array<double, 8>{ax, ay, ax + v(i, 4), ay + v(i, 5), bx + v(j, 2), by + v(j, 3), bx, by};
    line.controls.push_back(c);
    const int steps = straight ? 1 : kBezierSteps;
    for (int s = 1; s <= steps; s++) {
      const std::array<double, 4> p = bezier(c, double(s) / steps);
      line.lengths.push_back(line.lengths.back() + std::hypot(p[0] - px, p[1] - py));
      line.segment.push_back(i);
      line.param.push_back(double(s) / steps);
      px = p[0];
      py = p[1];
    }
  }
  return line;
}

/** Position and unit tangent at arc length `s` along `line`. */
std::array<double, 4> pointAt(const Polyline& line, double s) {
  const size_t n = line.lengths.size();
  if (n < 2) return {line.controls.empty() ? 0 : line.controls[0][0], line.controls.empty() ? 0 : line.controls[0][1], 1, 0};
  size_t lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const size_t mid = (lo + hi) >> 1;
    if (line.lengths[mid] <= s) lo = mid;
    else hi = mid;
  }
  const double span = line.lengths[lo + 1] - line.lengths[lo];
  const double f = span > 0 ? std::min(1.0, std::max(0.0, (s - line.lengths[lo]) / span)) : 0;
  const size_t segment = line.segment[lo + 1];
  const double t0 = line.segment[lo] == segment ? line.param[lo] : 0;
  const std::array<double, 8>& c = line.controls[segment];
  const std::array<double, 4> p = bezier(c, t0 + (line.param[lo + 1] - t0) * f);
  /** A zero-length tangent (coincident points, or a cusp): the chord instead. */
  const bool tangent = std::hypot(p[2], p[3]) > 1e-9;
  const double dx = tangent ? p[2] : c[6] - c[0];
  const double dy = tangent ? p[3] : c[7] - c[1];
  double len = std::hypot(dx, dy);
  if (!(len != 0)) len = 1;
  return {p[0], p[1], dx / len, dy / len};
}

/** Base point and Side A normal of each band (x, y, nx, ny), per run of all bands drawn as one path (layOutBands). */
std::vector<std::vector<double>> layOutBands(const std::vector<double>& start, const std::vector<double>& end, const EffectPath* path, bool polar, size_t bands,
                                             bool& polarOut) {
  std::vector<double> frames(bands * 4, 0.0);
  const auto at = [&](size_t k) { return bands > 1 ? double(k) / double(bands - 1) : 0.0; };
  const auto set = [](std::vector<double>& f, size_t k, double a, double b, double c, double d) {
    f[k * 4] = a;
    f[k * 4 + 1] = b;
    f[k * 4 + 2] = c;
    f[k * 4 + 3] = d;
  };
  polarOut = false;
  const double sx = start.size() > 0 ? start[0] : 0, sy = start.size() > 1 ? start[1] : 0;
  const double ex = end.size() > 0 ? end[0] : 0, ey = end.size() > 1 ? end[1] : 0;
  if (path && !path->vertices.empty()) {
    const Polyline line = flatten(*path);
    const double total = line.lengths.empty() ? 0 : line.lengths.back();
    for (size_t k = 0; k < bands; k++) {
      const std::array<double, 4> p = pointAt(line, total * (path->closed ? double(k) / double(bands) : at(k)));
      set(frames, k, p[0], p[1], p[3], -p[2]);
    }
  } else if (polar) {
    /** Rays from the Start Point at pi - pi k / (N - 1), mirrored below the horizontal; the End Point is not used. */
    std::vector<double> mirrored(bands * 4, 0.0);
    for (size_t k = 0; k < bands; k++) {
      const double a = M_PI * (1 - at(k));
      set(frames, k, sx, sy, std::cos(a), -std::sin(a));
      set(mirrored, k, sx, sy, std::cos(a), std::sin(a));
    }
    polarOut = true;
    return {frames, mirrored};
  } else {
    const double dx = ex - sx, dy = ey - sy;
    double len = std::hypot(dx, dy);
    if (!(len != 0)) len = 1;
    for (size_t k = 0; k < bands; k++) set(frames, k, sx + dx * at(k), sy + dy * at(k), dy / len, -dx / len);
  }
  return {frames};
}

/** Spectra already computed, by sound, window and settings (spectrumPrefetch.ts), the least recently used dropped first. */
class SpectrumCache {
 public:
  const std::vector<float>* find(const std::string& key) {
    auto it = index_.find(key);
    if (it == index_.end()) return nullptr;
    order_.splice(order_.begin(), order_, it->second);
    return &it->second->second;
  }
  const std::vector<float>& add(const std::string& key, std::vector<float> mags) {
    order_.emplace_front(key, std::move(mags));
    index_[key] = order_.begin();
    if (order_.size() > kMax) {
      index_.erase(order_.back().first);
      order_.pop_back();
    }
    return order_.front().second;
  }

 private:
  /** A few seconds of frames for a dozen instances. */
  static constexpr size_t kMax = 4096;
  std::list<std::pair<std::string, std::vector<float>>> order_;
  std::unordered_map<std::string, std::list<std::pair<std::string, std::vector<float>>>::iterator> index_;
};

/** The band magnitudes of `audio` at analysed time `time` (spectrumAt), cached. */
const std::vector<float>& spectrumAt(const LayerAudio& audio, double time, const SpectrumSettings& settings, bool averaged) {
  static SpectrumCache cache;
  const double perSecond = audio.rate * audio.timeScale;
  const double length = windowLength(perSecond, settings.durationMs);
  const double first = windowStart(time, perSecond, length);
  std::ostringstream key;
  key.precision(17);
  key << perSecond << ':';
  for (const AudioContribution& c : audio.contributions) key << static_cast<const void*>(c.audio) << ':' << c.scale << ':' << c.offset << ':' << c.from << ':' << c.to << '|';
  key << '#' << first << ':' << length << ':' << settings.startFrequency << ':' << settings.endFrequency << ':' << settings.bands << ':' << averaged;
  if (const std::vector<float>* cached = cache.find(key.str())) return *cached;
  const std::vector<float> samples = mixWindow(audio, first, size_t(length));
  return cache.add(key.str(), averaged ? analyseAveraged(samples, audio.rate, settings) : analyse(samples, audio.rate, settings));
}

FxImage render(FxImage input, const Effect& effect, const EffectLayer& layer, FxContext& ctx) {
  const FxParams p(effect);
  const bool composite = p.num(23, 0) != 0;
  const int pad = ctx.pad;
  Target* out = ctx.acquire(input.width + 2.0 * pad, input.height + 2.0 * pad);
  const auto finish = [&]() {
    if (!composite) {
      ctx.release(input.target);
      input.target = out;
      return input;
    }
    Target* merged = ctx.acquire(ctx.width(out), ctx.height(out));
    ctx.pass(fx::spectrum_composite, *merged, {out, input.target}, [](FxUniforms& u) {
      u.i("u_spectrum", 0);
      u.i("u_original", 1);
    });
    ctx.release(out);
    ctx.release(input.target);
    input.target = merged;
    return input;
  };
  if (!effect.hasAudio) return finish();

  LayerAudio audio;
  for (const AudioSource& source : effect.audio) {
    const AudioData* data = ctx.audio(source.file);
    if (!data || !data->length()) continue;
    if (audio.contributions.empty()) {
      audio.rate = data->sampleRate;
      audio.timeScale = std::fabs(source.scale);
    }
    audio.contributions.push_back({data, source.scale, source.offset, source.from, source.to});
  }
  const size_t bands = size_t(std::max(1.0, std::floor(p.num(8, 64) + 0.5)));
  SpectrumSettings settings;
  settings.startFrequency = p.num(6, 20);
  settings.endFrequency = p.num(7, 2000);
  settings.bands = double(bands);
  settings.durationMs = std::max(0.0, p.num(10, 90));
  const bool averaged = p.num(22, 0) != 0;
  /** An audio layer without sound is analysed as silence: the bands are drawn at zero height. */
  std::vector<float> mags(bands, 0.0f);
  if (!audio.contributions.empty()) mags = spectrumAt(audio, layer.time + p.num(11, 0) / 1000, settings, averaged);
  mags.resize(bands, 0.0f);

  const double maxHeight = p.num(9, 50);
  const double thickness = std::max(0.0, p.num(12, 3));
  const double softness = std::min(1.0, std::max(0.0, p.num(13, 0.5)));
  const std::vector<double> inside = p.vec(14, {1, 1, 1, 1});
  const std::vector<double> outside = p.vec(15, {1, 1, 1, 1});
  const int display = int(p.num(20, kDigital));
  const bool blend = p.num(16, 0) != 0;
  if (averaged) ctx.warn("Audio Spectrum: Duration Averaging is approximated (tones are drawn too small)");
  const double pathIndex = p.num(4, 0);
  if (effect.param(4) && pathIndex > 0 && !effect.hasPath) ctx.warn("Audio Spectrum: its Path mask was not found");

  bool polar = false;
  const std::vector<std::vector<double>> runs =
      layOutBands(p.vec(2, {0, 0}), p.vec(3, {0, 0}), pathIndex > 0 && effect.hasPath ? &effect.path : nullptr, p.num(5, 0) != 0, bands, polar);
  const int side = polar ? kSideA : int(p.num(21, kSideA));
  const double hue = p.num(17, 0);
  const bool dynamic = p.num(18, 1) != 0;
  const bool symmetry = p.num(19, 1) != 0;

  /** The runs' band layout and the magnitudes, a row each (uploadBands), in the first unit. */
  const uint32_t width = uint32_t(bands);
  const uint32_t height = uint32_t(runs.size() + 1);
  std::vector<float> data(size_t(width) * height * 4, 0.0f);
  for (size_t r = 0; r < runs.size(); r++)
    for (size_t i = 0; i < runs[r].size(); i++) data[r * width * 4 + i] = float(runs[r][i]);
  for (size_t k = 0; k < bands; k++) data[(runs.size() * width + k) * 4] = mags[k];
  Target* bandData = ctx.upload(data.data(), width, height);

  /** Widths in this image's pixels (positions are converted in the vertex shader). */
  const double scale = input.scale;
  const double thick = thickness * scale;
  const double ramp = rampWidth(thick, softness);
  const double edge = thick / 2;
  double phase = 0;
  if (dynamic && hue != 0) {
    size_t strongest = 0;
    for (size_t k = 1; k < bands; k++)
      if (mags[k] > mags[strongest]) strongest = k;
    const double f = bands > 1 ? double(strongest) / double(bands - 1) : 0;
    phase = symmetry ? 1 - std::fabs(2 * f - 1) : f;
  }
  const bool both = side == kSideBoth;
  const int sides = display == kDots && both ? 2 : 1;
  const int count = display == kLines ? std::max(int(bands) - 1, 1) : display == kDots ? sides * int(bands) : int(bands);
  const double colorRadius = std::max(edge, kMinColorRadius * scale);
  const float w = float(ctx.width(out)), h = float(ctx.height(out));
  const auto component = [](const std::vector<double>& c, size_t i) { return float(i < c.size() ? c[i] : 1); };
  std::vector<FxDraw> draws;
  for (size_t n = 0; n < runs.size(); n++) {
    const int run = int(blend ? runs.size() - 1 - n : n);
    FxDraw d;
    d.vertices = 4;
    d.instances = uint32_t(count);
    d.set = [=, &inside, &outside](FxUniforms& u) {
      u.i("u_data", 0);
      u.i("u_run", run);
      u.i("u_magRow", int(runs.size()));
      u.i("u_bands", int(bands));
      u.i("u_display", display);
      u.i("u_both", both ? 1 : 0);
      u.i("u_alternate", both && display == kLines ? 1 : 0);
      u.f("u_sign", side == kSideB ? -1.0f : 1.0f);
      u.f("u_height", float(kHeightScale * maxHeight));
      u.f("u_inside", component(inside, 0), component(inside, 1), component(inside, 2));
      u.f("u_outside", component(outside, 0), component(outside, 1), component(outside, 2));
      u.f("u_hue", float(hue));
      u.f("u_phase", float(phase));
      u.i("u_symmetry", symmetry ? 1 : 0);
      u.f("u_size", w, h);
      u.f("u_pad", float(pad));
      u.f("u_reach", float(edge + ramp / 2 + 1));
      u.f("u_scale", float(scale));
      u.f("u_edge", float(edge));
      u.f("u_ramp", float(ramp));
      u.f("u_colorRadius", float(colorRadius));
      u.f("u_colorShift", float((colorRadius - edge) / 2));
      u.i("u_reverse", blend ? 1 : 0);
      u.i("u_count", count);
    };
    draws.push_back(std::move(d));
  }
  FxScissor scissor;
  scissor.x = pad;
  scissor.y = pad;
  scissor.width = input.width;
  scissor.height = input.height;
  /** Blend Overlapping Colors composites each band over the later ones; otherwise the strongest wins. */
  ctx.draw(fx::capsule, *out, {bandData}, blend ? FxBlend::Over : FxBlend::Max, scissor, draws);
  ctx.release(bandData);
  return finish();
}

}  // namespace

FxRenderer audioSpectrumRenderer() { return render; }

}  // namespace aevk
