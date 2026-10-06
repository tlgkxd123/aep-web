# Gates: fxextra - Keylight, CC Vignette, Remove Color Matting, Minimax, Superpose 2, Sound Keys, Particular and effects whose plugins are not installed

OWNS: src/render/effects/keylight.ts, src/render/effects/keylightMath.ts, src/render/effects/vignette.ts, src/render/effects/removeColorMatting.ts, src/render/effects/minimax.ts, src/render/effects/superpose.ts, src/render/effects/soundKeys.ts, src/render/effects/particular.ts, src/render/effects/missingPlugins.ts, src/render/effects/fxextraUtil.ts, src/render/features.ts, src/render/registry.ts, src/render/renderer.ts, scripts/render-refs.ts, scripts/fxextra-*.ts, scripts/tif2png.ts, scripts/layer-flags.ts, scripts/fixtures/build_fxextra.py, scripts/fixtures/probe_project_fx.py, refs/fixtures/fxextra.*, refs/fixtures/effect-donors.json, refs/frames/fxextra_*/**, gates/fxextra.md

Scope: the renderer draws Keylight 906, CC Vignette, Remove Color Matting, Minimax and Superpose 2 the way aerender does, skips effects whose plugins are not installed as After Effects does (with a warning, look-alikes only behind Renderer.options.approximateMissingPlugins), and draws measured look-alikes of Sound Keys and Particular that are kept out of the pixel gate, without regressing any other suite in this worktree.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/fxextra.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=df9cc8bc95fba0693ea7b78ae8cff269b6ad9903143a192fcf41d4b67ca128c4; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\fx-extra; path=a39720789bd5/52 entries

- [x] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN
  EVIDENCE: automatic-evidence=v1; definition-sha256=57dc83bb9816e14468e084c3ab9458f41fc7eafc53dc20cf5ca0402ff1ad7978; exit=0; EXPECT=matched; output-sha256=76d5b239b071ba8554562df3eb886f8aa0f98c7a2286fa89e34313077236fe4e; output-bytes=17; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\fx-extra\gates; path=a39720789bd5/52 entries

- [x] G4: the inspector UI smoke test passes
  CHECK: npx vitest run tests/ui.test.tsx
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=5d97d6296cee67cea0f05c2097f1f7f05ee00d17ba68762ed619f24d34fa3cb4; exit=0; EXPECT=matched; output-sha256=cad4d0e9eadd73a332206c69dbdc64e089305cd4ab1551409e25f6559fc3cb05; output-bytes=482; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\fx-extra; path=a39720789bd5/52 entries

- [x] G5: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/
  EVIDENCE: automatic-evidence=v1; definition-sha256=202b6423274a1e776d6ddcc8d133917c5c706a45d1cd69c285f24b4a854abbd3; exit=0; EXPECT=matched; output-sha256=a17c1129620d0d0c9ea96210802f59528bf73ee33da3d23812c09c566fa505f7; output-bytes=683; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\fx-extra; path=a39720789bd5/52 entries

- [x] G8: every reference frame of every suite in this worktree (core, controls and fxextra) passes the pixel criterion
  CHECK: node scripts/pixel-report.ts --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=d39fdd94aaf37d79878057159acf5f38c2f641713e9825c851973de9114d8a3b; exit=0; EXPECT=matched; output-sha256=d54e485749de028ade019915817707c3147ca72dbbcfbbccadffb5d6751f3f7a; output-bytes=10534; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\fx-extra; path=a39720789bd5/52 entries

- [x] X1: Keylight 906 (screen colours, balance, gain, clip black/white, Soft Colour replace, Screen Matte / Intermediate / Final Result views, Unpremultiply Result off, Source Alpha Ignore, partly transparent sources) matches aerender
  CHECK: node scripts/pixel-report.ts --suite fxextra --only fxextra_keylight_red,fxextra_keylight_colours,fxextra_keylight_mattes,fxextra_keylight_controls,fxextra_keylight_final2,fxextra_keylight_gain,fxextra_keylight_alpha --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=b9e8ef3e37a70620f36d5c653d99d8901c9fd23bec57c36158941794f02d821c; exit=0; EXPECT=matched; output-sha256=dcb202fb8ff32d42ebf626d92d6493a56009ba72d75745714b2661f34a3ea532; output-bytes=1082; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\fx-extra; path=a39720789bd5/52 entries

- [x] X2: CC Vignette (amount up to 166, angle of view, centre, layer sizes and rotation, untouched default centre, Pin Highlights 25-100) matches aerender
  CHECK: node scripts/pixel-report.ts --suite fxextra --only fxextra_vignette_white,fxextra_vignette_palette,fxextra_vignette_sizes,fxextra_vignette_pin,fxextra_vignette_pin2 --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=ec5489f343e379c5dea006b015bccfba79b91a52b86838450d2849766faf8a03; exit=0; EXPECT=matched; output-sha256=feaeb46d9a98f82d9855dad71becc9ff2196332d00925a6e2ef094b7564af68b; output-bytes=901; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\fx-extra; path=a39720789bd5/52 entries

- [x] X3: Remove Color Matting over several background colours matches aerender
  CHECK: node scripts/pixel-report.ts --suite fxextra --only fxextra_rcm --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=03882f96760b3ebb9aa696e7f6049a1106d030d99f92a2d52d416a7d485d6226; exit=0; EXPECT=matched; output-sha256=9b631a9fdf29d69d6d18d14a33e4c4081e22ba1cd78145fef5f0e08e97035a3c; output-bytes=541; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\fx-extra; path=a39720789bd5/52 entries

- [x] X4: Minimax (min, max, min-then-max, max-then-min; every channel choice; both, horizontal and vertical directions; fractional radii; Don't Shrink Edges) matches aerender
  CHECK: node scripts/pixel-report.ts --suite fxextra --only fxextra_minimax_a,fxextra_minimax_b,fxextra_minimax_c --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=a7ad9fcd5ad217a081cee4d92a357665dce0fedc07775f5942421132042b535f; exit=0; EXPECT=matched; output-sha256=7708dc0520d3ea3fd46f61c986f518695ec333ba14872aae8075bdac28e8b478; output-bytes=721; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\fx-extra; path=a39720789bd5/52 entries

- [x] X5: Superpose 2 on still and moving content (start/end range, every n-th frame, divergence and rating) matches aerender on every sampled frame
  CHECK: node scripts/pixel-report.ts --suite fxextra --only fxextra_superpose,fxextra_superpose_sweep --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=1bf511dea668a00098694cd76afff68a0f70e70181072f92d2f1e4fa5d4ccfe1; exit=0; EXPECT=matched; output-sha256=58c4464dc1275504653ad8f599c1edce1758b553025a0eddbd64ca35a7d0d3a8; output-bytes=1624; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\fx-extra; path=a39720789bd5/52 entries

- [x] X6: layers with XMult, S_Blur, S_Glow, S_Shake, S_ZGlow and S_Flicker render as aerender renders them without the plugins, and each reports "<effect> plugin is not installed; After Effects skips it"
  CHECK: node scripts/pixel-report.ts --suite fxextra --only fxextra_missing_xmult,fxextra_missing_sblur,fxextra_missing_sglow,fxextra_missing_sshake,fxextra_missing_szglow,fxextra_missing_sflicker --require
  EXPECT: /^(?=[\s\S]*XMult plugin is not installed; After Effects skips it)(?=[\s\S]*Sapphire S_Blur plugin is not installed; After Effects skips it)(?=[\s\S]*Sapphire S_Glow plugin is not installed; After Effects skips it)(?=[\s\S]*Sapphire S_Shake plugin is not installed; After Effects skips it)(?=[\s\S]*Sapphire S_ZGlow plugin is not installed; After Effects skips it)(?=[\s\S]*Sapphire S_Flicker plugin is not installed; After Effects skips it)[\s\S]*PIXELS-PASSED/
  EVIDENCE: automatic-evidence=v1; definition-sha256=9389df49d75cc069d79fe42bd9d784a1eb6b4368cd77358ff9896b0742e5337e; exit=0; EXPECT=matched; output-sha256=560e17c20b896d403071d4f6e0dfeb62e1392f38645219c6512978197a8f6566; output-bytes=1706; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\fx-extra; path=a39720789bd5/52 entries

- [x] X7: the whole fxextra suite passes the pixel criterion
  CHECK: node scripts/pixel-report.ts --suite fxextra --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=33bdcddc49d58a07ac8be26c99375ab95cf23d19404c18932e6b30e74e76c17e; exit=0; EXPECT=matched; output-sha256=11cb1799660cd17d1e74eb98345b96d64f294cadabebc65340daaf785506904b; output-bytes=4320; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\fx-extra; path=a39720789bd5/52 entries

- [x] X8: the Sound Keys and Particular look-alikes are measured against their aerender references on every listed frame (they are approximations outside the pixel gate)
  CHECK: node scripts/fxextra-approx-report.ts
  EXPECT: /^(?=[\s\S]*fxextra_soundkeys@0: drawn px)(?=[\s\S]*fxextra_soundkeys@12: drawn px)(?=[\s\S]*fxextra_particular_real@24: drawn px)(?=[\s\S]*fxextra_particular_real@96: drawn px)(?=[\s\S]*fxextra_particular_white@24: drawn px)(?=[\s\S]*fxextra_particular_white@96: drawn px)[\s\S]*fxextra_particular_blob@12: drawn px/
  EVIDENCE: automatic-evidence=v1; definition-sha256=448d86c5f07c0abd330ff2979b6cffcb6e58b851f14d7ba3077d6bbc490ddf21; exit=0; EXPECT=matched; output-sha256=09220e45efaaca467d18ec349e29f0b54537c9d5ab15fde417e7ff4e9e8b602c; output-bytes=2686; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-wt\fx-extra; path=a39720789bd5/52 entries
