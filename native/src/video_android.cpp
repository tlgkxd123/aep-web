/**
 * Video footage decoding on Android (video.h): the system's decoders through the NDK. AMediaExtractor reads the file,
 * AMediaCodec decodes it (in hardware where the phone has it) into an AImageReader, whose Y'CbCr planes are kept as
 * the desktop's FFmpeg reader keeps them, so the footage shader converts them the same way. Stills the image decoder
 * does not read (JPEG, WebP, HEIF, a GIF's first frame) go through AImageDecoder (Android 11 and later).
 */
#ifdef __ANDROID__

#include "video.h"

#include <android/log.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <media/NdkImage.h>
#include <media/NdkImageReader.h>
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaExtractor.h>
#include <media/NdkMediaFormat.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstring>
#include <list>
#include <mutex>
#include <type_traits>

/** AImageDecoder (android/imagedecoder.h, API 30), reached through dlsym so the app still starts on older phones. */
struct AImageDecoder;
struct AImageDecoderHeaderInfo;

namespace aevk {

namespace {

/** Pictures a reader keeps, for the requests that come back to them (time remapping, scrubbing). */
constexpr size_t kKeepPictures = 8;
/** How far ahead (microseconds) a request may be for the decoder to carry on rather than seek to the key frame before it. */
constexpr int64_t kForwardUs = 2000000;
/** How long one picture may take to come out of the decoder before the request fails. */
constexpr auto kPictureTimeout = std::chrono::seconds(5);
constexpr int64_t kNoTime = INT64_MIN;
/** MediaFormat's KEY_COLOR_RANGE values. */
constexpr int32_t kColorRangeFull = 1;

/** `bytes` grown with zeros to a whole number of kVideoRowBytes (at least one row). */
void padRows(std::vector<uint8_t>& bytes) {
  const size_t rows = std::max<size_t>(1, (bytes.size() + kVideoRowBytes - 1) / kVideoRowBytes);
  bytes.resize(rows * kVideoRowBytes, 0);
}

/** An open file descriptor, closed when it goes. */
struct File {
  int fd = -1;
  off64_t size = 0;
  explicit File(const std::string& path) {
    fd = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
    struct stat st {};
    if (fd >= 0 && fstat(fd, &st) == 0) size = st.st_size;
  }
  ~File() {
    if (fd >= 0) ::close(fd);
  }
  File(const File&) = delete;
  File& operator=(const File&) = delete;
};

class AndroidReader final : public VideoReader {
 public:
  ~AndroidReader() override {
    if (codec_) {
      AMediaCodec_stop(codec_);
      AMediaCodec_delete(codec_);
    }
    if (reader_) AImageReader_delete(reader_);
    if (extractor_) AMediaExtractor_delete(extractor_);
    if (fd_ >= 0) ::close(fd_);
  }

