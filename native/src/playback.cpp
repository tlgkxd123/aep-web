#include "playback.h"

#include <algorithm>
#include <chrono>
#include <cmath>

namespace aevk {
namespace {

/** Fast Previews: GPU time per frame above which playback lowers its resolution (usePlayback.ts ADAPTIVE_MS). */
constexpr double kAdaptiveMs = 26;

double nowMs() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

}  // namespace

PlaybackSpan playbackSpan(const CompTiming& comp, double current, const PreviewSettings& settings) {
  const double frame = 1 / (comp.frameRate > 0 ? comp.frameRate : 24);
  double start = comp.workAreaStart;
  double end = std::min(comp.duration, start + comp.workAreaDuration);
  if (settings.range == PreviewSettings::Range::Comp) {
    start = 0;
    end = comp.duration;
  } else if (settings.range == PreviewSettings::Range::Extended) {
    const double s = std::min(start, current);
    const double e = std::max(end, std::min(comp.duration, current + frame));
    start = s;
    end = e;
  }
  end = std::max(end, start + frame);
  const double begin = settings.fromCurrent && current >= start && current < end ? current : start;
  const double rate = settings.frameRate > 0 ? settings.frameRate : comp.frameRate > 0 ? comp.frameRate : 24;
  return {start, end, begin, (settings.skip + 1) / rate, settings.loop};
}

std::optional<Slot> slotTime(const PlaybackSpan& span, int64_t k) {
  const double length = span.end - span.start;
  const double offset = span.begin - span.start + double(k) * span.step;
  const int64_t pass = int64_t(std::floor(offset / length + 1e-9));
  if (!span.loop && pass > 0) return std::nullopt;
  return Slot{span.start + std::max(0.0, offset - double(pass) * length), pass};
}

int64_t dueSlot(const PlaybackSpan& span, int64_t origin, double elapsed) {
  return origin + std::max<int64_t>(0, int64_t(std::floor(elapsed / span.step + 1e-6)));
}

int adaptiveLimit(bool mobile) { return mobile ? 8 : 4; }

int adaptiveFactor(int factor, double typicalMs, int limit) {
  int next = factor + 1;
  while (next < limit && typicalMs * std::pow(double(factor) / next, 2) > kAdaptiveMs) next++;
  return std::min(next, limit);
}

Player::Player(Engine& engine, size_t cacheBytes, size_t maxQueued) : engine_(engine), cache_(cacheBytes), maxQueued_(maxQueued) {}

Player::~Player() { cache_.invalidate(); }

bool Player::queue(const std::string& view, int64_t frame, const uint8_t* plan, size_t size, std::string& error) {
  Queued q{view, frame, Plan()};
  if (!decodePlan(plan, size, q.plan, error)) return false;
  auto old = index_.find({view, frame});
  if (old != index_.end()) {
    queue_.erase(old->second);
    index_.erase(old);
  }
  // A new plan for a frame means it changed: the frame rendered from the old one is stale.
  cache_.erase(view, frame);
  queue_.push_back(std::move(q));
  index_[{view, frame}] = std::prev(queue_.end());
  while (queue_.size() > maxQueued_) {
    index_.erase({queue_.front().view, queue_.front().frame});
    queue_.pop_front();
  }
  return true;
}

bool Player::queued(const std::string& view, int64_t frame) const { return index_.count({view, frame}) > 0; }

bool Player::cached(const std::string& view, int64_t frame) const {
  auto* self = const_cast<Player*>(this);
  const std::shared_ptr<Frame>* f = self->cache_.get(view, frame);
  return f && *f;
}

std::shared_ptr<Frame> Player::render(Queued& q, std::string& error) {
  const double started = nowMs();
  std::shared_ptr<Frame> frame = engine_.renderFrame(q.plan, error);
  if (!frame) return nullptr;
  const double took = nowMs() - started;
  renderMs_ = renderMs_ > 0 ? renderMs_ + (took - renderMs_) * 0.3 : took;
  cache_.put(q.view, q.frame, frame, frame->bytes());
  return frame;
}

int Player::renderAhead(double budgetMs, std::string& error) {
  const double started = nowMs();
  int rendered = 0;
  for (Queued& q : queue_) {
    if (cached(q.view, q.frame)) continue;
    if (rendered > 0 && nowMs() - started + renderMs_ > budgetMs) break;
    if (!render(q, error)) return rendered;
    rendered++;
  }
  return rendered;
}

std::shared_ptr<Frame> Player::frame(const std::string& view, int64_t frame, std::string& error) {
  if (const std::shared_ptr<Frame>* hit = cache_.get(view, frame); hit && *hit) return *hit;
  auto it = index_.find({view, frame});
  if (it == index_.end()) {
    error = "no plan was queued for frame " + std::to_string(frame);
    return nullptr;
  }
  return render(*it->second, error);
}

bool Player::show(const std::string& view, int64_t frame, const PresentRect& rect, const float background[3], std::string& error) {
  std::shared_ptr<Frame> f = this->frame(view, frame, error);
  return f && engine_.present(*f, rect, background, error);
}

void Player::invalidate(const std::string& view) {
  for (auto it = queue_.begin(); it != queue_.end();) {
    if (!view.empty() && it->view != view) {
      ++it;
      continue;
    }
    index_.erase({it->view, it->frame});
    it = queue_.erase(it);
  }
  cache_.invalidate([&](const std::string& v) { return view.empty() || v == view; });
}

}  // namespace aevk
