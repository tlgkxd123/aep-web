/** Video footage decoding (video.h): FFmpeg on the desktop, where the build has it; Android has video_android.cpp. */
#include "video.h"

#include <algorithm>
#include <cstring>
#include <list>

#ifdef AEVK_HAVE_FFMPEG
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/imgutils.h>
#include <libavutil/pixdesc.h>
#include <libswscale/swscale.h>
}
#endif

namespace aevk {

size_t indexAtTimes(const std::vector<double>& times, double time) {
  const double t = time + 1e-4;
  if (times.empty()) return 0;
  size_t lo = 0, hi = times.size() - 1;
  while (lo < hi) {
    const size_t mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t)
      lo = mid;
    else
      hi = mid - 1;
  }
  return lo;
}

namespace {

/** `bytes` grown with zeros to a whole number of kVideoRowBytes (at least one row). */
[[maybe_unused]] void padRows(std::vector<uint8_t>& bytes) {
  const size_t rows = std::max<size_t>(1, (bytes.size() + kVideoRowBytes - 1) / kVideoRowBytes);
  bytes.resize(rows * kVideoRowBytes, 0);
}

}  // namespace

#ifdef AEVK_HAVE_FFMPEG

namespace {

std::string ffError(int code) {
  char text[AV_ERROR_MAX_STRING_SIZE] = {};
  av_strerror(code, text, sizeof text);
  return text;
}

/** Pictures a reader keeps converted, for the requests that come back to them (time remapping, scrubbing). */
constexpr size_t kKeepPictures = 8;
/** How far ahead (seconds) a request may be for the decoder to carry on rather than seek to the key frame before it. */
constexpr double kForwardSeconds = 2.0;

class FfmpegReader final : public VideoReader {
 public:
  ~FfmpegReader() override {
    if (sws_) sws_freeContext(sws_);
    av_frame_free(&frame_);
    av_packet_free(&packet_);
    avcodec_free_context(&codec_);
    avformat_close_input(&format_);
  }

