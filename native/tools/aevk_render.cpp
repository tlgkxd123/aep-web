// Headless renderer: renders plan files (src/native/wire.ts) and writes each frame's straight RGBA, rows top first,
// next to it as <plan>.rgba (or into --out). Prints one JSON line per frame, and the device with --info.
//
//   aevk-render [--info] [--out dir] plan.aevp...
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "engine.h"
#include "plan.h"

namespace {

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

}  // namespace

int main(int argc, char** argv) {
  std::vector<std::string> plans;
  std::string outDir;
  bool info = false;
  for (int i = 1; i < argc; i++) {
    if (!std::strcmp(argv[i], "--info")) info = true;
    else if (!std::strcmp(argv[i], "--out") && i + 1 < argc) outDir = argv[++i];
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
    aevk::Plan plan;
    std::vector<uint8_t> rgba;
    uint32_t width = 0, height = 0;
    const auto started = std::chrono::steady_clock::now();
    if (!in.good() && !in.eof()) error = "cannot read the file";
    else if (aevk::decodePlan(bytes.data(), bytes.size(), plan, error) && engine->render(plan, rgba, width, height, error)) error.clear();
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    if (!error.empty()) {
      failures++;
      std::printf("{\"plan\":%s,\"error\":%s}\n", jsonString(path).c_str(), jsonString(error).c_str());
      continue;
    }
    const std::string out = (outDir.empty() ? path : outDir + "/" + baseName(path)) + ".rgba";
    std::ofstream(out, std::ios::binary).write(reinterpret_cast<const char*>(rgba.data()), std::streamsize(rgba.size()));
    std::printf("{\"plan\":%s,\"output\":%s,\"width\":%u,\"height\":%u,\"ms\":%.3f}\n", jsonString(path).c_str(), jsonString(out).c_str(), width, height, ms);
  }
  return failures ? 1 : 0;
}
