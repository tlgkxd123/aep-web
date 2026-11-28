// The Vulkan compositor: renders a Plan as src/render/renderer.ts renders a comp with WebGL2, pass for pass (layer
// content, masks, placement through the layer matrix with perspective for 3D layers, then a composite pass with the
// blend mode, track matte and opacity). Images are premultiplied RGBA8 with a 1 px transparent border, top row first.
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "plan.h"

#if defined(__ANDROID__)
struct ANativeWindow;
#endif

namespace aevk {

struct DeviceInfo {
  std::string name;
  /** Vulkan API version the device supports (VK_MAKE_API_VERSION). */
  uint32_t apiVersion = 0;
  uint32_t vendorId = 0;
  /** A CPU implementation (lavapipe, SwiftShader). */
  bool software = false;
};

struct EngineOptions {
  /** Pooled render targets the engine keeps between frames at most, in bytes. */
  size_t poolBudget = size_t(256) << 20;
  /** Enables VK_LAYER_KHRONOS_validation when it is installed (also with the AEVK_VALIDATION environment variable). */
  bool validation = false;
  /** Asks for the window extensions (Android, Windows, Linux with xcb), so frames can be presented. */
  bool presentation = false;
  /** Presents in step with the display (FIFO); off shows frames as soon as they are drawn, for measuring. */
  bool vsync = true;
  /** Folders searched for the footage files plans name (sound for Audio Spectrum), relinked as After Effects relinks. */
  std::vector<std::string> mediaFolders;
};

class Engine;

/** A vertex of the interface, laid out as Dear ImGui's ImDrawVert: window pixels, texture coordinates, straight RGBA8. */
struct UiVertex {
  float x = 0, y = 0, u = 0, v = 0;
  uint32_t rgba = 0;
};

/** The texture id of the frame passed to presentUi: its content without the border, premultiplied. */
constexpr uint64_t kUiFrameTexture = ~uint64_t(0);

/** One run of triangles of the interface: indices into the vertices, clipped to a window rectangle. */
struct UiCommand {
  /** Left, top, right, bottom, in window pixels. */
  float clip[4] = {0, 0, 0, 0};
  /** An id from createUiTexture, or kUiFrameTexture. */
  uint64_t texture = 0;
  uint32_t firstIndex = 0, indexCount = 0;
  int32_t vertexOffset = 0;
  /** Samples the texture's nearest pixel (a frame zoomed in), else bilinearly. */
  bool nearest = false;
};

/** A whole frame of the interface, drawn back to front. */
struct UiDrawData {
  std::vector<UiVertex> vertices;
  std::vector<uint32_t> indices;
  std::vector<UiCommand> commands;
};

/** A rendered frame kept on the GPU, premultiplied with the border. Drop every frame before its engine. */
class Frame {
 public:
  ~Frame();
  uint32_t width() const;
  uint32_t height() const;
  /** GPU bytes the frame holds. */
  size_t bytes() const;

 private:
  friend class Engine;
  struct State;
  std::unique_ptr<State> state_;
};

/** Where `present` draws a frame in the window, in window pixels; a zero size fits it to the window. */
struct PresentRect {
  float x = 0, y = 0, width = 0, height = 0;
};

/** What the last frame cost: recording its commands on the CPU, then from submitting them until the GPU was done. */
struct FrameTimings {
  double recordMs = 0;
  double gpuMs = 0;
};

class Engine {
 public:
  /** An engine on the best Vulkan device there is; null with `error` set when there is none. */
  static std::unique_ptr<Engine> create(const EngineOptions& options, std::string& error);
  ~Engine();
  Engine(const Engine&) = delete;
  Engine& operator=(const Engine&) = delete;

  const DeviceInfo& device() const;

  /** Renders the plan and keeps the frame on the GPU; null with `error` set when it cannot. */
  std::shared_ptr<Frame> renderFrame(const Plan& plan, std::string& error);
  const FrameTimings& lastTimings() const;
  /** What the last frame skipped (effects the engine does not draw...). */
  const std::vector<std::string>& lastWarnings() const;
  /**
   * Straight-alpha RGBA of a frame, rows top first, without the border, in the engine's own memory: `rgba` stays valid
   * until the next call on the engine.
   */
  bool mapPixels(const Frame& frame, const uint8_t*& rgba, std::string& error);
  /** mapPixels, copied. */
  bool readPixels(const Frame& frame, std::vector<uint8_t>& rgba, std::string& error);
  /** renderFrame then readPixels. */
  bool render(const Plan& plan, std::vector<uint8_t>& rgba, uint32_t& width, uint32_t& height, std::string& error);

#if defined(__ANDROID__)
  /** Presents into `window` from now on (replacing an earlier one); the engine must be created with `presentation`. */
  bool attachWindow(ANativeWindow* window, std::string& error);
#else
  /**
   * Presents into a desktop window from now on (replacing an earlier one): an xcb_connection_t* and xcb_window_t on
   * Linux, an HINSTANCE and HWND on Windows. The engine must be created with `presentation`.
   */
  bool attachDesktopWindow(void* display, uint64_t window, std::string& error);
#endif
  void detachWindow();
  /** The attached window changed size: the next present makes its images again at the new size. */
  void windowResized();
  /** Whether a window is attached. */
  bool hasWindow() const;
  /** Draws a frame into the attached window over `background` (straight RGB) and shows it. */
  bool present(const Frame& frame, const PresentRect& rect, const float background[3], std::string& error);

  /** Searches `folder` too for the footage files plans name (a project opened after the engine was made). */
  void addMediaFolder(const std::string& folder);
  /** The window's size in pixels as presentation last saw it (0 before the first present). */
  void windowSize(uint32_t& width, uint32_t& height) const;
  /**
   * Draws the interface into the attached window over `background` (straight RGB) and shows it; `frame`, when given,
   * is what commands with kUiFrameTexture sample.
   */
  bool presentUi(const UiDrawData& ui, const Frame* frame, const float background[3], std::string& error);
  /** A texture for the interface from straight RGBA8, rows top first (a font atlas, icons); 0 with `error` set. */
  uint64_t createUiTexture(const uint8_t* rgba, uint32_t width, uint32_t height, std::string& error);
  void destroyUiTexture(uint64_t texture);
  /** Gives back pooled render targets beyond `bytes`. */
  void trim(size_t bytes);
  size_t pooledBytes() const;

  struct Impl;

 private:
  explicit Engine(std::unique_ptr<Impl> impl);
  std::unique_ptr<Impl> impl_;
};

}  // namespace aevk
