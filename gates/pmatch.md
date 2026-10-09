# Gates: pmatch - Extra > Particle Match, a particle world model learned from a reference video

OWNS: src/extra/**, src/render/effects/particleMatch.ts, src/edit/customEffect.ts, src/edit/data/effect-param-templates.json, src/ui/ParticleMatchDialog.tsx, scripts/pmatch-*.ts, scripts/check-pmatch-*.ts, scripts/lib/pmatch-*.ts, tests/particle-match*.test.ts, tests/particle-match*.test.tsx, gates/pmatch.md

Shared files with small focused edits: src/ui/MenuBar.tsx, src/ui/App.tsx, src/ui/styles.css, src/render/features.ts.

Scope: a top-level Extra menu whose Particle Match command analyses a reference video in the browser (GPU particle detection on the non-mirrored half only, tracking, training an audio-conditioned particle world model), then applies a "Particle Match" effect that renders particles statistically matching the reference, unmirrored, reacting to the comp's audio. The effect is stored in the .aep as a plugin effect After Effects reports as missing.

Reference protocol (P5, P6, P12): the Trap Nation "Butterflies" upload (PMATCH_REFERENCE, default %USERPROFILE%/Downloads/William Black & Fairlane - Butterflies (ft. Dia Frampton) - Trap Nation (1080p, h264).mp4; it is not in the repository). Training uses 50-80 s (build into the first drop); evaluation uses the held-out 136-166 s (build into the second drop), driven by the reference's own audio. Reference and model are measured by the same detector and tracker on the source half: the reference as decoded, the model rendered over the reference's per-window temporal median background.

- [ ] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/pmatch.md
  EXPECT: LINT OK

- [ ] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN

- [ ] G4: loading a sample .aep in the inspector UI still renders its composition, a layer and a transform property
  CHECK: npx vitest run tests/ui.test.tsx
  EXPECT: /Test Files\s+1 passed/

- [ ] G5: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/

- [ ] G8: every pixel suite that passed before this work still passes the pixel criterion (fixtures, adjust, boxblur, controls, fxextra, layerops, projectops; deepglow, expr, expr_legacy, footage and fxmisc already failed at the start and essential has no project file)
  CHECK: node scripts/pixel-report.ts --suite fixtures --require && node scripts/pixel-report.ts --suite adjust --require --no-build && node scripts/pixel-report.ts --suite boxblur --require --no-build && node scripts/pixel-report.ts --suite controls --require --no-build && node scripts/pixel-report.ts --suite fxextra --require --no-build && node scripts/pixel-report.ts --suite layerops --require --no-build && node scripts/pixel-report.ts --suite projectops --require --no-build && echo SUITES-PASSED
  EXPECT: SUITES-PASSED

- [ ] P1: the menu bar has an Extra menu between Window and Help; its Particle Match... item is disabled without a project and opens the Particle Match dialog with one, whose Analyze & Train stays disabled until a reference video is chosen
  CHECK: npx vitest run tests/particle-match-ui.test.tsx
  EXPECT: /Test Files\s+1 passed/

- [ ] P2: the world model's pieces behave as specified: the audio-driven clock integrates monotonically and equals a direct sum, particle sampling is deterministic and follows its learned distributions (KS below 0.05 on 20000 draws), models survive a serialization round trip bit for bit, audio band envelopes put a tone's energy in its band, and the tracker links separated synthetic particles without a swap
  CHECK: npx vitest run tests/particle-match.test.ts
  EXPECT: /Test Files\s+1 passed/

- [ ] P3: on 20 synthetic 1080p frames (stars, soft dots, bokeh discs and pinpoints over a purple gradient with a white logo disc, pink blobs and translucent light-blue shapes, H.264 encoded and decoded), the GPU detector finds at least 90 percent of the particles brighter than 40/255 above their background outside the logo, within 1.5 px, and at least 95 percent of its detections are real particles
  CHECK: node scripts/pmatch-synthetic.ts --detector
  EXPECT: PMATCH-DETECTOR-PASSED

- [ ] P4: on a synthetic left-right mirrored reference rendered from a known model with a known audio-driven clock and zoom pulse (H.264, 20 s, 60 fps), analysis finds the mirror axis within 2 px, trains on the source half only, and recovers the emission rate and median speed within 15 percent, the clock-speed series with correlation at least 0.9, the zoom series with correlation at least 0.8, and every sprite class with a template correlation at least 0.9; rendered on a held-out stretch, the recovered model meets the P5 statistics against the known model
  CHECK: node scripts/pmatch-synthetic.ts --recovery
  EXPECT: PMATCH-RECOVERY-PASSED

- [ ] P5: trained on the reference protocol's training window, the model matches the reference's particles on the held-out window: mean particles per frame within 15 percent, Kolmogorov-Smirnov distance at most 0.15 for brightness, size and distance from the emitter, median radial speed within 25 percent in each radius quartile, the per-0.25 s median speed series correlating at least 0.5 with the reference's, and each learned sprite template correlating at least 0.85 with the reference's mean crop of its class
  CHECK: node scripts/pmatch-report.ts --check match
  EXPECT: PMATCH-REFERENCE-PASSED

- [ ] P6: the effect's output is not mirrored: the correlation between its left half and its flipped right half is at most 0.2, while the reference's is at least 0.9 (both measured on white-residual maps, leaving out 40 px around the axis and the logo mask)
  CHECK: node scripts/pmatch-report.ts --check mirror
  EXPECT: PMATCH-UNMIRRORED

- [ ] P7: the effect rendered through Renderer in headless Edge (real GPU) is deterministic (a frame rendered twice, and after a later frame, is identical), reacts to the comp's audio (particles move at least 1.5 times farther per frame on synthetic kicks than between them), draws its sprites where its particles are, and takes at most 6 ms per 1080p frame with 3000 particles (median of 30 frames)
  CHECK: node scripts/pmatch-effect.ts
  EXPECT: PMATCH-EFFECT-PASSED

- [ ] P8: the effect renders on the GPU only: with readPixels and getImageData instrumented, rendering 30 frames calls neither from the effect, and the effect's modules contain no pixel read-back
  CHECK: node scripts/pmatch-effect.ts --gpu-only
  EXPECT: PMATCH-GPU-ONLY

- [ ] P9: applying Particle Match through the editor writes a plugin effect into the project's chunks (Pefl, EfdG and the layer's Effect Parade): the saved bytes re-parse to the same effect with stored, editable parameters and the same model, a parameter edit survives saving, and undo removes the effect while redo restores it
  CHECK: npx vitest run tests/particle-match-edit.test.ts
  EXPECT: /Test Files\s+1 passed/

- [ ] P10: After Effects 2025 opens a project saved with a Particle Match effect and renders its comp (the layers around the effect still drawn), reporting the effect as missing
  CHECK: node scripts/check-pmatch-ae.ts
  EXPECT: PMATCH-AE-OPENED

- [ ] P11: in the running app (headless Edge, real GPU), Extra > Particle Match... analyses a reference clip, trains, and applies the effect on a new Particle Match layer, after which the composition viewer shows particles and the Effect Controls panel lists the effect's parameters
  CHECK: node scripts/check-pmatch-app.ts
  EXPECT: PMATCH-APP-PASSED

- [ ] P12: analysing and training the 30 s training window of the 1080p60 reference takes at most 180 s on this machine
  CHECK: node scripts/pmatch-report.ts --check time
  EXPECT: PMATCH-TIME-OK
