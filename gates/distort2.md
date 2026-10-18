# Gates: distort2 - more Distort effects

OWNS: src/render/effects/distortExtra.ts, scripts/fixtures/build_distort2.py, refs/fixtures/distort2.*, refs/frames/distort2_*/**, tests/distort2-effects.test.ts, gates/distort2.md, scripts/check-distort2-probe.ts, scripts/check-distort2-radial.ts, scripts/check-distort2-row.ts, scripts/check-distort2-bezier.ts

Scope: the Distort effects Spherize, Ripple, Magnify, CC Lens, CC Slant, CC Tiler, CC Power Pin, CC Split, CC Split 2, CC Bender and Bezier Warp render on the GPU from their stored parameters as aerender renders the distort2 fixtures, on a card whose colours encode where each pixel samples it from.

- [ ] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/distort2.md
  EXPECT: LINT OK

- [ ] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN

- [ ] D1: every distort2 renderer is registered with its reuse options (Ripple drawn every frame, the others reused between frames), all rendered at reduced resolutions, and CC Split opens in proportion to Split
  CHECK: npx vitest run tests/distort2-effects.test.ts
  EXPECT: /Test Files\s+1 passed/

- [ ] D2: aerender renders every distort2 comp without reporting a missing effect or an error
  CHECK: node scripts/render-refs.ts --suite distort2 --strict
  EXPECT: ALL-COMPS-RENDERED

- [ ] D3: every distort2 fixture frame matches its aerender reference (pixel criterion; accepted approximations within a mean error of 1/255)
  CHECK: set AEP_HARNESS_DIR=dist-harness-distort2&& node scripts/pixel-report.ts --suite distort2 --require
  EXPECT: PIXELS-PASSED
