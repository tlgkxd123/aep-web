# Gates: playback - 60 fps preview with continuous audio

OWNS: src/playback/**, src/media/audioPreview.ts, src/media/store.ts, src/media/video.ts, src/media/videoWorker.ts, src/media/openVideo.ts, src/media/mix.ts, src/render/effects/audioSpectrum.ts, src/render/effects/audioSpectrumAnalysis.ts, src/render/effects/spectrumWorker.ts, src/render/effects/spectrumPrefetch.ts, scripts/check-video-playback.ts, scripts/bench-spectrum.ts, tests/playback.test.ts, tests/audio-preview.test.ts, gates/playback.md

Scope: the user's real project (Downloads/Trap nation v9.2.aep, 1920x1080 at 60 fps: nine Audio Spectrums over a 750-band analysis, two time-remapped 1080p60 H.264 movies, Deep Glow, Keylight, S_Blur) previews in the dev-server app at the comp's 60 fps on this machine (RTX 3070 laptop) without a RAM cache, and its audio plays without a break while the picture keeps up or falls behind; rendering stays pixel-identical.

- [ ] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/playback.md
  EXPECT: LINT OK

- [ ] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN

- [ ] G4: the UI smoke test and the playback and audio preview tests pass
  CHECK: npx vitest run tests/ui.test.tsx tests/playback.test.ts tests/audio-preview.test.ts
  EXPECT: /Test Files\s+3 passed/

- [ ] G5: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/

- [ ] P1: "Render This" (the comp the user renders) plays from 0:00:30 for 10 s showing at least 58 of the comp's 60 frames per second on a first pass (nothing cached), every shown frame complete
  CHECK: node scripts/check-video-playback.ts "C:/Users/schxm/Downloads/Trap nation v9.2.aep" "Render This" 10 30 --serve --require-fps 58
  EXPECT: /PLAYBACK-FPS-OK[\s\S]*frames shown while footage was loading: 0 sampled, 0 of the frames shown/

- [ ] P2: during that playback the song plays as one uninterrupted stream (started once, never stopped or restarted until playback stops) and stays within 2 frames of the picture
  CHECK: node scripts/check-video-playback.ts "C:/Users/schxm/Downloads/Trap nation v9.2.aep" "Render This" 10 30 --serve --require-audio
  EXPECT: /AUDIO-CONTINUOUS-OK starts=1 stops=0/

- [ ] P3: with the CPU slowed down 6x, so the picture cannot keep up, the audio still plays without a break and the picture stays in sync with it (frames are dropped instead)
  CHECK: node scripts/check-video-playback.ts "C:/Users/schxm/Downloads/Trap nation v9.2.aep" "Render This" 8 30 --serve --throttle 6 --require-audio
  EXPECT: /AUDIO-CONTINUOUS-OK starts=1 stops=0/

- [ ] P4: the spectrum and particles comps the user works in also preview at 58+ fps (Glow Spectrum, Pre-comp 2, Particles)
  CHECK: node scripts/check-video-playback.ts "C:/Users/schxm/Downloads/Trap nation v9.2.aep" "Glow Spectrum,Pre-comp 2,Particles" 6 30 --serve --require-fps 58
  EXPECT: /^(?=[\s\S]*Glow Spectrum: PLAYBACK-FPS-OK)(?=[\s\S]*Pre-comp 2: PLAYBACK-FPS-OK)[\s\S]*Particles: PLAYBACK-FPS-OK/

- [ ] P5: spectra the workers compute while the user's project plays are bit-identical to the same spectra computed on the main thread (a quarter of them rechecked)
  CHECK: node scripts/check-video-playback.ts "C:/Users/schxm/Downloads/Trap nation v9.2.aep" "Render This" 6 30 --serve --verify-spectra
  EXPECT: /SPECTRA-IDENTICAL verified=([1-9]\d{2,}) mismatches=0/

- [ ] P6: Audio Spectrum, footage and the core fixtures still match aerender as before (same pass counts as the master baseline: fxmisc 511+, footage 296+, fixtures 68)
  CHECK: node scripts/pixel-report.ts --suite fxmisc && node scripts/pixel-report.ts --suite footage --no-build && node scripts/pixel-report.ts --suite fixtures --require --no-build
  EXPECT: /^(?=[\s\S]*frames: 526, passing: 5(1[1-9]|2[0-6]))(?=[\s\S]*frames: 298, passing: 29[6-8])[\s\S]*frames: 68, passing: 68/
