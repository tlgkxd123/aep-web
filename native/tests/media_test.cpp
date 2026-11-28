/** Sounds for Audio Spectrum: WAV decoding, finding a recorded file in the media folders, and the spectrum of a tone. */
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "check.h"
#include "media.h"
#include "spectrum.h"

namespace aevk {
namespace {

/** A mono 16-bit PCM WAV file of a `frequency` Hz sine at `rate` Hz, `seconds` long. */
std::vector<uint8_t> toneWav(double frequency, uint32_t rate, double seconds) {
  const uint32_t frames = uint32_t(rate * seconds);
  std::vector<uint8_t> out;
  const auto u32 = [&](uint32_t v) {
    for (int i = 0; i < 4; i++) out.push_back(uint8_t(v >> (8 * i)));
  };
  const auto u16 = [&](uint16_t v) {
    out.push_back(uint8_t(v));
    out.push_back(uint8_t(v >> 8));
  };
  const auto tag = [&](const char* t) { out.insert(out.end(), t, t + 4); };
  tag("RIFF");
  u32(36 + frames * 2);
  tag("WAVE");
  tag("fmt ");
  u32(16);
  u16(1);
  u16(1);
  u32(rate);
  u32(rate * 2);
  u16(2);
  u16(16);
  tag("data");
  u32(frames * 2);
  for (uint32_t i = 0; i < frames; i++) u16(uint16_t(int16_t(std::lround(16000 * std::sin(2 * M_PI * frequency * i / rate)))));
  return out;
}

}  // namespace

TEST(decodes_pcm_wav) {
  const std::vector<uint8_t> wav = toneWav(440, 8000, 0.5);
  AudioData audio;
  CHECK(decodeWav(wav.data(), wav.size(), audio));
  CHECK(audio.sampleRate == 8000);
  CHECK(audio.channels.size() == 1);
  CHECK(audio.length() == 4000);
  CHECK(std::fabs(audio.channels[0][2] - std::sin(2 * M_PI * 440 * 2 / 8000) * 16000 / 32768) < 1e-4);
  AudioData broken;
  CHECK(!decodeWav(wav.data(), 20, broken));
}

TEST(finds_recorded_media_by_trailing_folders) {
  namespace fs = std::filesystem;
  const fs::path root = fs::temp_directory_path() / "aevk-media-test";
  fs::remove_all(root);
  fs::create_directories(root / "a" / "sounds");
  fs::create_directories(root / "b" / "other");
  const std::vector<uint8_t> wav = toneWav(440, 8000, 0.1);
  for (const fs::path& p : {root / "a" / "sounds" / "Tone.wav", root / "b" / "other" / "tone.wav"}) {
    std::ofstream(p, std::ios::binary).write(reinterpret_cast<const char*>(wav.data()), std::streamsize(wav.size()));
  }
  MediaLibrary media;
  media.addFolder(root.string());
  /** A Windows path recorded on the author's machine: the file whose folders match more of it wins. */
  CHECK(fs::path(media.locate("C:\\Projects\\Sounds\\tone.WAV")) == root / "a" / "sounds" / "Tone.wav");
  CHECK(media.locate("/Users/me/missing.wav").empty());
  CHECK(media.audio("D:\\x\\sounds\\tone.wav") != nullptr);
  CHECK(media.audio("D:\\x\\sounds\\tone.wav") == media.audio("E:\\sounds\\TONE.wav"));
  fs::remove_all(root);
}

TEST(spectrum_peaks_at_the_tone) {
  const std::vector<uint8_t> wav = toneWav(1000, 44100, 1);
  AudioData data;
  CHECK(decodeWav(wav.data(), wav.size(), data));
  LayerAudio audio;
  audio.rate = data.sampleRate;
  audio.contributions.push_back({&data, 1, 0, -INFINITY, INFINITY});
  SpectrumSettings settings;
  settings.startFrequency = 20;
  settings.endFrequency = 2000;
  settings.bands = 64;
  const double length = windowLength(audio.rate, settings.durationMs);
  const std::vector<float> mags = analyse(mixWindow(audio, windowStart(0.5, audio.rate, length), size_t(length)), audio.rate, settings);
  CHECK(mags.size() == 64);
  size_t strongest = 0;
  for (size_t k = 1; k < mags.size(); k++)
    if (mags[k] > mags[strongest]) strongest = k;
  /** Bands run linearly from 20 Hz to 2000 Hz, so 1000 Hz is near the middle. */
  CHECK(strongest > 24 && strongest < 40);
  CHECK(mags[strongest] > 0);
  /** Past the sound's end there is only silence. */
  const std::vector<float> after = analyse(mixWindow(audio, windowStart(5, audio.rate, length), size_t(length)), audio.rate, settings);
  bool silent = true;
  for (float m : after) silent = silent && m == 0;
  CHECK(silent);
}

}  // namespace aevk
