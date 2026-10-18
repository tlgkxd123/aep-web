# Gates: blurnoise - Blur & Sharpen and Noise & Grain effects

OWNS: src/render/effects/blurNoise.ts, scripts/fixtures/build_blurnoise.py, scripts/check-blurnoise-probe.ts, scripts/check-blurnoise-diff.ts, scripts/check-blurnoise-kernel.ts, scripts/check-blurnoise-bilateral.ts, scripts/check-blurnoise-ladder.ts, refs/fixtures/blurnoise.*, refs/frames/blurnoise_*/**, tests/blurnoise-effects.test.ts, gates/blurnoise.md

Scope: Channel Blur, CC Cross Blur, Median, Dust & Scratches and Camera Lens Blur (Shape, Roundness, Aspect Ratio, Rotation, Repeat Edge Pixels, Use "Linear" Working Space) render as aerender renders the blurnoise fixtures. CC Radial Fast Blur, CC Radial Blur, CC Vector Blur, Compound Blur, Bilateral Blur and Smart Blur have GPU renderers that do not match After Effects yet, and Noise Alpha, Noise HLS, Noise HLS Auto, Turbulent Noise and Add Grain are seeded look-alikes of After Effects' random generators: aerender renders their comps (refs/fixtures/blurnoise.approximations.json, with the reason for each), but they are not held to the pixel criterion.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/blurnoise.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=ecea3db4a06e2d66a6d195d375d5d78feefad5393bae5acaaa8ed3cd1b27aea2; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=c1bf81ce0fdf/53 entries

- [x] G1: strict TypeScript reports no error in the blurnoise files
  CHECK: npx tsc --noEmit 2>&1 | findstr /i "blurnoise" || echo BLURNOISE-TYPECHECK-CLEAN
  EXPECT: BLURNOISE-TYPECHECK-CLEAN
  EVIDENCE: automatic-evidence=v1; definition-sha256=4714c36a1e4f8d5ce5319d3375cc75801810eacdc65a10a48ef7d380e29fc9de; exit=0; EXPECT=matched; output-sha256=776f4032221bc5fae23b4c6584caeab0d7e779b56beac0d810a64ec125e4c819; output-bytes=27; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web\gates; path=c1bf81ce0fdf/53 entries

- [x] B1: every blurnoise renderer is registered with its reuse options
  CHECK: npx vitest run tests/blurnoise-effects.test.ts
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=bde7672410e84ce0176d40a846ac9977dbfd90e9e73270339d940e3ebedbe516; exit=0; EXPECT=matched; output-sha256=371d01bdd246f38673412f2e56a3cadc02185315d4d2508f12ea5bd8a5aac681; output-bytes=280; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=c1bf81ce0fdf/53 entries

- [ ] B2: aerender renders every blurnoise comp, the approximations and unmatched effects included
  CHECK: node scripts/render-refs.ts --suite blurnoise --strict
  EXPECT: ALL-COMPS-RENDERED

- [x] B3: every gated blurnoise fixture frame matches its aerender reference (pixel criterion; accepted approximations within a mean error of 1/255)
  CHECK: set AEP_HARNESS_DIR=dist-harness-blurnoise&& node scripts/pixel-report.ts --suite blurnoise --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=c256a90c49a11a64b708ae4e1ef5a9ff80147947e9c4b8ac4479628409085c3a; exit=0; EXPECT=matched; output-sha256=d635d4e05971a01baa57dc6a6ff1b582c21f568e048202bc394716279766f4ba; output-bytes=8277; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=c1bf81ce0fdf/53 entries