  bool open(const std::string& path, std::string& error) {
    File file(path);
    if (file.fd < 0) {
      error = "the file cannot be opened";
      return false;
    }
    extractor_ = AMediaExtractor_new();
    if (!extractor_ || AMediaExtractor_setDataSourceFd(extractor_, file.fd, 0, file.size) != AMEDIA_OK) {
      error = "the file cannot be read";
      return false;
    }
    /** The extractor reads from the descriptor while it decodes: it stays open with the reader. */
    fd_ = file.fd;
    file.fd = -1;
    AMediaFormat* format = nullptr;
    const char* mime = nullptr;
    const size_t tracks = AMediaExtractor_getTrackCount(extractor_);
    for (size_t i = 0; i < tracks && track_ < 0; i++) {
      AMediaFormat* candidate = AMediaExtractor_getTrackFormat(extractor_, i);
      const char* kind = nullptr;
      if (candidate && AMediaFormat_getString(candidate, AMEDIAFORMAT_KEY_MIME, &kind) && kind && std::strncmp(kind, "video/", 6) == 0) {
        track_ = int(i);
        format = candidate;
        mime = kind;
      } else if (candidate) {
        AMediaFormat_delete(candidate);
      }
    }
    if (track_ < 0) {
      error = "it has no video";
      return false;
    }
    int32_t width = 0, height = 0;
    AMediaFormat_getInt32(format, AMEDIAFORMAT_KEY_WIDTH, &width);
    AMediaFormat_getInt32(format, AMEDIAFORMAT_KEY_HEIGHT, &height);
    int32_t range = 0;
    if (AMediaFormat_getInt32(format, "color-range", &range)) full_ = range == kColorRangeFull;
    const std::string kind = mime;
    AMediaExtractor_selectTrack(extractor_, size_t(track_));

    // Presentation order, as the web app's demuxer lists it: every sample's time, those before the first edit dropped.
    for (;;) {
      const int64_t t = AMediaExtractor_getSampleTime(extractor_);
      if (t < 0) break;
      pts_.push_back(t);
      if (!AMediaExtractor_advance(extractor_)) break;
    }
    std::sort(pts_.begin(), pts_.end());
    pts_.erase(std::unique(pts_.begin(), pts_.end()), pts_.end());
    if (pts_.empty() || width <= 0 || height <= 0) {
      AMediaFormat_delete(format);
      error = "it has no video frames";
      return false;
    }
    for (const int64_t t : pts_) times_.push_back(double(t) / 1e6);

    if (AImageReader_new(width, height, AIMAGE_FORMAT_YUV_420_888, 3, &reader_) != AMEDIA_OK) {
      AMediaFormat_delete(format);
      error = "its pictures cannot be read back from the decoder";
      return false;
    }
    listener_.context = this;
    listener_.onImageAvailable = [](void* context, AImageReader*) {
      auto* self = static_cast<AndroidReader*>(context);
      std::lock_guard<std::mutex> lock(self->lock_);
      self->available_++;
      self->arrived_.notify_all();
    };
    AImageReader_setImageListener(reader_, &listener_);
    ANativeWindow* window = nullptr;
    AImageReader_getWindow(reader_, &window);
    codec_ = AMediaCodec_createDecoderByType(kind.c_str());
    if (!codec_) {
      AMediaFormat_delete(format);
      error = "its video codec (" + kind + ") is not supported on this device";
      return false;
    }
    const media_status_t configured = AMediaCodec_configure(codec_, format, window, nullptr, 0);
    AMediaFormat_delete(format);
    if (configured != AMEDIA_OK || AMediaCodec_start(codec_) != AMEDIA_OK) {
      error = "its video cannot be decoded on this device (" + kind + ")";
      return false;
    }
    restart(pts_.front());
    return true;
  }

