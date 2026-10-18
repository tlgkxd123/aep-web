# Gates: channel - Channel and Utility effects

OWNS: src/render/effects/channelUtility.ts, scripts/fixtures/build_channel.py, refs/fixtures/channel.*, refs/frames/channel_*/**, tests/channel-effects.test.ts, gates/channel.md, scripts/check-channel-probe.ts, scripts/check-channel-fit.ts, scripts/check-channel-diff.ts

Scope: the Channel and Utility effects Set Channels, Channel Combiner, Arithmetic, Compound Arithmetic, Blend, Calculations, Solid Composite, CC Composite, Grow Bounds, Cineon Converter, CC Overbrights, HDR Compander and HDR Highlight Compression render on the GPU from their stored parameters, reading second layers through layer parameters; the channel fixtures (cards of scattered colours with partly transparent rows and empty cells, second layers of another size) render as aerender renders them.

- [ ] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/channel.md
  EXPECT: LINT OK

- [ ] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN

- [ ] C1: every channel and utility renderer is registered; those reading other layers or the layer's source are drawn every frame, the rest reused between frames, all rendered at reduced resolutions
  CHECK: npx vitest run tests/channel-effects.test.ts
  EXPECT: /Test Files\s+1 passed/

- [ ] C2: aerender renders every channel comp
  CHECK: node scripts/render-refs.ts --suite channel --strict
  EXPECT: ALL-COMPS-RENDERED

- [ ] C3: every channel fixture frame matches its aerender reference (pixel criterion; accepted approximations within a mean error of 1/255)
  CHECK: set AEP_HARNESS_DIR=dist-harness-channel&& node scripts/pixel-report.ts --suite channel --require
  EXPECT: PIXELS-PASSED
