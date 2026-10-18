# Gates: color2 - more Color Correction effects

OWNS: src/render/effects/colorExtra.ts, src/render/effects/colorExtraMath.ts, scripts/fixtures/build_color2.py, scripts/check-color2*.ts, refs/fixtures/color2.*, refs/frames/color2_*/**, tests/color2-effects.test.ts, gates/color2.md

Scope: the Color Correction effects registered by src/render/effects/colorExtra.ts (listed in COLOR2_EFFECTS) render on the GPU from their stored parameters as aerender renders the color2 fixtures, which show each of them on a textured card and on an alpha-edged star with non-default settings.

- [ ] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/color2.md
  EXPECT: LINT OK

- [ ] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN

- [ ] C1: every color2 effect is registered as cacheable and scalable
  CHECK: npx vitest run tests/color2-effects.test.ts
  EXPECT: /Test Files\s+1 passed/

- [ ] C2: aerender renders every color2 comp
  CHECK: node scripts/render-refs.ts --suite color2 --strict
  EXPECT: ALL-COMPS-RENDERED

- [ ] C3: every color2 fixture frame matches its aerender reference (pixel criterion; accepted approximations within a mean error of 1/255)
  CHECK: set AEP_HARNESS_DIR=dist-harness-color2&& node scripts/pixel-report.ts --suite color2 --require
  EXPECT: PIXELS-PASSED
