# Gates: generate2 - more Generate effects

OWNS: src/render/effects/generateExtra.ts, scripts/fixtures/build_generate2.py, refs/fixtures/generate2.*, refs/frames/generate2_*/**, tests/generate2-effects.test.ts, gates/generate2.md, scripts/check-generate2-probe.ts, scripts/check-generate2-fit.ts, scripts/check-generate2-ellipse.ts, scripts/check-generate2-eyedropper.ts, scripts/check-generate2-fractal.ts, scripts/check-generate2-beam.ts, scripts/check-generate2-hue.ts, scripts/check-generate2-sweep.ts, scripts/check-generate2-sweep-fit.ts, scripts/check-generate2-sheet.ts, scripts/check-generate2-edgemap.ts, scripts/check-generate2-profile.ts, scripts/check-generate2-edgefit.ts, scripts/check-generate2-edgedepth.ts

Scope: the Generate effects Checkerboard, Circle, Ellipse, Grid, Beam, Eyedropper Fill and CC Light Sweep render on the GPU from their stored parameters, blended over the layer by their Blending Mode menus as After Effects blends them (over opaque, translucent and empty pixels), with effect points on shape layers measured from the top left of the layer's box, as aerender renders the generate2 fixtures.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/generate2.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=b8ea89dbea7ab5d0593436dee5ea7bd927ae98d3a5e6e8457e9099a01c02069f; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=c1bf81ce0fdf/53 entries

- [x] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN
  EVIDENCE: automatic-evidence=v1; definition-sha256=57dc83bb9816e14468e084c3ab9458f41fc7eafc53dc20cf5ca0402ff1ad7978; exit=0; EXPECT=matched; output-sha256=76d5b239b071ba8554562df3eb886f8aa0f98c7a2286fa89e34313077236fe4e; output-bytes=17; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web\gates; path=c1bf81ce0fdf/53 entries

- [x] N1: every generate2 renderer is registered, reused between frames and drawn at reduced resolutions
  CHECK: npx vitest run tests/generate2-effects.test.ts
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=ab507c219dcf29c6e695994be25433bf4816cc21aede227511434b9c7b66e6f2; exit=0; EXPECT=matched; output-sha256=4926af7e9d4471cfd5a21a704cd44e6e80b8da8b927c4708fa98175424ab28f0; output-bytes=279; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=c1bf81ce0fdf/53 entries

- [x] N2: aerender renders every generate2 comp
  CHECK: node scripts/render-refs.ts --suite generate2 --strict
  EXPECT: ALL-COMPS-RENDERED
  EVIDENCE: automatic-evidence=v1; definition-sha256=ef373e583f822c3355bfbc09ef3ae534f1232e77b6bdfb8eb263a70e4350da40; exit=0; EXPECT=matched; output-sha256=1d18ecbd559d6f3ae6779056f0880835399103261c5461bc9eaf9a58e4f896ed; output-bytes=89; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=c1bf81ce0fdf/53 entries

- [ ] N3: every generate2 fixture frame matches its aerender reference (pixel criterion; accepted approximations within a mean error of 1/255)
  CHECK: set AEP_HARNESS_DIR=dist-harness-generate2&& node scripts/pixel-report.ts --suite generate2 --require
  EXPECT: PIXELS-PASSED
