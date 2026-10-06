# Gates: fxmisc - Audio Spectrum and Polar Coordinates

OWNS: src/render/effects/audioSpectrum.ts, src/render/effects/audioSpectrumAnalysis.ts, src/render/effects/polar.ts, src/media/audio.ts, src/media/mix.ts, src/media/store.ts, src/render/features.ts, scripts/render-refs.ts, scripts/pixel-regression.ts, scripts/audspect-*.ts, scripts/fit-audspect-*.ts, scripts/compare-extent.ts, scripts/diff-map.ts, scripts/effect-params.ts, scripts/ref-block.ts, scripts/ref-profile.ts, scripts/fixtures/build_fxmisc.py, refs/fixtures/fxmisc.*, refs/fixtures/fxmisc_audio/**, refs/frames/fxmisc_*/**, tests/audio.test.ts, gates/fxmisc.md

Scope: the renderer draws Audio Spectrum (ADBE AudSpect) from the Audio Layer's decoded footage audio at that layer's time, and Polar Coordinates, the way aerender does on the fxmisc fixtures (including fixtures with the settings of the user's bass-supreme.aep and TN 2020 2.aep), without losing any frame that passes on master. Deep Glow 2 is out of scope.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/fxmisc.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=db9024825cee38fa0ebcece6deb186f52d59abf1e43a1b6c2363ed9daec00a94; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\audspect; path=a39720789bd5/52 entries

- [x] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN
  EVIDENCE: automatic-evidence=v1; definition-sha256=57dc83bb9816e14468e084c3ab9458f41fc7eafc53dc20cf5ca0402ff1ad7978; exit=0; EXPECT=matched; output-sha256=76d5b239b071ba8554562df3eb886f8aa0f98c7a2286fa89e34313077236fe4e; output-bytes=17; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\audspect; path=a39720789bd5/52 entries

- [x] G4: every vitest suite passes, including footage audio decoding (async, tracked as busy until idle, listeners notified) and the spectrum analysis
  CHECK: npx vitest run
  EXPECT: /Test Files\s+4 passed \(4\)/
  EVIDENCE: automatic-evidence=v1; definition-sha256=2939f2b1537d36176b152706e5a803cb7f01615811f9d1f0a6803d598d34465e; exit=0; EXPECT=matched; output-sha256=b13a4d203257a73a8341767f5b035c77340f0be3e4adda43da57905e403c507c; output-bytes=701; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\audspect; path=a39720789bd5/52 entries

- [x] G5: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/
  EVIDENCE: automatic-evidence=v1; definition-sha256=202b6423274a1e776d6ddcc8d133917c5c706a45d1cd69c285f24b4a854abbd3; exit=0; EXPECT=matched; output-sha256=2fe5749216df2db754a2715eb143bb28d6f1cde3a9a470622414437fbedf3b8c; output-bytes=683; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\audspect; path=a39720789bd5/52 entries

- [x] G8: merging this branch into master loses no frame that passes the pixel criterion on master, over every suite
  CHECK: node scripts/pixel-regression.ts --merge
  EXPECT: /0 lost\)[\s\S]*PIXELS-NOT-REGRESSED/
  EVIDENCE: automatic-evidence=v1; definition-sha256=3b7acc0478b4ffbf6d1b567c4335850c2ec3c789dfc24567019c76e84c8702d5; exit=0; EXPECT=matched; output-sha256=416964e473a2642177031ce1054d954f063ba4af6f5fe073ecb52fc21046745b; output-bytes=138; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\audspect; path=a39720789bd5/52 entries

- [x] X1: Polar Coordinates (rect to polar and polar to rect, interpolation, square, tall and wide layers) matches aerender on every frame
  CHECK: node scripts/pixel-report.ts --suite fxmisc --only fxmisc_polar_grad_r2p,fxmisc_polar_tall_r2p,fxmisc_polar_wide_r2p,fxmisc_polar_bars_r2p,fxmisc_polar_grad_p2r,fxmisc_polar_tall_p2r,fxmisc_polar_wide_p2r,fxmisc_polar_bars_p2r --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=85ee815cdcd9b62d8cddf65cee779edaf655d41ea86d000087ec50a0b32c480e; exit=0; EXPECT=matched; output-sha256=205b41020e481643dd32be536866058cb8336c0d568227ff5a605a2d1e672384; output-bytes=3867; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\audspect; path=a39720789bd5/52 entries

- [x] X2: Audio Spectrum matches aerender on every frame of its feature fixtures: analysis window, offsets, start times, in points, stretch, stereo, precomposed audio, silent audio layers, digital and analog lines and dots on sides A, B and both, mask and polar paths, thickness and softness, Blend Overlapping Colors, Hue Interpolation with Dynamic Hue Phase and Color Symmetry, Composite On Original, Duration Averaging at ordinary Maximum Heights, and the user's projects' settings
  CHECK: node scripts/pixel-report.ts --suite fxmisc --only fxmisc_as_default,fxmisc_as_lobe,fxmisc_as_lobe_long,fxmisc_as_steps,fxmisc_as_two_tones,fxmisc_as_style,fxmisc_as_analog,fxmisc_as_dots,fxmisc_as_bass,fxmisc_as_onset_90,fxmisc_as_onset_200,fxmisc_as_onset_off,fxmisc_as_onset_neg,fxmisc_as_onset_start,fxmisc_as_onset_in,fxmisc_as_onset_stretch,fxmisc_as_stereo,fxmisc_as_precomp,fxmisc_as_prof_t8s0,fxmisc_as_prof_t8s1,fxmisc_as_prof_t8s05,fxmisc_as_prof_t2s1,fxmisc_as_prof_t13s025,fxmisc_as_blend,fxmisc_as_noblend,fxmisc_as_hue,fxmisc_as_hue_plain,fxmisc_as_composite,fxmisc_as_hue_dyn,fxmisc_as_hue_sym,fxmisc_as_hue_both,fxmisc_as_blend_lines,fxmisc_as_noaudio,fxmisc_as_dots_ab,fxmisc_as_gate_90,fxmisc_as_gate_170,fxmisc_as_gate_170_60,fxmisc_as_music,fxmisc_as_mask_a,fxmisc_as_mask_b,fxmisc_as_mask_second,fxmisc_as_polar,fxmisc_as_polar_ab,fxmisc_as_polar_top,fxmisc_as_polar_lines,fxmisc_as_polar_dots,fxmisc_as_user_line,fxmisc_as_user_ring,fxmisc_as_user_polarfx,fxmisc_as_avg,fxmisc_as_avg_sine,fxmisc_as_avg_lobe,fxmisc_as_avg_gate,fxmisc_as_avg_big_music --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=8d30ed5f47925aa2f4ddd7bdd00534d42537f616b8870d18d48d60f7fcfe7354; exit=0; EXPECT=matched; output-sha256=5adc6ceb2b917cd1817fabd6344afb2a7eb16b57c7d1e13f329c16b721eb66c1; output-bytes=44054; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\audspect; path=a39720789bd5/52 entries

- [ ] X3: Audio Spectrum Duration Averaging also matches aerender for pure tones at a Maximum Height of 32000, where After Effects draws tones larger than the fitted model
  CHECK: node scripts/pixel-report.ts --suite fxmisc --only fxmisc_as_avg_big,fxmisc_as_avg_big_gate --require
  EXPECT: PIXELS-PASSED
