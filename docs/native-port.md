# Native C++ port

The goal: the app running as native C++ on desktop (Linux, Windows) and mobile (Android first), with phones playing
projects at close to desktop speed.

## Where things stand

| Area | Web app (`src/`) | Native today (`native/`) |
| --- | --- | --- |
| Project parsing (`.aep` RIFX) | `aep/` 3.7k lines | `native/core` (M1) |
| Property evaluation (keyframes, eases, motion paths, parenting, cameras) | `aep/evaluate.ts`, `aep/transform.ts` | `native/core` (M1) |
| Expressions | `expressions/` 3.2k lines on acorn | none |
| Compositing (solids, precomps, shapes, masks, mattes, blend modes, 3D) | `render/renderer.ts` (WebGL2) | `native/src` (Vulkan), from a plan |
| Shape layers | `render/shapes.ts` | geometry in `native/core` (M1), raster in `native/src`; no dashes yet |
| Text layers | `render/` + fonts | none |
| Footage (images, video, audio) | `media/` 3.7k lines | stills and image sequences (PNG, BMP, TIFF) in `native/src/image.cpp`; video through FFmpeg on desktop (`native/src/video.cpp`); JPEG stills through FFmpeg on desktop; WAV for Audio Spectrum; no JPEG or video on Android yet |
| Effects (54 files, built-in and third-party look-alikes) | `render/effects/` ~15k lines | none |
| Editing (undo, layer ops, write back to `.aep`) | `edit/` 6.2k lines | none |
| UI | `ui/` 17k lines of React | none |

Before this port, the Android app ran the whole front half in the WebView: JavaScript parsed the project, evaluated
every property, built a frame plan, serialized it, and sent the bytes over the WebView bridge for the Vulkan engine to
draw. On a phone that front half, not the GPU, is what keeps playback from reaching desktop speed.

## The approach

Move the per-frame work to C++ from the bottom up, and keep the plan (`native/src/plan.h`) as the seam between the
project side and the compositor:

```
.aep bytes --CProjectParser--> CProject --CFramePlanner(time)--> aevk::Plan --aevk::Engine--> frame on the GPU
```

Nothing in that loop touches JavaScript, a bridge, or a serialized plan. The web UI can keep driving it (see M6), but a
frame no longer waits on it.

Every native stage is held to its TypeScript original rather than to a second spec: `scripts/reports/native-parity.ts`
has `native/tools/aep_plan.cpp` build plans in C++ and compares them, value by value, with the plans `src/native/plan.ts`
writes for the fixture projects.

## Milestones

**M1. Project core in C++** (`native/core`, library `aepcore`, no GPU dependency). Done: see "Measured" below.

- RIFX reader, chunk decoders, project model, and the parser for items, comps, layers, property trees, keyframes, masks,
  shape paths and gradients.
- Evaluation: temporal bezier eases solved as AE does, spatial motion paths with arc-length easing, roving keys, hold
  and linear keys, Orientation slerp, path morphing, gradient blending, separated Position, time remapping.
- Transforms, parenting, the default and layer cameras, 3D draw order, track mattes, solo, adjustment layers.
- Shape layers: rectangles, ellipses, stars, free paths, groups, fills, strokes, gradients, Trim Paths, Repeater.
- `CFramePlanner` builds an `aevk::Plan` in memory; `EncodePlan` writes the same bytes as `src/native/wire.ts`.
- Tools: `aep-plan` with `scripts/reports/native-parity.ts` (parity with the TypeScript planner), `aep-play` (parses,
  plans and renders a comp end to end, and times each stage).

Effects, text and footage make a frame unsupported, exactly as in the TypeScript planner; expressions are evaluated
pre-expression and reported (M3).

**M2. Native shells: desktop window and Android without the WebView in the frame loop**

- Desktop: a window (Vulkan surface) with playback, scrubbing and the engine's present path, which today only
  covers Android surfaces.
- Android: the Java side hands the project bytes to C++ once; playback, timing and presentation run in C++ on a
  `SurfaceView`. The WebView only sends edits and the playhead.

Status: built; the desktop viewer runs, the Android side is written but not yet compiled.

- `native/app/session.cpp` (`CPlaybackSession`) is the loop both share: it parses the project once, plans frames in C++
  ahead of the playhead (`Player::queue` now takes an in-memory plan, so no wire format is involved), renders them into
  the RAM preview cache within a per-frame budget and presents the due frame, with the Preview panel's timing
  (`playbackSpan`, `dueSlot`).
