# Gates: adjust - adjustment layers

OWNS: src/render/renderer.ts, src/render/shaders.ts, scripts/fixtures/build_adjust.py, refs/fixtures/adjust.*, refs/frames/adjust_*/**, gates/adjust.md

Scope: an adjustment layer applies its effects to the composite of the layers below it, in comp pixels, where its source's alpha and masks are, mixed in by its opacity (and track matte), without affecting layers above it, the way aerender renders it.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/adjust.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=39938f951b2c4a39bdb5f35ec91f17ad173039b67800f8ef58290ff9fc720672; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN
  EVIDENCE: automatic-evidence=v1; definition-sha256=57dc83bb9816e14468e084c3ab9458f41fc7eafc53dc20cf5ca0402ff1ad7978; exit=0; EXPECT=matched; output-sha256=76d5b239b071ba8554562df3eb886f8aa0f98c7a2286fa89e34313077236fe4e; output-bytes=17; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web\gates; path=92add6e87031/53 entries

- [x] A1: every adjustment-layer fixture frame (full frame, above, opacity, masked, feathered, scaled and rotated, over transparency, without effects, stacked) matches its aerender reference
  CHECK: node scripts/pixel-report.ts --suite adjust --require
  EXPECT: /frames: 10, passing: 10 \(10 with/
  EVIDENCE: automatic-evidence=v1; definition-sha256=d489e9a0d495b267116f0123ef16970af000253c1fc020ba0aa2b47a64961ca1; exit=0; EXPECT=matched; output-sha256=7efc4bac73a1ba20f60ba461298d6c47708f856a240cf7112cbe2f80265ddd19; output-bytes=1167; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] A2: the core fixture suite still matches aerender with adjustment layers composited
  CHECK: node scripts/pixel-report.ts --suite fixtures --require --no-build
  EXPECT: /frames: 68, passing: 68/
  EVIDENCE: automatic-evidence=v1; definition-sha256=eb76564e61ff94a8f20510e1c6f9075ae6d43094cc67cc47be697e5fc1adbc03; exit=0; EXPECT=matched; output-sha256=3b79b4dedccf17ca5e7fbe8b80b234231309a0df30091a3369a2b00fc8d26378; output-bytes=6388; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries
