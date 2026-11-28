/**
 * Footage the engine reads from disk itself (src/media/store.ts, audio.ts and mixWindow.ts): files found in the media
 * folders it is given, matched to the paths a project records the way After Effects relinks them, and the sound of
 * the layers effects listen to.
 */
#pragma once
#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "plan.h"

namespace aevk {

/** Decoded sound at its own rate, a plane of samples per channel (AudioData in src/media/audio.ts). */
struct AudioData {
  double sampleRate = 0;
  std::vector<std::vector<float>> channels;
  size_t length() const { return channels.empty() ? 0 : channels[0].size(); }
};

/** An uncompressed RIFF/RIFX WAVE file (8 to 32-bit integer, 32 or 64-bit float PCM); false for anything else (decodeWav). */
bool decodeWav(const uint8_t* bytes, size_t size, AudioData& out);

/** The files under some folders, found by the paths a project records for its footage. */
class MediaLibrary {
 public:
  /** Adds the files under `folder` (searched when a file is first looked for). */
  void addFolder(const std::string& folder);
  /** The file best matching `recorded`: the most trailing path components in common, case aside, the file name at least; empty when none. */
  std::string locate(const std::string& recorded);
  /** The decoded sound of the file `recorded` names, cached; null when it is not found or not a sound the engine decodes. */
  const AudioData* audio(const std::string& recorded);

 private:
  void index();
  std::vector<std::string> folders_;
  bool indexed_ = false;
  /** Files by their lowercased name, each as its lowercased path components and its path. */
  std::map<std::string, std::vector<std::pair<std::vector<std::string>, std::string>>> byName_;
  /** By the name a plan recorded, and the sounds decoded by the file found (several names can find one file). */
  std::map<std::string, const AudioData*> audio_;
  std::map<std::string, std::unique_ptr<AudioData>> decoded_;
};

/** One decoded sound heard in a layer's mix: source seconds = scale * t + offset for t in [from, to) (Contribution). */
struct AudioContribution {
  const AudioData* audio = nullptr;
  double scale = 1, offset = 0, from = 0, to = 0;
};

/** A layer's sound as effects hear it (LayerAudio in src/media/mixWindow.ts). */
struct LayerAudio {
  /** The first source's rate, in samples per second of its own time. */
  double rate = 0;
  /** Source seconds per layer second of the first source; windows hold rate * timeScale samples per layer second. */
  double timeScale = 1;
  std::vector<AudioContribution> contributions;
};

/**
 * `length` samples of the mono mix from sample `first` of the layer's timeline, which has rate * timeScale samples
 * per layer second (mixWindow).
 */
std::vector<float> mixWindow(const LayerAudio& audio, double first, size_t length);

}  // namespace aevk