- The engine presents to desktop windows too (`Engine::attachDesktopWindow`): Win32 on Windows, xcb on Linux when its
  headers are installed. The window code is written straight against Win32 and xcb rather than GLFW, so the build pulls in
  nothing new. `EngineOptions::vsync = false` picks a present mode that does not wait for the display.
- `aep-viewer` (`native/tools/aep_viewer.cpp`) plays a project in a window: Space plays, Left and Right step, 1 to 4 set
  the resolution, Page Up and Down switch comps, dragging scrubs. `--benchmark --no-vsync --frames n` plans and renders
  every frame afresh as fast as it can and prints what it cost.
- Android: `native/android/aep_player_jni.cpp` runs the session on its own thread, ticked by `AChoreographer` once per
  display frame, presenting into the plugin's `SurfaceView`. `NativeEnginePlugin` gains `openProject`, `selectComp`,
  `setResolution`, `setPlaying`, `seek` and `playbackState`, and `src/native/player.ts` wraps them for the page. After an
  edit the page sends the project again as `src/aep/write.ts` writes it. The Preview panel does not use it yet (M6).

Measured (M2, cloud x86-64, lavapipe under Xvfb): 28 of the 30 fixture projects open and play in `aep-viewer`; the
other two have no comp the engine can draw yet. Played at the comp's rate with vsync, simple comps hold their frame
rate with no dropped frames. With `--benchmark --no-vsync` (each frame planned, rendered and presented, nothing cached),
the fixtures' small comps (64x48 to 320x240) run at 2.5 to 650 frames a second; the slow ones are effect-heavy comps
whose GPU work lavapipe does on the CPU (planning stays under 8 ms everywhere). Windows and Android are not compiled
here: there is no Windows toolchain or Android NDK on the cloud copy, so both were only syntax-checked (Android against
stand-in NDK headers).

**M3. Expressions**

Embed QuickJS-ng (MIT, small, runs on Android and iOS without a JIT) and run the app's own expression engine in it:
`scripts/native/build-expressions.ts` bundles `src/native/qjs/entry.ts` with `src/expressions` and the parser and
evaluator they use into `native/core/expressions/bundle.js`, which the build embeds. The C++ planner calls into it only
for properties that have an expression (`CurrentValue` in `evaluate.cpp`, `CExpressionEngine` in `expressions.cpp`), so
an expression gives the same result as in the web app, sandbox and error messages included, and everything else stays
in C++. iOS forbids a JIT, so QuickJS's interpreter is the one engine that behaves the same everywhere.

Status: done. Build with `-DAEP_EXPRESSIONS=ON` (it fetches QuickJS-ng v0.18.0 at configure time, so it stays off by
default to keep the base build offline) and check with `node scripts/reports/native-parity.ts --expressions --tool
<build>/aep-plan`.

Measured (M3, cloud x86-64, Release):

- Parity with expressions on: 2,579/2,579 manifest frames and 9,540/9,540 sweep frames match the TypeScript planner
  with its expression engine installed. On the three expression fixtures, 176 of 240 swept frames differ from the
  same frames with expressions off, so the comparison does exercise them.
- Startup, per project (evaluating the 419 KiB script and re-parsing the project in it): 60 ms (expr_legacy, 14
  expressions), 270-330 ms (expr_random, 144), 450-480 ms (expr, 262).
- Plan time, averaged over four passes of every comp at 12 times, against warm Node with the same engine:

  | Fixture | C++ + QuickJS | Node (JIT) |
  | --- | --- | --- |
  | expr_legacy | 0.38 ms a frame | 0.15 ms |
  | expr | 1.5 ms | 0.65 ms |
  | expr_random | 8.9 ms | 2.5 ms |

  Frames without expressions are unchanged (0.01-0.13 ms). The interpreter is 2-4 times slower than a JIT on
  expression-heavy frames, which a phone's slower cores will multiply.

