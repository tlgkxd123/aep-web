# Gates: stockfx - stock After Effects effects

OWNS: src/render/effects/stockUtil.ts, src/render/effects/stockMath.ts, src/render/effects/colorCorrection.ts, src/render/effects/blurSharpen.ts, src/render/effects/distort.ts, src/render/effects/transitions.ts, src/render/effects/stylize.ts, src/render/effects/matte.ts, scripts/check-stock-effects.ts, scripts/fixtures/build_stockfx.py, refs/fixtures/stockfx.*, refs/frames/stockfx_*/**, tests/stock-effects.test.ts, gates/stockfx.md

Scope: the stock effects Tint, Tritone, Brightness & Contrast (and legacy), Exposure, Hue/Saturation, Color Balance (HLS), Channel Mixer, Black & White, Levels, Invert, Posterize, Threshold (and legacy), Shift Channels, Gaussian Blur (and legacy, Fast Blur), Directional Blur, Sharpen, Unsharp Mask, Transform, Offset, Corner Pin, Motion Tile, Linear Wipe, Radial Wipe, Venetian Blinds, Drop Shadow, Glow, Mosaic, Noise, Fill, Set Matte and Simple Choker render on the GPU from their stored parameters; those whose definitions a project After Effects saved holds render as aerender renders the stockfx fixtures.

- [ ] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/stockfx.md
  EXPECT: LINT OK

- [ ] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN

- [ ] S1: every stock renderer is registered with its reuse options, and the math they share behaves as the effects describe
  CHECK: npx vitest run tests/stock-effects.test.ts
  EXPECT: /Test Files\s+1 passed/

- [ ] S2: in a browser, every stock renderer compiles and draws without warnings, identity parameters leave the frame unchanged, the per-pixel colour effects match their formulas, and half resolution stays close to full
  CHECK: node scripts/check-stock-effects.ts
  EXPECT: STOCK-EFFECTS-OK

- [ ] S3: aerender renders every stockfx comp
  CHECK: node scripts/render-refs.ts --suite stockfx --strict
  EXPECT: ALL-COMPS-RENDERED

- [ ] S4: every stockfx fixture frame matches its aerender reference (pixel criterion; accepted approximations within a mean error of 1/255)
  CHECK: node scripts/pixel-report.ts --suite stockfx --require
  EXPECT: PIXELS-PASSED

- [ ] S5: nothing regressed: the core, adjust and fxextra pixel suites pass
  CHECK: node scripts/pixel-report.ts --suite fixtures --require --no-build && node scripts/pixel-report.ts --suite adjust --require --no-build && node scripts/pixel-report.ts --suite fxextra --require --no-build && echo NO-REGRESSION
  EXPECT: NO-REGRESSION
