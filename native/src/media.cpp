/** Footage read from disk (media.h): relinking, WAV decoding and the mix of a layer's sound. */
#include "media.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <system_error>

namespace aevk {
namespace {

/** Math.round: half up. */
double jsRound(double v) { return std::floor(v + 0.5); }

/** Path components, lowercased, without empty ones (split in store.ts). */
std::vector<std::string> split(const std::string& path) {
  std::vector<std::string> parts;
  std::string part;
  for (const char c : path) {
    if (c == '/' || c == '\\') {
      if (!part.empty()) parts.push_back(part);
      part.clear();
    } else {
      part.push_back(char(std::tolower(static_cast<unsigned char>(c))));
    }
  }
  if (!part.empty()) parts.push_back(part);
  return parts;
}

/** Reads `bytes` at `at` as an unsigned integer of `n` bytes in the file's byte order. */
uint64_t readUnsigned(const uint8_t* at, int n, bool little) {
  uint64_t v = 0;
  for (int i = 0; i < n; i++) v |= uint64_t(at[little ? i : n - 1 - i]) << (8 * i);
  return v;
}

constexpr uint32_t kWaveFormatPcm = 1;
constexpr uint32_t kWaveFormatFloat = 3;
constexpr uint32_t kWaveFormatExtensible = 0xfffe;

}  // namespace

bool decodeWav(const uint8_t* bytes, size_t size, AudioData& out) {
  if (size < 12) return false;
  const bool riff = std::memcmp(bytes, "RIFF", 4) == 0;
  if ((!riff && std::memcmp(bytes, "RIFX", 4) != 0) || std::memcmp(bytes + 8, "WAVE", 4) != 0) return false;
  const bool little = riff;
  uint32_t format = 0, channels = 0, rate = 0, bits = 0;
  size_t dataOffset = 0, dataSize = 0;
  bool hasData = false;
  for (size_t p = 12; p + 8 <= size;) {
    const uint32_t chunk = uint32_t(readUnsigned(bytes + p + 4, 4, little));
    const size_t body = p + 8;
    if (std::memcmp(bytes + p, "fmt ", 4) == 0 && chunk >= 16 && body + 16 <= size) {
      format = uint32_t(readUnsigned(bytes + body, 2, little));
      channels = uint32_t(readUnsigned(bytes + body + 2, 2, little));
      rate = uint32_t(readUnsigned(bytes + body + 4, 4, little));
      bits = uint32_t(readUnsigned(bytes + body + 14, 2, little));
      if (format == kWaveFormatExtensible && chunk >= 26 && body + 26 <= size) format = uint32_t(readUnsigned(bytes + body + 24, 2, little));
    } else if (std::memcmp(bytes + p, "data", 4) == 0) {
      dataOffset = body;
      dataSize = std::min<size_t>(chunk, size > body ? size - body : 0);
      hasData = true;
    }
    p = body + size_t(chunk) + (chunk & 1);
  }
  if (!hasData || !channels || !rate || bits % 8 != 0) return false;
  const bool isFloat = format == kWaveFormatFloat;
  if (!(format == kWaveFormatPcm && bits >= 8 && bits <= 32) && !(isFloat && (bits == 32 || bits == 64))) return false;
  const size_t bytesPerSample = bits / 8;
  const size_t frames = dataSize / (bytesPerSample * channels);
  out.sampleRate = rate;
  out.channels.assign(channels, std::vector<float>(frames));
  const uint8_t* at = bytes + dataOffset;
  for (size_t f = 0; f < frames; f++) {
    for (uint32_t c = 0; c < channels; c++, at += bytesPerSample) {
      double v;
      const uint64_t raw = readUnsigned(at, int(bytesPerSample), little);
      if (isFloat && bits == 32) {
        const uint32_t word = uint32_t(raw);
        float x;
        std::memcpy(&x, &word, 4);
        v = x;
      } else if (isFloat) {
        std::memcpy(&v, &raw, 8);
      } else if (bits == 8) {
        v = (double(raw) - 128) / 128;
      } else {
        /** Sign-extended from its width, then scaled so full scale is 1. */
        const int shift = 64 - int(bits);
        const int64_t s = int64_t(raw << shift) >> shift;
        v = double(s) / double(uint64_t(1) << (bits - 1));
      }
      out.channels[c][f] = float(v);
    }
  }
  return true;
}

void MediaLibrary::addFolder(const std::string& folder) {
  folders_.push_back(folder);
  indexed_ = false;
}

void MediaLibrary::index() {
  indexed_ = true;
  byName_.clear();
  std::vector<std::string> files;
  for (const std::string& folder : folders_) {
    std::error_code error;
    for (std::filesystem::recursive_directory_iterator it(folder, std::filesystem::directory_options::skip_permission_denied, error), end; !error && it != end;
         it.increment(error)) {
      if (it->is_regular_file(error)) files.push_back(it->path().string());
    }
  }
  /** Sorted, so that among equally good matches the same file is chosen every run. */
  std::sort(files.begin(), files.end());
  for (const std::string& file : files) {
    std::vector<std::string> parts = split(file);
    if (parts.empty()) continue;
    byName_[parts.back()].push_back({std::move(parts), file});
  }
}

std::string MediaLibrary::locate(const std::string& recorded) {
  if (!indexed_) index();
  const std::vector<std::string> parts = split(recorded);
  if (parts.empty()) return {};
  const auto candidates = byName_.find(parts.back());
  if (candidates == byName_.end()) return {};
  const std::string* best = nullptr;
  size_t bestScore = 0;
  for (const auto& file : candidates->second) {
    size_t score = 0;
    while (score < file.first.size() && score < parts.size() && file.first[file.first.size() - 1 - score] == parts[parts.size() - 1 - score]) score++;
    if (score > bestScore) {
      best = &file.second;
      bestScore = score;
    }
  }
  return best ? *best : std::string();
}

const AudioData* MediaLibrary::audio(const std::string& recorded) {
  const auto cached = audio_.find(recorded);
  if (cached != audio_.end()) return cached->second;
  const std::string path = locate(recorded);
  const AudioData* result = nullptr;
  if (!path.empty()) {
    auto found = decoded_.find(path);
    if (found == decoded_.end()) {
      std::ifstream in(path, std::ios::binary);
      const std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
      auto data = std::make_unique<AudioData>();
      if (!decodeWav(bytes.data(), bytes.size(), *data)) data.reset();
      found = decoded_.emplace(path, std::move(data)).first;
    }
    result = found->second.get();
  }
  audio_[recorded] = result;
  return result;
}

std::vector<float> mixWindow(const LayerAudio& audio, double first, size_t length) {
  std::vector<float> out(length, 0.0f);
  const double perSecond = audio.rate * audio.timeScale;
  for (const AudioContribution& c : audio.contributions) {
    const AudioData& data = *c.audio;
    const double rate = data.sampleRate;
    const size_t count = data.channels.size();
    if (!count) continue;
    const double gain = 1.0 / double(count);
    const double end = double(data.length());
    /** Source sample position of window sample i: p0 + i * step. */
    const double step = (c.scale * rate) / perSecond;
    const double p0 = (c.scale * (first / perSecond) + c.offset) * rate;
    const bool whole = std::fabs(step - 1) < 1e-9 && std::fabs(p0 - jsRound(p0)) < 1e-6;
    const double i0 = std::max(0.0, std::ceil(c.from * perSecond - first - 1e-9));
    const double i1 = std::min(double(length), std::ceil(c.to * perSecond - first - 1e-9));
    if (!(i0 < i1)) continue;
    if (whole && count <= 2) {
      /** The common case without the per-channel loop (the same sums: 0 + a = a exactly). */
      const float* a = data.channels[0].data();
      const float* b = count == 2 ? data.channels[1].data() : nullptr;
      const double base = jsRound(p0);
      const double lo = std::max(i0, -base);
      const double hi = std::min(i1, end - base);
      for (double i = lo; i < hi; i++) {
        const size_t k = size_t(base + i);
        const double sum = b ? double(a[k]) + double(b[k]) : double(a[k]);
        out[size_t(i)] = float(double(out[size_t(i)]) + sum * gain);
      }
      continue;
    }
    for (double i = i0; i < i1; i++) {
      double sum = 0;
      if (whole) {
        const double p = jsRound(p0) + i;
        if (p < 0 || p >= end) continue;
        for (const std::vector<float>& plane : data.channels) sum += plane[size_t(p)];
      } else {
        const double p = p0 + i * step;
        const double k = std::floor(p);
        if (k < 0 || k + 1 >= end) continue;
        const double f = p - k;
        for (const std::vector<float>& plane : data.channels) {
          const double x0 = plane[size_t(k)], x1 = plane[size_t(k) + 1];
          sum += x0 + (x1 - x0) * f;
        }
      }
      out[size_t(i)] = float(double(out[size_t(i)]) + sum * gain);
    }
  }
  return out;
}

}  // namespace aevk