Next, in order of payoff: compile the script to QuickJS bytecode at build time (`qjsc`) so startup skips parsing it;
let the script take the C++ core's parsed project instead of re-parsing the file; and move the expression API's hottest
calls (a referenced property's value, `toComp`, `wiggle`, the noise behind `random`) to C++ natives.

**M4. Text and footage**

- Text: FreeType for glyphs and HarfBuzz for shaping, laid out as `src/render` lays it out, drawn as shape paints.
- Images (done for PNG, BMP and TIFF): decoded by the engine's own code in `native/src/image.cpp` (inflate, PNG
  filters, palettes and tRNS, Adam7, BMP, and a port of `src/media/tiff.ts`), with no library. Plan v5 carries a
  `footage` content kind: the frame's recorded file (a sequence's frame resolved by both planners as
  `footageStore.frame` does), the source size and the Interpret Footage alpha settings. The engine relinks the file
  through its media folders, keeps decoded frames in a 512 MB LRU, and interprets them on the GPU
  (`shaders/footage.frag`, a port of `INTERPRET_FS`, reduced-resolution averaging included). Every PNG, BMP and
  sequence fixture passes; `footage_tiff` and `footage_tiff_assoc` fail exactly as the WebGL renderer does on master.
  The web app's own native bridge (`src/native/engine.ts`) leaves footage frames to WebGL, because there the files
  belong to the browser. JPEG stills decode through FFmpeg on desktop (`decodeStill` in `native/src/video.cpp`, full-range
  BT.601 as browsers decode JFIF); the three JPEG fixtures pass. Android has no JPEG decoder yet.
- Video (done on desktop): plan v6 adds the seconds of the file's own time whose picture shows (the frame index over
  the file's native rate, as `footageStore.videoFrame` reads it). `native/src/video.cpp` opens the file with FFmpeg
  (when CMake finds libavformat, libavcodec and libswscale; `-DAEVK_FFMPEG=OFF` leaves it out), lists the samples'
  presentation times as `src/media/mp4.ts` does, picks one the way `indexAtTimes` does, and decodes forward from where
  it stopped (seeking to the key frame only for a jump back or more than 2 s ahead). 8-bit 4:2:0, 4:2:2, 4:4:4 and
  NV12 pictures keep their planes and upload as bytes; `shaders/footage_yuv.frag` converts them as `INTERPRET_FS`
  does (After Effects' matrix, bilinear chroma). Other formats go through swscale to RGBA. All `footage_video`
  reference frames pass. Android still needs `AMediaCodec` behind the same `VideoReader`, and before that a way to
  reach the project's footage folder (below).
- Plan v7 adds each effect layer's Time Stretch, so effects that run on the layer's own clock (Ripple's waves) see
  the same time the TypeScript renderer gives them.
- Plan v8 adds the Time effects' other frames: Posterize Time, Echo, CC Wide Time, CC Force Motion Blur, Time
  Difference and Time Displacement carry their layer as it enters the effect (content, masks and the effects above it)
  at each comp time they read, timed by both planners from the effects' parameters (`inputTimes` in
  `src/native/plan.ts`). The engine draws them through the same layer path (`FxContext::input`) and folds them as
  `perspectiveTime.ts` does, 7 frames a pass (Time Displacement 6 beside its map). 22 of their 24 reference frames
  pass; Echo's Composite In Back cell at frame 16 and Time Difference's edges at frame 15 differ as the WebGL model
  does.
- Adjustment layers' effects run on the composite below them in comp pixels, as `placeAdjustment` does; the layer's
  own image still only says where the result shows. All four `adjust_*` reference frames pass.

**M5. Effects**

Port the effect shaders to Vulkan, most used first: blurs, color correction, glow, keying, distort, then the
third-party look-alikes. Each one gets a parity check against its WebGL version in the pixel reports.

**M6. Editing and UI**

Two ways, and the recommendation is the first:

1. Keep the React UI as the editor (Electron on desktop, the Capacitor WebView on Android) over the native core:
   project edits go to C++ as small commands, frames never come back through JavaScript. The 17k lines of UI and the
   6k lines of edit logic keep working, and playback runs at native speed.
2. A fully native UI (Dear ImGui) and a C++ port of `src/edit`. It only pays off if the app has to run without any web
   runtime.

Status: the native interface is chosen (November 2026) and its viewing half is done; editing (a C++ port of
`src/edit`) is not started. `native/ui` is one Dear ImGui (MIT, v1.91.9b, fetched at configure time with `-DAEP_UI=ON`,
the default) interface for both platforms, drawn by the engine itself (`Engine::presentUi`, `native/shaders/ui.*`), with
the comp's frame sampled straight from the GPU:

- Home: open a project (the file browser on desktop, the system file picker on Android) or one of the recent ones.
- Desktop layout (wide windows): File, View and Help menus; Project (comps with size, rate and duration, footage);
  the viewer (fit, wheel zoom about the pointer, drag to pan, double-click to fit, transparency grid); playback
  controls (start, step, play, end, timecode, resolution, frames a second); the Timeline (layer bars by kind, the
  ruler, drag to scrub, click to select); the selected layer's details (timing, parent, matte, Transform values now
  with keyframe and expression marks, masks, effects and their values); Info (GPU, plan and render times, warnings);
  a status bar. Panels resize by dragging their edges. Space, Left, Right, Home, End, Ctrl+O and Ctrl+Q work.
