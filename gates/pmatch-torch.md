# Gates: pmatch-torch - the Particle Match world model as a PyTorch model

OWNS: ml/pmatch/**, src/extra/pmatch/**, src/render/effects/particleMatch.ts, src/ui/ParticleMatchDialog.tsx, src/ui/particle-match.css, server/pmatch-trainer.ts, vite.config.ts, scripts/pmatch-*.ts, scripts/check-pmatch-*.ts, scripts/lib/pmatch-*.ts, tests/particle-match*.test.ts, tests/data/pmatch-*, tests/particular-layers.test.ts, gates/pmatch-torch.md, AGENTS.md, .gitignore

Scope: the Particle Match world model (audio-driven clock, zoom and shake; particle population; sprites; appearance over depth and life) is defined and trained in PyTorch on the GPU from the browser's analysis of a reference video, exported to the effect's model format and run by the app (effect, preview, Particular layers), with training launched from Extra > Particle Match through the dev server or from the command line. The browser keeps what touches pixels: decoding, particle detection and tracking, sprite crops, the shake measurement, and the calibration by synthesis that renders the trained model through the same detector.

- [ ] T0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/pmatch-torch.md
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

- [ ] T1: the PyTorch modules behave as specified: the flow is invertible with a log-determinant equal to autograd's Jacobian, trained on a known distribution its samples match it (KS below 0.05), the audio TCN keeps the sequence length and reaches exactly its configured receptive field, the batched projective fit recovers known tracks, on synthetic tracks the clock fit recovers a known clock (speed correlation above 0.97 with the early-stopped default, above 0.99 and within 0.05 clock seconds with the joint refinement run to convergence), and an exported model reads back with the same numbers
  CHECK: uv run --project ml/pmatch pytest -q ml/pmatch/tests
  EXPECT: /\d+ passed/

- [ ] T2: the app runs the networks PyTorch exports exactly: for a model PyTorch exports with random weights, the TypeScript TCN reproduces PyTorch's dynamics outputs within 1e-4 over 2000 feature frames, and the decoded sample bank, sprites and curves equal PyTorch's arrays
  CHECK: uv run --project ml/pmatch python -m pmatch parity tests/data/pmatch-parity.json && npx vitest run tests/particle-match-parity.test.ts
  EXPECT: /Test Files\s+1 passed/

- [ ] T3: the runtime pieces behave: the TCN-driven clock integrates monotonically and equals a direct sum of its speeds, a model whose speed follows the bass runs faster on bass, Reactivity 0 gives a constant speed, a model survives encoding and decoding bit for bit, and particle sampling is deterministic
  CHECK: npx vitest run tests/particle-match.test.ts
  EXPECT: /Test Files\s+1 passed/

- [ ] T4: trained by PyTorch on CUDA (the RTX 3070) from the reference protocol's 50-80 s and calibrated in the browser, the model matches the held-out 136-166 s (particles per frame within 15 %, KS at most 0.15 for brightness, size and distance from the emitter, median radial speed within 25 % in each radius quartile, the quarter-second speed series correlating at least 0.5, each sprite template correlating at least 0.85 with the held-out crops most like it) and its output is not mirrored (model mirror correlation at most 0.2, reference at least 0.9)
  CHECK: node scripts/pmatch-report.ts --check torch,match,mirror
  EXPECT: /PMATCH-TORCH-CUDA[\s\S]*PMATCH-REFERENCE-PASSED[\s\S]*PMATCH-UNMIRRORED/

- [ ] T5: analysing the 30 s training window, training the PyTorch model and calibrating it takes at most 180 s on this machine
  CHECK: node scripts/pmatch-train.ts --max-seconds 180
  EXPECT: PMATCH-TIME-OK

- [ ] T6: in the running app (its own dev server, headless Edge), Extra > Particle Match analyses a reference window, trains the PyTorch model through the dev server's trainer (which refuses requests without the page's token) and shows the learned particles, with a report naming PyTorch and the GPU it trained on
  CHECK: node scripts/check-pmatch-ui.ts --serve --from 50 --to 62
  EXPECT: PMATCH-UI-PASSED

- [ ] T7: the Trapcode Particular layers derived from a model still build and save
  CHECK: npx vitest run tests/particular-layers.test.ts
  EXPECT: /Test Files\s+1 passed/

- [ ] T8: the hand-written fitting the PyTorch model replaces is gone from the app: no fitClock, fitDynamics, buildPopulation, stitchTracks, depthExponents or learnSprites remains under src/ (the audit first finds them in the committed fit.ts as its positive control)
  CHECK: node scripts/pmatch-torch-audit.ts
  EXPECT: PMATCH-TS-FIT-REMOVED