  std::shared_ptr<const VideoPicture> pictureAt(double seconds, std::string& error) override {
    const size_t index = indexAtTimes(times_, seconds);
    for (auto it = kept_.begin(); it != kept_.end(); ++it) {
      if (it->first == index) {
        kept_.splice(kept_.begin(), kept_, it);
        return kept_.front().second;
      }
    }
    const int64_t target = pts_[index];
    // Forward and near: carry on decoding. Otherwise start again from the key frame at or before it.
    if (!(valid_ && last_ != kNoTime && last_ < target && target - last_ <= kForwardUs)) restart(target);
    std::shared_ptr<const VideoPicture> picture;
    const auto deadline = std::chrono::steady_clock::now() + kPictureTimeout;
    while (!picture && std::chrono::steady_clock::now() < deadline) {
      feed();
      AMediaCodecBufferInfo info{};
      const ssize_t out = AMediaCodec_dequeueOutputBuffer(codec_, &info, 5000);
      if (out == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {
        if (AMediaFormat* format = AMediaCodec_getOutputFormat(codec_)) {
          int32_t range = 0;
          if (AMediaFormat_getInt32(format, "color-range", &range)) full_ = range == kColorRangeFull;
          AMediaFormat_delete(format);
        }
        continue;
      }
      if (out < 0) {
        if (outputEnded_) break;
        continue;
      }
      if (info.flags & AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM) outputEnded_ = true;
      const int64_t t = info.presentationTimeUs;
      if (info.size <= 0 && outputEnded_) {
        AMediaCodec_releaseOutputBuffer(codec_, size_t(out), false);
        break;
      }
      last_ = t;
      if (t < target) {
        /** Not shown: only the picture asked for is drawn into the image reader and read back. */
        AMediaCodec_releaseOutputBuffer(codec_, size_t(out), false);
        continue;
      }
      // The picture listed for this time, or the next when it never came out (FFmpeg shows the one before then).
      AMediaCodec_releaseOutputBuffer(codec_, size_t(out), true);
      picture = take(t, error);
      if (!picture) break;
    }
    if (outputEnded_) valid_ = false;
    if (!picture) {
      valid_ = false;
      if (error.empty()) error = "the frame at " + std::to_string(seconds) + " s cannot be decoded";
      return nullptr;
    }
    kept_.emplace_front(index, picture);
    bytes_ += picture->bytes.size();
    while (kept_.size() > kKeepPictures) {
      bytes_ -= kept_.back().second->bytes.size();
      kept_.pop_back();
    }
    return picture;
  }

  size_t bytes() const override { return bytes_; }

 private:
  /** Hands the decoder the samples it has room for, then the end of the stream. */
  void feed() {
    while (!inputEnded_) {
      const ssize_t in = AMediaCodec_dequeueInputBuffer(codec_, 0);
      if (in < 0) return;
      size_t capacity = 0;
      uint8_t* buffer = AMediaCodec_getInputBuffer(codec_, size_t(in), &capacity);
      const ssize_t size = buffer ? AMediaExtractor_readSampleData(extractor_, buffer, capacity) : -1;
      if (size < 0) {
        AMediaCodec_queueInputBuffer(codec_, size_t(in), 0, 0, 0, AMEDIACODEC_BUFFER_FLAG_END_OF_STREAM);
        inputEnded_ = true;
        return;
      }
      const int64_t t = AMediaExtractor_getSampleTime(extractor_);
      AMediaCodec_queueInputBuffer(codec_, size_t(in), 0, size_t(size), uint64_t(std::max<int64_t>(0, t)), 0);
      AMediaExtractor_advance(extractor_);
    }
  }

  /** Seeks to the key frame at or before `target` and empties the decoder and the image reader. */
  void restart(int64_t target) {
    AMediaExtractor_seekTo(extractor_, target, AMEDIAEXTRACTOR_SEEK_PREVIOUS_SYNC);
    AMediaCodec_flush(codec_);
    drain();
    last_ = kNoTime;
    inputEnded_ = outputEnded_ = false;
    valid_ = true;
  }

  /** Drops the pictures waiting in the image reader. */
  void drain() {
    AImage* image = nullptr;
    while (AImageReader_acquireNextImage(reader_, &image) == AMEDIA_OK && image) {
      AImage_delete(image);
      image = nullptr;
    }
    std::lock_guard<std::mutex> lock(lock_);
    available_ = 0;
  }

  /** The picture the decoder drew into the image reader for presentation time `t` (microseconds). */
  std::shared_ptr<const VideoPicture> take(int64_t t, std::string& error) {
    const auto deadline = std::chrono::steady_clock::now() + kPictureTimeout;
    for (;;) {
      AImage* image = nullptr;
      if (AImageReader_acquireNextImage(reader_, &image) == AMEDIA_OK && image) {
        int64_t ns = 0;
        AImage_getTimestamp(image, &ns);
        /** Rendered buffers carry their presentation time in nanoseconds; an earlier one left behind is dropped. */
        if (ns / 1000 >= t) {
          auto picture = convert(image, error);
          AImage_delete(image);
          return picture;
        }
        AImage_delete(image);
        continue;
      }
      std::unique_lock<std::mutex> lock(lock_);
      if (std::chrono::steady_clock::now() >= deadline) {
        error = "the decoder did not hand back its picture";
        return nullptr;
      }
      arrived_.wait_for(lock, std::chrono::milliseconds(20), [&] { return available_ > 0; });
      available_ = 0;
    }
  }

  /** The image's visible Y'CbCr planes, rows packed, as FfmpegReader::convert lays them out. */
  std::shared_ptr<const VideoPicture> convert(AImage* image, std::string& error) {
    AImageCropRect crop{};
    int32_t imageWidth = 0, imageHeight = 0;
    AImage_getWidth(image, &imageWidth);
    AImage_getHeight(image, &imageHeight);
    if (AImage_getCropRect(image, &crop) != AMEDIA_OK || crop.right <= crop.left || crop.bottom <= crop.top) crop = {0, 0, imageWidth, imageHeight};
    /** Chroma is sampled on even pixels: the crop starts on one. */
    const int32_t left = crop.left & ~1, top = crop.top & ~1;
    const uint32_t w = uint32_t(crop.right - left), h = uint32_t(crop.bottom - top);
    uint8_t* planes[3] = {};
    int lengths[3] = {};
    int32_t rowStrides[3] = {}, pixelStrides[3] = {};
    for (int i = 0; i < 3; i++) {
      if (AImage_getPlaneData(image, i, &planes[i], &lengths[i]) != AMEDIA_OK || !planes[i] ||
          AImage_getPlaneRowStride(image, i, &rowStrides[i]) != AMEDIA_OK || AImage_getPlanePixelStride(image, i, &pixelStrides[i]) != AMEDIA_OK) {
        error = "the decoder's picture cannot be read";
        return nullptr;
      }
    }
    auto out = std::make_shared<VideoPicture>();
    out->width = w;
    out->height = h;
    out->yuv = true;
    out->limitedRange = !full_;
    const uint32_t cw = (w + 1) >> 1, ch = (h + 1) >> 1;
    out->chromaWidth = cw;
    out->chromaHeight = ch;
    const int32_t cs = pixelStrides[1];
    /** NV12 as decoders usually give it: one CbCr plane, Cr a byte after Cb. */
    out->interleaved = cs == 2 && pixelStrides[2] == 2 && planes[2] == planes[1] + 1 && rowStrides[1] == rowStrides[2];
    const int count = out->interleaved ? 2 : 3;
    const uint32_t widths[3] = {w, out->interleaved ? 2 * cw : cw, cw};
    const uint32_t heights[3] = {h, ch, ch};
    size_t total = 0;
    for (int i = 0; i < count; i++) total += size_t(widths[i]) * heights[i];
    out->bytes.resize(total);
    size_t at = 0;
    for (int i = 0; i < count; i++) {
      out->offsets[i] = uint32_t(at);
      out->strides[i] = widths[i];
      const int32_t x0 = i == 0 ? left : left / 2, y0 = i == 0 ? top : top / 2;
      const int32_t step = pixelStrides[i];
      for (uint32_t y = 0; y < heights[i]; y++, at += widths[i]) {
        const uint8_t* row = planes[i] + ptrdiff_t(y0 + int32_t(y)) * rowStrides[i] + ptrdiff_t(x0) * step;
        uint8_t* dst = out->bytes.data() + at;
        if (step == 1 || (i == 1 && out->interleaved)) {
          std::memcpy(dst, row, widths[i]);
        } else {
          for (uint32_t x = 0; x < widths[i]; x++) dst[x] = row[ptrdiff_t(x) * step];
        }
      }
    }
    padRows(out->bytes);
    return out;
  }

  int fd_ = -1;
  AMediaExtractor* extractor_ = nullptr;
  AMediaCodec* codec_ = nullptr;
  AImageReader* reader_ = nullptr;
  AImageReader_ImageListener listener_{};
  std::mutex lock_;
  std::condition_variable arrived_;
  int available_ = 0;
  int track_ = -1;
  bool full_ = false;
  std::vector<int64_t> pts_;
  std::vector<double> times_;
  /** The decoder's last output, and whether it can carry on from there (false after the end or a failure). */
  int64_t last_ = kNoTime;
  bool inputEnded_ = false, outputEnded_ = false, valid_ = false;
  std::list<std::pair<size_t, std::shared_ptr<const VideoPicture>>> kept_;
  size_t bytes_ = 0;
};

/** AImageDecoder's functions, found once in libjnigraphics.so; all null before Android 11. */
struct ImageDecoderApi {
  int (*createFromFd)(int, AImageDecoder**) = nullptr;
  const AImageDecoderHeaderInfo* (*headerInfo)(const AImageDecoder*) = nullptr;
  int32_t (*width)(const AImageDecoderHeaderInfo*) = nullptr;
  int32_t (*height)(const AImageDecoderHeaderInfo*) = nullptr;
  int (*setFormat)(AImageDecoder*, int32_t) = nullptr;
  int (*setUnpremultiplied)(AImageDecoder*, bool) = nullptr;
  size_t (*minimumStride)(AImageDecoder*) = nullptr;
  int (*decode)(AImageDecoder*, void*, size_t, size_t) = nullptr;
  void (*destroy)(AImageDecoder*) = nullptr;