- Compact layout (narrow windows, phones held upright): a menu button and comp picker, the viewer, large playback
  buttons, a full-width scrub bar, and tabs for Layers, Details, Project and Info. On touch screens targets are larger,
  a finger drag scrolls lists and a pinch zooms the viewer; the interface keeps clear of the system bars and cutout.
- Save Frame As PNG writes next to the project on desktop and to Pictures/aep on Android.

Hosts: `native/tools/aep_app.cpp` (`aep-app [--scale s] [--no-vsync] [--play] [project.aep]`, xcb on Linux, Win32 on
Windows) and `native/android/aep_app_jni.cpp` with `NativeAppActivity.java`, which is the launcher entry "aep native"
(the web app stays as "aep-web", and opens instead on devices without Vulkan). Checked here on Linux under Xvfb with
lavapipe, in a 1440x900 window and a 432x900 phone-sized one; the Android and Windows hosts are syntax-checked only.
Android cannot search a picked project's folder for its footage yet (the file picker grants the one file).

## Mobile speed

What makes a phone slower than a desktop here, and what each milestone does about it:

- **JavaScript evaluation and plan building per frame.** Gone after M1 + M2. `aep-play` measures it.
- **The bridge.** Plans and frames crossing the WebView channel (base64 on older WebViews) cost a copy each way. Gone
  after M2: frames are presented from the GPU.
- **Video decode copies.** Gone after M4 with hardware buffers imported into Vulkan.
- **GPU work.** Already native. Reduced resolution (Half, Third, Quarter) is in the plan, and the engine pools render
  targets.

Phone numbers are not measured yet: only desktop and Mesa's software Vulkan (lavapipe) are measured in this repo.

## Measured (M1)

On a 4-core Xeon at 2.1 GHz with Mesa lavapipe (software Vulkan, no GPU), November 2026:

```
cmake -S native -B native/build -DCMAKE_BUILD_TYPE=Release && cmake --build native/build
node scripts/reports/native-parity.ts             # the frames the suites' manifests list
node scripts/reports/native-parity.ts --sweep 12  # every comp of every fixture project at 12 times
native/build/aep-play --frames 30 --wire refs/fixtures/transitions2.aep
```

- **Parity.** All 2,579 manifest frames and all 9,540 sweep frames match the TypeScript planner: 2,402 complete plans
  field by field (float tolerance 1e-3), the rest on the same list of what neither side can render yet. Half and other
  scales match too. Both sides leave expressions out until M3.
- **Parsing** a fixture project: 1.4 to 17 ms in C++ against 3 to 52 ms in Node once its JIT is warm (up to 116 ms
  cold), about 3 to 4 times faster.
- **Planning** a frame: 0.01 to 0.13 ms in C++ against 0.02 to 0.21 ms in warm Node, 2 to 3 times faster. Either way it
  is a small part of a frame on desktop; on a phone the JavaScript side runs in the WebView's engine and its plan crosses
  the bridge, which is what the in-memory path removes.
- **Wire format.** Encoding and decoding a plan costs 0.01 ms or less, so the bridge's cost is the copy across the
  WebView, not the format.
- **Rendering** on lavapipe: about 1 ms for the 160x120 fixtures, 22 ms for 48 layers at 160x120 and 640 ms for the
  same at 1920x1440, all GPU time rasterized on the CPU. Real GPUs, desktop or phone, are not in this environment.


## iOS

The core (`aepcore`) is plain C++17 and builds for iOS as is. The engine needs MoltenVK (Vulkan on Metal, Apache-2.0),
video decode would use VideoToolbox, and the shell would be a small Swift or Objective-C++ app hosting a `CAMetalLayer`.
Building and signing it needs a Mac with Xcode and an Apple developer account.

## Code style for the new C++

New native code follows Rockstar's style:

- Classes `CName`, plain data structs `sName`, enums `eName` with `ALL_CAPS` values.
- Members `m_` with a type prefix (`m_bEnabled`, `m_fTime`, `m_iIndex`, `m_uFlags`, `m_pParent`); objects and containers
  plain (`m_Name`, `m_Layers`). Statics `s_`.
- Functions and methods in PascalCase; braces on their own lines; tabs.
- Fixed-size types (`s32`, `u32`, `f32`, `f64`) from `native/core/types.h`.
- Comments are `/** */`, on every type and function a reader would look up.

The existing engine in `native/src` keeps its own style; it is not reformatted.
