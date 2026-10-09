# Gates: export - Render Queue, export pipeline, playback and RAM preview

OWNS: src/export/**, src/playback/**, src/ui/RenderQueuePanel.tsx, src/render/contentCache.ts, scripts/export-report.ts, scripts/export/**, scripts/perf-report.ts, scripts/perf-profile.ts, scripts/perf/**, scripts/probe-codecs.ts, scripts/list-comps.ts, scripts/rank-comps.ts, scripts/lib/png-decode.ts, scripts/lib/zip-read.ts, scripts/lib/mp4-demux.ts, scripts/lib/webm-demux.ts, tests/playback.test.ts, tests/render-queue.test.tsx, gates/export.md

Shared files with small focused edits: src/render/renderer.ts, src/render/gl.ts, src/ui/App.tsx, src/ui/CompositionPanel.tsx, src/ui/TimelinePanel.tsx, src/ui/MenuBar.tsx, src/styles.css, package.json, .gitignore.

Scope: AE's Render Queue (Composition > Add to Render Queue, render settings, output modules for H.264 MP4, VP9 WebM with alpha and PNG sequences), the WebCodecs export pipeline, real-time playback with RAM preview, and renderer performance.

- [ ] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/export.md
  EXPECT: LINT OK

- [ ] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN

- [ ] G2: Render Queue items exported in headless Edge are correct files: PNG sequences in a zip equal the renderer's frames byte for byte (RGB matted over the comp background, RGB+Alpha straight, Full/Half/Third resolution, sequential frame numbers); H.264 MP4 and VP9 WebM, demuxed in Node and decoded with VideoDecoder, reach PSNR of at least 35 dB on every frame both against the frame's ideal BT.709 4:2:0 round trip (codec loss) and on the frame's flat areas (colour matrix and range; a control proves a BT.601 or full-range misreading of the same video fails), with the right frame count, duration, frame rate (24 and 29.97 fps), size (H.264 cropped to even) and BT.709 colour signalling; VP9 WebM alpha decoded from its BlockAdditional stream reaches 35 dB in alpha and premultiplied colour; every file plays in a <video> element at the right duration and size with flat areas at 35 dB per frame and alpha at 30 dB; Stop ends a render as User Stopped and discards the file; H.264 and VP9 encoding is reported supported by VideoEncoder.isConfigSupported
  CHECK: node scripts/export-report.ts --require
  EXPECT: EXPORT-PASSED

- [ ] G3: playback shows the Preview panel's range (work area, extended by the current time, from the current time) one comp frame per slot, spaced by Frame Rate and Skip, looping or ending after one pass; the RAM preview cache keeps frames within its byte budget, evicts least recently used frames, reports cached ranges for the green bar and empties on invalidate(); render target pools keep a frame's working set for the next frame and drop sizes frames stopped using
  CHECK: npx vitest run tests/playback.test.ts
  EXPECT: /Test Files\s+1 passed/

- [ ] G4: Composition > Add to Render Queue (and Ctrl+M) puts the active comp in the Render Queue panel as Queued with Best Settings and an H.264 output named after the comp; the Render Settings and Output Module dialogs change resolution, time span, format and channels; unchecking Render unqueues the item
  CHECK: npx vitest run tests/render-queue.test.tsx
  EXPECT: /Test Files\s+1 passed/

- [ ] G5: the viewer render path of the heaviest corpus comps is at least twice as fast in total as at base commit 13ddece under swiftshader, no comp is more than 10 percent and 1 ms slower, and frames rendered with warm content caches equal frames rendered with cleared caches
  CHECK: node scripts/perf-report.ts --frames 24 --require
  EXPECT: PERF-PASSED

- [ ] G6: the WebGL renderer still reproduces After Effects' renders of the fixture comps under the full pixel criterion (at most 0.1 percent of non-edge pixels off by more than 3/255, mean error at most 1/255)
  CHECK: node scripts/pixel-report.ts --require
  EXPECT: PIXELS-PASSED

- [ ] G7: loading a sample .aep in the inspector UI still renders its composition, a layer and a transform property
  CHECK: npx vitest run tests/ui.test.tsx
  EXPECT: /Test Files\s+1 passed/

- [ ] G8: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/
