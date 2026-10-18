# Gates: stylize2 - Stylize effects beyond stylize.ts

OWNS: src/render/effects/stylizeExtra.ts, scripts/fixtures/build_stylize2.py, refs/fixtures/stylize2.*, refs/frames/stylize2_*/**, tests/stylize2-effects.test.ts, gates/stylize2.md, scripts/check-stylize2*.ts

Scope: CC Threshold, CC Threshold RGB, Strobe Light, Find Edges, Emboss, Color Emboss, CC RepeTile (every tiling but Random, with Blend Tiles), CC Kaleida, CS HexTile (without Lock Center Tile), CS BlockLoad and Texturize render on the GPU from their stored parameters as aerender renders the stylize2 fixtures. Scatter, Roughen Edges, Brush Strokes, CC Burn Film and RepeTile's Random tiling follow After Effects' own random generator and noise: they render as look-alikes, kept out of the pixel gate in refs/fixtures/stylize2.approximations.json with their reasons, as are the references of CC Glass, CC Plastic, Cartoonify and CC Mr. Smoothie, which have no renderer yet.

- [ ] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/stylize2.md
  EXPECT: LINT OK

- [ ] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN

- [ ] Y1: every stylize2 renderer is registered with its reuse options, and Strobe Light strobes on After Effects' frames
  CHECK: npx vitest run tests/stylize2-effects.test.ts
  EXPECT: /Test Files\s+1 passed/

- [ ] Y2: aerender renders every stylize2 comp
  CHECK: node scripts/render-refs.ts --suite stylize2 --strict
  EXPECT: ALL-COMPS-RENDERED

- [ ] Y3: every stylize2 fixture frame matches its aerender reference (pixel criterion; accepted approximations within a mean error of 1/255)
  CHECK: set AEP_HARNESS_DIR=dist-harness-stylize2&& node scripts/pixel-report.ts --suite stylize2 --require
  EXPECT: PIXELS-PASSED