  bool ready() const { return createFromFd && headerInfo && width && height && setFormat && setUnpremultiplied && minimumStride && decode && destroy; }

  static const ImageDecoderApi& get() {
    static const ImageDecoderApi api = [] {
      ImageDecoderApi a;
      void* lib = dlopen("libjnigraphics.so", RTLD_NOW | RTLD_LOCAL);
      if (!lib) return a;
      const auto find = [&](auto& fn, const char* name) { fn = reinterpret_cast<std::remove_reference_t<decltype(fn)>>(dlsym(lib, name)); };
      find(a.createFromFd, "AImageDecoder_createFromFd");
      find(a.headerInfo, "AImageDecoder_getHeaderInfo");
      find(a.width, "AImageDecoderHeaderInfo_getWidth");
      find(a.height, "AImageDecoderHeaderInfo_getHeight");
      find(a.setFormat, "AImageDecoder_setAndroidBitmapFormat");
      find(a.setUnpremultiplied, "AImageDecoder_setUnpremultipliedRequired");
      find(a.minimumStride, "AImageDecoder_getMinimumStride");
      find(a.decode, "AImageDecoder_decodeImage");
      find(a.destroy, "AImageDecoder_delete");
      return a;
    }();
    return api;
  }
};

/** ANDROID_BITMAP_FORMAT_RGBA_8888 and ANDROID_IMAGE_DECODER_SUCCESS. */
constexpr int32_t kBitmapRgba8888 = 1;
constexpr int kDecoderSuccess = 0;

}  // namespace

bool canDecodeVideo() { return true; }

std::unique_ptr<VideoReader> openVideo(const std::string& path, std::string& error) {
  auto reader = std::make_unique<AndroidReader>();
  if (!reader->open(path, error)) return nullptr;
  return reader;
}

bool decodeStill(const std::string& path, uint32_t& width, uint32_t& height, std::vector<uint8_t>& rgba, std::string& error) {
  const ImageDecoderApi& api = ImageDecoderApi::get();
  if (!api.ready()) {
    error = "JPEG, WebP and HEIF stills need Android 11 or later";
    return false;
  }
  File file(path);
  if (file.fd < 0) {
    error = "the file cannot be opened";
    return false;
  }
  AImageDecoder* decoder = nullptr;
  if (api.createFromFd(file.fd, &decoder) != kDecoderSuccess || !decoder) {
    error = "the file is not a picture this device decodes";
    return false;
  }
  const AImageDecoderHeaderInfo* info = api.headerInfo(decoder);
  const int32_t w = info ? api.width(info) : 0, h = info ? api.height(info) : 0;
  /** Straight RGBA, as browsers hand decoded pictures to WebGL. */
  if (w <= 0 || h <= 0 || api.setFormat(decoder, kBitmapRgba8888) != kDecoderSuccess || api.setUnpremultiplied(decoder, true) != kDecoderSuccess) {
    api.destroy(decoder);
    error = "the picture cannot be decoded as RGBA";
    return false;
  }
  const size_t stride = std::max(api.minimumStride(decoder), size_t(w) * 4);
  std::vector<uint8_t> pixels(stride * size_t(h));
  const int decoded = api.decode(decoder, pixels.data(), stride, pixels.size());
  api.destroy(decoder);
  if (decoded != kDecoderSuccess) {
    error = "the picture cannot be decoded";
    return false;
  }
  width = uint32_t(w);
  height = uint32_t(h);
  rgba.resize(size_t(w) * h * 4);
  for (int32_t y = 0; y < h; y++) std::memcpy(rgba.data() + size_t(y) * w * 4, pixels.data() + size_t(y) * stride, size_t(w) * 4);
  return true;
}

}  // namespace aevk

#endif
