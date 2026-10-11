// Playback on the native engine: the Preview panel's timing (src/playback/usePlayback.ts), the RAM preview cache
// (src/playback/frameCache.ts) holding frames on the GPU, and a player that renders the frames the app hands it
// plans for ahead of the playhead and shows them.
#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <list>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "engine.h"
#include "plan.h"

namespace aevk {

// --- timing (usePlayback.ts) -------------------------------------------------------------------------------------

struct CompTiming {
  double duration = 0;
  double frameRate = 24;
  double workAreaStart = 0;
  double workAreaDuration = 0;
};

struct PreviewSettings {
  enum class Range { WorkArea, Extended, Comp } range = Range::Extended;
  bool fromCurrent = false;
  bool loop = true;
  /** Frames per second shown; 0 = the comp's rate. */
  double frameRate = 0;
  /** Frames skipped between shown frames. */
  int skip = 0;
};

/** The comp times playback shows: from `begin`, one every `step` seconds, over [start, end). */
struct PlaybackSpan {
  double start = 0, end = 0, begin = 0, step = 1.0 / 24;
  bool loop = true;
};

struct Slot {
  double time;
  int64_t pass;
};

PlaybackSpan playbackSpan(const CompTiming& comp, double current, const PreviewSettings& settings);
/** The comp time of shown frame `k` and the pass over the range it is in; none past the end when not looping. */
std::optional<Slot> slotTime(const PlaybackSpan& span, int64_t k);
/** The slot due `elapsed` seconds after slot `origin` was shown. */
int64_t dueSlot(const PlaybackSpan& span, int64_t origin, double elapsed);
/** Fast Previews' lowest resolution divisor: Quarter, or 1/8 on phones and tablets. */
int adaptiveLimit(bool mobile);
/** The divisor Fast Previews moves to from `factor` once frames there take `typicalMs` of GPU time. */
int adaptiveFactor(int factor, double typicalMs, int limit);

// --- RAM preview cache (frameCache.ts) ---------------------------------------------------------------------------

/** Frames per view (a comp at one resolution) within a byte budget, least recently used evicted first. */
template <typename V>
class FrameCache {
 public:
  explicit FrameCache(size_t budget) : budget_(budget) {}

  size_t bytes() const { return used_; }
  size_t budget() const { return budget_; }
  size_t size() const { return order_.size(); }

  void setBudget(size_t bytes) {
    budget_ = bytes;
    evict();
  }

  bool has(const std::string& view, int64_t frame) const { return index_.count({view, frame}) > 0; }

  /** The cached frame, marked as most recently used; null when it is not cached. */
  const V* get(const std::string& view, int64_t frame) {
    auto it = index_.find({view, frame});
    if (it == index_.end()) return nullptr;
    order_.splice(order_.end(), order_, it->second);
    return &it->second->value;
  }

  /** Stores a frame; false (and nothing kept) when it alone exceeds the budget. */
  bool put(const std::string& view, int64_t frame, V value, size_t bytes) {
    erase(view, frame);
    if (bytes > budget_) return false;
    order_.push_back({view, frame, std::move(value), bytes});
    index_[{view, frame}] = std::prev(order_.end());
    used_ += bytes;
    evict();
    return true;
  }

  void erase(const std::string& view, int64_t frame) {
    auto it = index_.find({view, frame});
    if (it == index_.end()) return;
    used_ -= it->second->bytes;
    order_.erase(it->second);
    index_.erase(it);
  }

  /** Drops the frames of the views `match` accepts, or every frame. */
  void invalidate(const std::function<bool(const std::string&)>& match = nullptr) {
    for (auto it = order_.begin(); it != order_.end();) {
      if (match && !match(it->view)) {
        ++it;
        continue;
      }
      used_ -= it->bytes;
      index_.erase({it->view, it->frame});
      it = order_.erase(it);
    }
  }

  /** Cached frames of a view as sorted [start, end) spans. */
  std::vector<std::pair<int64_t, int64_t>> ranges(const std::string& view) const {
    std::vector<int64_t> frames;
    for (const Entry& e : order_)
      if (e.view == view) frames.push_back(e.frame);
    std::sort(frames.begin(), frames.end());
    std::vector<std::pair<int64_t, int64_t>> out;
    for (int64_t f : frames) {
      if (!out.empty() && out.back().second == f) out.back().second = f + 1;
      else out.push_back({f, f + 1});
    }
    return out;
  }

 private:
  struct Entry {
    std::string view;
    int64_t frame;
    V value;
    size_t bytes;
  };
  void evict() {
    while (used_ > budget_ && !order_.empty()) {
      used_ -= order_.front().bytes;
      index_.erase({order_.front().view, order_.front().frame});
      order_.pop_front();
    }
  }
  std::list<Entry> order_;
  std::map<std::pair<std::string, int64_t>, typename std::list<Entry>::iterator> index_;
  size_t used_ = 0;
  size_t budget_;
};

// --- player ------------------------------------------------------------------------------------------------------

/**
 * Plays frames the app has built plans for: `queue` hands over a frame's plan, `renderAhead` renders queued frames
 * into the cache while time allows, and `show` presents a frame (from the cache, or rendered on the spot) in the
 * engine's window. The app keeps the clock (the audio's, as usePlayback does) and says which frame is due.
 */
class Player {
 public:
  Player(Engine& engine, size_t cacheBytes, size_t maxQueued = 240);
  ~Player();

  /** Hands over the plan of `frame` in `view`, replacing an earlier one; false when the bytes are not a plan. */
  bool queue(const std::string& view, int64_t frame, const uint8_t* plan, size_t size, std::string& error);
  bool queued(const std::string& view, int64_t frame) const;
  bool cached(const std::string& view, int64_t frame) const;

  /** Renders queued frames that are not cached, oldest first, until `budgetMs` has passed; how many it rendered. */
  int renderAhead(double budgetMs, std::string& error);

  /** The frame, from the cache or rendered now from its queued plan; null when it has neither. */
  std::shared_ptr<Frame> frame(const std::string& view, int64_t frame, std::string& error);

  /** Presents a frame in the engine's window; false when it has no plan or cannot be shown. */
  bool show(const std::string& view, int64_t frame, const PresentRect& rect, const float background[3], std::string& error);

  /** Forgets the plans and frames of `view` (after an edit), or of every view with an empty name. */
  void invalidate(const std::string& view);

  /** Smoothed milliseconds a render takes (0 before the first). */
  double renderMs() const { return renderMs_; }
  FrameCache<std::shared_ptr<Frame>>& cache() { return cache_; }

 private:
  struct Queued {
    std::string view;
    int64_t frame;
    Plan plan;
  };
  std::shared_ptr<Frame> render(Queued& q, std::string& error);

  Engine& engine_;
  FrameCache<std::shared_ptr<Frame>> cache_;
  std::list<Queued> queue_;
  std::map<std::pair<std::string, int64_t>, std::list<Queued>::iterator> index_;
  size_t maxQueued_;
  double renderMs_ = 0;
};

}  // namespace aevk