  bool open(const std::string& path, std::string& error) {
    int r = avformat_open_input(&format_, path.c_str(), nullptr, nullptr);
    if (r < 0) {
      error = "the file cannot be opened (" + ffError(r) + ")";
      return false;
    }
    if ((r = avformat_find_stream_info(format_, nullptr)) < 0) {
      error = "the file cannot be read (" + ffError(r) + ")";
      return false;
    }
    const AVCodec* decoder = nullptr;
    stream_ = av_find_best_stream(format_, AVMEDIA_TYPE_VIDEO, -1, -1, &decoder, 0);
    if (stream_ < 0 || !decoder) {
      error = stream_ == AVERROR_DECODER_NOT_FOUND ? "its video codec is not supported" : "it has no video";
      return false;
    }
    AVStream* stream = format_->streams[stream_];
    timeBase_ = av_q2d(stream->time_base);
    codec_ = avcodec_alloc_context3(decoder);
    if (!codec_ || avcodec_parameters_to_context(codec_, stream->codecpar) < 0) {
      error = "its video cannot be decoded";
      return false;
    }
    codec_->thread_count = 0;
    codec_->thread_type = FF_THREAD_FRAME | FF_THREAD_SLICE;
    if ((r = avcodec_open2(codec_, decoder, nullptr)) < 0) {
      error = "its video cannot be decoded (" + ffError(r) + ")";
      return false;
    }
    packet_ = av_packet_alloc();
    frame_ = av_frame_alloc();
    // Presentation order, as the web app's demuxer lists it: every sample's time, those before the first edit dropped.
    std::vector<int64_t> pts;
    while (av_read_frame(format_, packet_) >= 0) {
      if (packet_->stream_index == stream_) {
        const int64_t t = packet_->pts != AV_NOPTS_VALUE ? packet_->pts : packet_->dts;
        if (t != AV_NOPTS_VALUE && double(t) * timeBase_ >= -1e-9) pts.push_back(t);
      }
      av_packet_unref(packet_);
    }
    std::sort(pts.begin(), pts.end());
    pts.erase(std::unique(pts.begin(), pts.end()), pts.end());
    if (pts.empty()) {
      error = "it has no video frames";
      return false;
    }
    pts_ = pts;
    for (const int64_t t : pts_) times_.push_back(double(t) * timeBase_);
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
    if (!(valid_ && last_ != AV_NOPTS_VALUE && last_ < target && double(target - last_) * timeBase_ <= kForwardSeconds)) restart(target);
    AVFrame* best = nullptr;
    std::shared_ptr<const VideoPicture> picture;
    for (;;) {
      int r = avcodec_receive_frame(codec_, frame_);
      if (r == 0) {
        const int64_t t = frame_->best_effort_timestamp != AV_NOPTS_VALUE ? frame_->best_effort_timestamp : frame_->pts;
        last_ = t;
        if (t == target) {
          picture = convert(frame_, error);
          av_frame_unref(frame_);
          break;
        }
        if (t != AV_NOPTS_VALUE && t > target) {
          // The picture listed for this time never came out: the one before it shows, else this one.
          picture = convert(best ? best : frame_, error);
          av_frame_unref(frame_);
          break;
        }
        if (!best) best = av_frame_alloc();
        av_frame_unref(best);
        av_frame_move_ref(best, frame_);
        continue;
      }
      if (r == AVERROR(EAGAIN)) {
        if (draining_) break;
        r = av_read_frame(format_, packet_);
        if (r < 0) {
          draining_ = true;
          avcodec_send_packet(codec_, nullptr);
          continue;
        }
        if (packet_->stream_index == stream_) avcodec_send_packet(codec_, packet_);
        av_packet_unref(packet_);
        continue;
      }
      // The end of the stream (or a failure): what was decoded last before the time shows.
      valid_ = false;
      if (best) picture = convert(best, error);
      break;
    }
    if (best) av_frame_free(&best);
    if (!picture) {
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
  /** Seeks to the key frame at or before `target` and empties the decoder. */
  void restart(int64_t target) {
    av_seek_frame(format_, stream_, target, AVSEEK_FLAG_BACKWARD);
    avcodec_flush_buffers(codec_);
    last_ = AV_NOPTS_VALUE;
    draining_ = false;
    valid_ = true;
  }

  std::shared_ptr<const VideoPicture> convert(const AVFrame* f, std::string& error) {
    auto out = std::make_shared<VideoPicture>();
    const uint32_t w = uint32_t(f->width), h = uint32_t(f->height);
    out->width = w;
    out->height = h;
    const AVPixelFormat format = AVPixelFormat(f->format);
    int xShift = -1, yShift = 0;
    bool full = f->color_range == AVCOL_RANGE_JPEG;
    switch (format) {
      case AV_PIX_FMT_YUVJ420P: full = true; [[fallthrough]];
      case AV_PIX_FMT_YUV420P: xShift = 1; yShift = 1; break;
      case AV_PIX_FMT_YUVJ422P: full = true; [[fallthrough]];
      case AV_PIX_FMT_YUV422P: xShift = 1; yShift = 0; break;
      case AV_PIX_FMT_YUVJ444P: full = true; [[fallthrough]];
      case AV_PIX_FMT_YUV444P: xShift = 0; yShift = 0; break;
      case AV_PIX_FMT_NV12: xShift = 1; yShift = 1; out->interleaved = true; break;
      default: break;
    }
    if (xShift >= 0) {
      // The planes stay as decoded, rows packed: the footage shader converts them.
      out->yuv = true;
      out->limitedRange = !full;
      const uint32_t cw = (w + uint32_t(xShift)) >> xShift, ch = (h + uint32_t(yShift)) >> yShift;
      out->chromaWidth = cw;
      out->chromaHeight = ch;
      const int planes = out->interleaved ? 2 : 3;
      const uint32_t widths[3] = {w, out->interleaved ? 2 * cw : cw, cw};
      const uint32_t heights[3] = {h, ch, ch};
      size_t total = 0;
      for (int i = 0; i < planes; i++) total += size_t(widths[i]) * heights[i];
      out->bytes.resize(total);
      size_t at = 0;
      for (int i = 0; i < planes; i++) {
        out->offsets[i] = uint32_t(at);
        out->strides[i] = widths[i];
        for (uint32_t y = 0; y < heights[i]; y++, at += widths[i]) std::memcpy(out->bytes.data() + at, f->data[i] + ptrdiff_t(y) * f->linesize[i], widths[i]);
      }
      padRows(out->bytes);
      return out;
    }
    // Anything else (10-bit, RGB, alpha) through swscale to straight RGBA, with After Effects' matrix.
    sws_ = sws_getCachedContext(sws_, int(w), int(h), format, int(w), int(h), AV_PIX_FMT_RGBA,
                                SWS_BILINEAR | SWS_ACCURATE_RND | SWS_FULL_CHR_H_INT | SWS_FULL_CHR_H_INP, nullptr, nullptr, nullptr);
    if (!sws_) {
      error = std::string("its pixel format ") + (av_get_pix_fmt_name(format) ? av_get_pix_fmt_name(format) : "?") + " cannot be converted";
      return nullptr;
    }
    const AVPixFmtDescriptor* desc = av_pix_fmt_desc_get(format);
    if (desc && !(desc->flags & AV_PIX_FMT_FLAG_RGB)) {
      const int* matrix = sws_getCoefficients(h > 576 ? SWS_CS_ITU709 : SWS_CS_ITU601);
      sws_setColorspaceDetails(sws_, matrix, full ? 1 : 0, sws_getCoefficients(SWS_CS_DEFAULT), 1, 0, 1 << 16, 1 << 16);
    }
    out->bytes.resize(size_t(w) * h * 4);
    uint8_t* dst[4] = {out->bytes.data(), nullptr, nullptr, nullptr};
    const int dstStride[4] = {int(w * 4), 0, 0, 0};
    sws_scale(sws_, f->data, f->linesize, 0, int(h), dst, dstStride);
    padRows(out->bytes);
    return out;
  }

  AVFormatContext* format_ = nullptr;
  AVCodecContext* codec_ = nullptr;
  AVPacket* packet_ = nullptr;
  AVFrame* frame_ = nullptr;
  SwsContext* sws_ = nullptr;
  int stream_ = -1;
  double timeBase_ = 0;
  std::vector<int64_t> pts_;
  std::vector<double> times_;
  /** The decoder's last output, and whether it can carry on from there (false after the end or a failure). */
  int64_t last_ = AV_NOPTS_VALUE;
  bool draining_ = false, valid_ = false;
  std::list<std::pair<size_t, std::shared_ptr<const VideoPicture>>> kept_;
  size_t bytes_ = 0;
};

}  // namespace

bool canDecodeVideo() { return true; }

std::unique_ptr<VideoReader> openVideo(const std::string& path, std::string& error) {
  auto reader = std::make_unique<FfmpegReader>();
  if (!reader->open(path, error)) return nullptr;
  return reader;
}

bool decodeStill(const std::string& path, uint32_t& width, uint32_t& height, std::vector<uint8_t>& rgba, std::string& error) {
  AVFormatContext* format = nullptr;
  int code = avformat_open_input(&format, path.c_str(), nullptr, nullptr);
  if (code < 0) {
    error = "the file cannot be opened: " + ffError(code);
    return false;
  }
  AVCodecContext* codec = nullptr;
  AVPacket* packet = av_packet_alloc();
  AVFrame* frame = av_frame_alloc();
  bool decoded = false;
  const auto finish = [&](bool ok) {
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&codec);
    avformat_close_input(&format);
    return ok;
  };
  if (avformat_find_stream_info(format, nullptr) < 0) {
    error = "the file holds no picture";
    return finish(false);
  }
  const AVCodec* decoder = nullptr;
  const int stream = av_find_best_stream(format, AVMEDIA_TYPE_VIDEO, -1, -1, &decoder, 0);
  if (stream < 0 || !decoder) {
    error = "the file holds no picture this build decodes";
    return finish(false);
  }
  codec = avcodec_alloc_context3(decoder);
  if (!codec || avcodec_parameters_to_context(codec, format->streams[stream]->codecpar) < 0 || avcodec_open2(codec, decoder, nullptr) < 0) {
    error = "the picture's decoder cannot be opened";
    return finish(false);
  }
  /** Packets until the first picture, then the decoder flushed for a picture it holds back. */
  bool flushed = false;
  while (!decoded) {
    if (!flushed) {
      code = av_read_frame(format, packet);
      if (code < 0) {
        avcodec_send_packet(codec, nullptr);
        flushed = true;
      } else {
        if (packet->stream_index == stream) avcodec_send_packet(codec, packet);
        av_packet_unref(packet);
      }
    }
    code = avcodec_receive_frame(codec, frame);
    if (code == 0) decoded = true;
    else if (flushed && code != AVERROR(EAGAIN)) break;
  }
  if (!decoded) {
    error = "the file's picture cannot be decoded";
    return finish(false);
  }
  width = uint32_t(frame->width);
  height = uint32_t(frame->height);
  AVPixelFormat pixels = AVPixelFormat(frame->format);
  /** JPEG's full-range Y'CbCr, as browsers decode it. */
  bool full = codec->color_range == AVCOL_RANGE_JPEG;
  switch (pixels) {
    case AV_PIX_FMT_YUVJ420P: pixels = AV_PIX_FMT_YUV420P; full = true; break;
    case AV_PIX_FMT_YUVJ422P: pixels = AV_PIX_FMT_YUV422P; full = true; break;
    case AV_PIX_FMT_YUVJ444P: pixels = AV_PIX_FMT_YUV444P; full = true; break;
    case AV_PIX_FMT_YUVJ440P: pixels = AV_PIX_FMT_YUV440P; full = true; break;
    default: break;
  }
  SwsContext* sws = sws_getContext(int(width), int(height), pixels, int(width), int(height), AV_PIX_FMT_RGBA, SWS_BILINEAR | SWS_ACCURATE_RND | SWS_FULL_CHR_H_INT, nullptr, nullptr, nullptr);
  if (!sws) {
    error = "the picture's pixel format cannot be converted";
    return finish(false);
  }
  const AVPixFmtDescriptor* desc = av_pix_fmt_desc_get(pixels);
  if (desc && !(desc->flags & AV_PIX_FMT_FLAG_RGB))
    sws_setColorspaceDetails(sws, sws_getCoefficients(SWS_CS_ITU601), full ? 1 : 0, sws_getCoefficients(SWS_CS_DEFAULT), 1, 0, 1 << 16, 1 << 16);
  rgba.assign(size_t(width) * height * 4, 0);
  uint8_t* dst[4] = {rgba.data(), nullptr, nullptr, nullptr};
  int dstStride[4] = {int(width * 4), 0, 0, 0};
  sws_scale(sws, frame->data, frame->linesize, 0, int(height), dst, dstStride);
  sws_freeContext(sws);
  return finish(true);
}

#elif !defined(__ANDROID__)

bool canDecodeVideo() { return false; }

std::unique_ptr<VideoReader> openVideo(const std::string&, std::string& error) {
  error = "this build has no video decoder";
  return nullptr;
}

bool decodeStill(const std::string&, uint32_t&, uint32_t&, std::vector<uint8_t>&, std::string& error) {
  error = "this build decodes PNG, BMP and TIFF stills only";
  return false;
}

#endif

}  // namespace aevk
