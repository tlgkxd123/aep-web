// The same timing cases as tests/playback.test.ts, so the native player and the web one agree.
#include "check.h"
#include "playback.h"

using namespace aevk;

namespace {
CompTiming comp() {
  CompTiming c;
  c.frameRate = 24;
  c.duration = 10;
  c.workAreaStart = 2;
  c.workAreaDuration = 3;
  return c;
}
}  // namespace

TEST(span_plays_the_work_area_looping) {
  PreviewSettings settings;
  settings.range = PreviewSettings::Range::WorkArea;
  const PlaybackSpan span = playbackSpan(comp(), 0, settings);
  CHECK(span.start == 2 && span.end == 5 && span.begin == 2 && span.loop);
  CHECK_NEAR(span.step, 1.0 / 24, 1e-9);
  CHECK(slotTime(span, 0)->time == 2 && slotTime(span, 0)->pass == 0);
  CHECK_NEAR(slotTime(span, 24)->time, 3, 1e-9);
  CHECK(slotTime(span, 72)->pass == 1);
  CHECK_NEAR(slotTime(span, 72)->time, 2, 1e-9);
}

TEST(span_extends_to_the_current_time) {
  PreviewSettings settings;
  settings.range = PreviewSettings::Range::Extended;
  settings.fromCurrent = true;
  const PlaybackSpan span = playbackSpan(comp(), 7, settings);
  CHECK(span.start == 2);
  CHECK_NEAR(span.end, 7 + 1.0 / 24, 1e-9);
  CHECK(span.begin == 7);
}

TEST(due_slot_across_passes) {
  PreviewSettings settings;
  settings.range = PreviewSettings::Range::WorkArea;
  const PlaybackSpan span = playbackSpan(comp(), 0, settings);
  CHECK(dueSlot(span, 10, 0) == 10);
  CHECK(dueSlot(span, 10, 1.0 / 24 - 1e-9) == 11);
  CHECK(dueSlot(span, 10, 0.5) == 22);
  const auto later = slotTime(span, dueSlot(span, 10, 3));
  CHECK(later->pass == 1);
  CHECK_NEAR(later->time, slotTime(span, 10)->time, 1e-9);
}

TEST(span_without_loop_ends) {
  PreviewSettings settings;
  settings.range = PreviewSettings::Range::WorkArea;
  settings.loop = false;
  const PlaybackSpan span = playbackSpan(comp(), 0, settings);
  CHECK(slotTime(span, 71).has_value());
  CHECK(!slotTime(span, 72).has_value());
}

TEST(skip_and_frame_rate_set_the_step) {
  PreviewSettings settings;
  settings.frameRate = 12;
  settings.skip = 1;
  CHECK_NEAR(playbackSpan(comp(), 0, settings).step, 2.0 / 12, 1e-12);
}

TEST(adaptive_resolution_steps) {
  CHECK(adaptiveLimit(false) == 4);
  CHECK(adaptiveLimit(true) == 8);
  CHECK(adaptiveFactor(1, 30, 4) == 2);
  CHECK(adaptiveFactor(1, 400, 4) == 4);
  CHECK(adaptiveFactor(1, 1000, 8) == 7);
  CHECK(adaptiveFactor(1, 1000, 4) == 4);
  CHECK(adaptiveFactor(3, 1000, 4) == 4);
  CHECK(adaptiveFactor(4, 260, 8) == 8);
}

TEST(frame_cache_evicts_least_recently_used) {
  FrameCache<int> cache(100);
  CHECK(cache.put("a", 0, 1, 40));
  CHECK(cache.put("a", 1, 2, 40));
  CHECK(cache.get("a", 0) && *cache.get("a", 0) == 1);
  CHECK(cache.put("a", 2, 3, 40));
  CHECK(cache.has("a", 0) && !cache.has("a", 1) && cache.has("a", 2));
  CHECK(cache.bytes() == 80);
  CHECK(!cache.put("a", 3, 4, 101));
  CHECK(cache.put("b", 5, 5, 10));
  const auto ranges = cache.ranges("a");
  CHECK(ranges.size() == 2 && ranges[0].first == 0 && ranges[0].second == 1 && ranges[1].first == 2);
  cache.invalidate([](const std::string& v) { return v == "a"; });
  CHECK(cache.size() == 1 && cache.has("b", 5) && cache.bytes() == 10);
  cache.setBudget(5);
  CHECK(cache.size() == 0 && cache.bytes() == 0);
}
