// Video footage the engine decodes itself (src/media/video.ts): the picture a file shows at a time of its own, found
// as the web app finds it (the last presentation time at or before it) and kept as the decoder lays it out. On the
// desktop FFmpeg decodes it (with AEVK_HAVE_FFMPEG); without a decoder every file fails with the reason.
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace aevk {

/**
 * A decoded picture. Y'CbCr pictures keep their 8-bit planes (the footage shader converts them as After Effects does,
 * INTERPRET_FS); anything else is straight RGBA8, rows packed, top row first.
 */
struct VideoPicture {
  uint32_t width = 0, height = 0;
  bool yuv = false;
  /** Y'CbCr: the planes' offsets into `bytes` (Y, Cb, Cr; Cr unused when interleaved) and their row strides in bytes. */
  uint32_t offsets[3] = {}, strides[3] = {};
  uint32_t chromaWidth = 0, chromaHeight = 0;
  /** One interleaved CbCr plane (NV12) after Y, rather than two. */
  bool interleaved = false;
  /** Video range (16-235) rather than full range. */
  bool limitedRange = true;
  /**
   * The planes back to back (Y'CbCr), or the RGBA rows. Padded with zeros to a whole number of kVideoRowBytes, so the
   * bytes upload as one RGBA8 image kVideoRowBytes / 4 texels wide.
   */
  std::vector<uint8_t> bytes;
};

/** Bytes per row of the image Y'CbCr bytes upload as (4096 texels, the width every Vulkan device samples). */
constexpr uint32_t kVideoRowBytes = 16384;

/** One open video file, decoding forward from where it last stopped. */
class VideoReader {
 public:
  virtual ~VideoReader() = default;
  /** The picture shown at `seconds` of the file's own time (the last at or before it); null with `error` set when it fails. */
  virtual std::shared_ptr<const VideoPicture> pictureAt(double seconds, std::string& error) = 0;
  /** Bytes of decoded pictures the reader holds. */
  virtual size_t bytes() const = 0;
};

/** Whether this build decodes video at all (FFmpeg on the desktop, the system decoder on Android). */
bool canDecodeVideo();

/** Opens the video file at `path`; null with `error` set when it cannot be read or holds no video this build decodes. */
std::unique_ptr<VideoReader> openVideo(const std::string& path, std::string& error);

/**
 * A still image file the image decoder does not read (JPEG, WebP, a GIF's first frame) decoded by the video decoder:
 * straight RGBA8 rows, top row first. False with `error` set when it cannot (always, without a video decoder).
 */
bool decodeStill(const std::string& path, uint32_t& width, uint32_t& height, std::vector<uint8_t>& rgba, std::string& error);

/** The index of the last of `times` (ascending) at or before `time` + 1e-4, 0 before the first (indexAtTimes in video.ts). */
size_t indexAtTimes(const std::vector<double>& times, double time);

}  // namespace aevk
