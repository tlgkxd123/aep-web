// Headless renderer: renders plan files (src/native/wire.ts) and writes each frame's straight RGBA, rows top first,
// next to it as <plan>.rgba (or into --out). Prints one JSON line per frame, and the device with --info.
//
//   aevk-render [--info] [--out dir] [--bench n] plan.aevp...
//
// --bench renders each plan n times after a first, untimed one and prints the median milliseconds of each stage
// instead of writing frames: reading the plan, recording the commands, the GPU's work, and reading the frame back.
#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <memory>
#include <string>
#include <vector>

#include "engine.h"
#include "plan.h"

namespace {

using Clock = std::chrono::steady_clock;

std::string jsonString(const std::string& s) {
  std::string out = "\"";
  for (char c : s) {
    if (c == '"' || c == '\\') out += '\\';
    if (static_cast<unsigned char>(c) < 0x20) {
      char buf[8];
      std::snprintf(buf, sizeof buf, "\\u%04x", c);
      out += buf;
      continue;
    }
    out += c;
  }
  return out + "\"";
}

std::string baseName(const std::string& path) {
  const size_t slash = path.find_last_of("/\\");
  return slash == std::string::npos ? path : path.substr(slash + 1);
}

double since(Clock::time_point start) { return std::chrono::duration<double, std::milli>(Clock::now() - start).count(); }

double median(std::vector<double> values) {
  if (values.empty()) return 0;
  std::sort(values.begin(), values.end());
  return values[values.size() / 2];
}

/** One plan rendered `runs` times: the median of each stage, as a JSON line; false with `error` set when it fails. */
bool bench(aevk::Engine& engine, const std::string& path, const std::vector<uint8_t>& bytes, int runs, std::string& error) {
  std::vector<double> decode, record, gpu, render, read;
  aevk::Plan plan;
  for (int i = 0; i < runs; i++) {
    const Clock::time_point start = Clock::now();
    if (!aevk::decodePlan(bytes.data(), bytes.size(), plan, error)) return false;
    decode.push_back(since(start));
  }
  // Each stage runs back to back, so the time one leaves the GPU idle does not show in the next (its clocks drop).
  // The first run of each fills the engine's pool of render targets.
  std::shared_ptr<aevk::Frame> frame;
  for (int i = 0; i <= runs; i++) {
    frame.reset();
    const Clock::time_point start = Clock::now();
    frame = engine.renderFrame(plan, error);
    if (!frame) return false;
    const double rendered = since(start);
    const aevk::FrameTimings timings = engine.lastTimings();
    if (i == 0) continue;
    render.push_back(rendered);
    record.push_back(timings.recordMs);
    gpu.push_back(timings.gpuMs);
  }
  for (int i = 0; i <= runs; i++) {
    const Clock::time_point start = Clock::now();
    const uint8_t* pixels = nullptr;
    if (!engine.mapPixels(*frame, pixels, error)) return false;
    if (i > 0) read.push_back(since(start));
  }
  const uint32_t width = frame->width() - 2 * aevk::kPad, height = frame->height() - 2 * aevk::kPad;
  std::printf("{\"plan\":%s,\"width\":%u,\"height\":%u,\"bytes\":%zu,\"decodeMs\":%.3f,\"recordMs\":%.3f,\"gpuMs\":%.3f,\"renderMs\":%.3f,\"readMs\":%.3f}\n",
              jsonString(path).c_str(), width, height, bytes.size(), median(decode), median(record), median(gpu), median(render), median(read));
  return true;
}

}  // namespace

int main(int argc, char** argv) {
  std::vector<std::string> plans;
  std::string outDir;
  bool info = false;
  int runs = 0;
  for (int i = 1; i < argc; i++) {
    if (!std::strcmp(argv[i], "--info")) info = true;
    else if (!std::strcmp(argv[i], "--out") && i + 1 < argc) outDir = argv[++i];
    else if (!std::strcmp(argv[i], "--bench") && i + 1 < argc) runs = std::max(1, std::atoi(argv[++i]));
    else plans.push_back(argv[i]);
  }
  std::string error;
  auto engine = aevk::Engine::create(aevk::EngineOptions(), error);
  if (!engine) {
    std::printf("{\"error\":%s}\n", jsonString(error).c_str());
    return 2;
  }
  const aevk::DeviceInfo& device = engine->device();
  if (info) {
    std::printf("{\"device\":%s,\"apiVersion\":\"%u.%u.%u\",\"software\":%s}\n", jsonString(device.name).c_str(), device.apiVersion >> 22,
                (device.apiVersion >> 12) & 0x3ff, device.apiVersion & 0xfff, device.software ? "true" : "false");
  }
  int failures = 0;
  for (const std::string& path : plans) {
    std::ifstream in(path, std::ios::binary);
    std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    if (!in.good() && !in.eof()) error = "cannot read the file";
    else if (runs) {
      if (bench(*engine, path, bytes, runs, error)) continue;
    } else {
      aevk::Plan plan;
      std::vector<uint8_t> rgba;
      uint32_t width = 0, height = 0;
      const Clock::time_point started = Clock::now();
      if (aevk::decodePlan(bytes.data(), bytes.size(), plan, error) && engine->render(plan, rgba, width, height, error)) {
        const double ms = since(started);
        const std::string out = (outDir.empty() ? path : outDir + "/" + baseName(path)) + ".rgba";
        std::ofstream(out, std::ios::binary).write(reinterpret_cast<const char*>(rgba.data()), std::streamsize(rgba.size()));
        std::printf("{\"plan\":%s,\"output\":%s,\"width\":%u,\"height\":%u,\"ms\":%.3f}\n", jsonString(path).c_str(), jsonString(out).c_str(), width, height,
                    ms);
        continue;
      }
    }
    failures++;
    std::printf("{\"plan\":%s,\"error\":%s}\n", jsonString(path).c_str(), jsonString(error).c_str());
  }
  return failures ? 1 : 0;
}
