# Gates: phase 1 - open .aep projects in the browser and inspect them

OWNS: src/**, tests/**, scripts/**, package.json, tsconfig.json, vite.config.ts, index.html, GATES.md

Scope: a TypeScript .aep parser plus a browser inspector that shows project items, compositions, layers, properties, keyframes, effects and raw chunks, checked against After Effects' own ExtendScript exports in the py-aep sample corpus.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs GATES.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=12f9f517d930730d6978ec02f70957bf8eaeb18913cabf18eb5e6125f7a0a6ca; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=a39720789bd5/52 entries

- [x] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN
  EVIDENCE: automatic-evidence=v1; definition-sha256=57dc83bb9816e14468e084c3ab9458f41fc7eafc53dc20cf5ca0402ff1ad7978; exit=0; EXPECT=matched; output-sha256=76d5b239b071ba8554562df3eb886f8aa0f98c7a2286fa89e34313077236fe4e; output-bytes=17; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=a39720789bd5/52 entries

- [x] G2: every .aep file in the sample corpus parses without an exception, and the corpus holds at least 500 files
  CHECK: node scripts/corpus-report.ts --require-parse
  EXPECT: CORPUS-PARSE-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=d246bebbf6a208860b63b66f513506106d44a5ff5b3b657cf64643ee8afa46bd; exit=0; EXPECT=matched; output-sha256=f881d6c74b92d0ddf2d7a0ebadc48650e58f914d4e66dbe69e7c020d37e88433; output-bytes=1133; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=a39720789bd5/52 entries

- [x] G3: parsed items, layers, property values and keyframes agree with the ExtendScript JSON exports (items and layers at least 99.5 percent, property values and keyframes at least 98 percent, every exported layer found)
  CHECK: node scripts/corpus-report.ts --require-match
  EXPECT: CORPUS-MATCH-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=756e21995337b2fdc6735395b65ef8b17dfd1e238350d7c7fd7f519259d991a4; exit=0; EXPECT=matched; output-sha256=a1261db06966c0ace37170abe18df9b9c85ad2dfd4947306ee00e537016f1624; output-bytes=1133; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=a39720789bd5/52 entries

- [x] G4: loading a sample .aep in the inspector UI renders its composition, a layer and a transform property
  CHECK: npx vitest run tests/ui.test.tsx
  EXPECT: /Test Files\s+1 passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=5d97d6296cee67cea0f05c2097f1f7f05ee00d17ba68762ed619f24d34fa3cb4; exit=0; EXPECT=matched; output-sha256=21dc979049d48f4aea2335c72bf4280e16b5e4ee53a7be0c0988b66094297caa; output-bytes=272; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=a39720789bd5/52 entries

- [x] G5: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/
  EVIDENCE: automatic-evidence=v1; definition-sha256=202b6423274a1e776d6ddcc8d133917c5c706a45d1cd69c285f24b4a854abbd3; exit=0; EXPECT=matched; output-sha256=2ea61f41cb7a2019f0c19b4b40a62baeb6de9447648e8c6f5aa544933bddd937; output-bytes=350; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=a39720789bd5/52 entries

- [x] G7: layer world matrices, parenting and camera rays reproduce After Effects' sourcePointToComp and compPointToSource results within 0.005 px (2D, parented, 3D, keyframed layers; one-node, two-node, keyed-zoom and default cameras)
  CHECK: node scripts/geometry-report.ts --require
  EXPECT: GEOMETRY-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=4b34e82f300d4693cb9e63e518082c36fcd0029e340123f8634aa7b7f07c8010; exit=0; EXPECT=matched; output-sha256=959aeba9a49b2640ae544008b93c275d8c8bedb45c7ad4564aef7491a50290e3; output-bytes=71; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=a39720789bd5/52 entries

- [x] G8: the WebGL renderer reproduces After Effects' own renders of the fixture comps (solids, transforms, parenting, animation, blend modes, track mattes, masks, precomps, 3D, cameras): every frame within 3/255 on 99 percent of pixels, except listed known approximations which stay within a mean error of 1/255
  CHECK: node scripts/pixel-report.ts --require
  EXPECT: PIXELS-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=d39fdd94aaf37d79878057159acf5f38c2f641713e9825c851973de9114d8a3b; exit=0; EXPECT=matched; output-sha256=360d53a444f1a1822366dd09ed57a7ac5d2d7248757719e6f74d48b9d34080f2; output-bytes=4418; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=a39720789bd5/52 entries

- [x] G6: valueAtTime reproduces After Effects' per-frame values for every animated property in the value_at_time exports (0.001 tolerance, 0.015 px on motion paths, every property found)
  CHECK: node scripts/vat-report.ts --require
  EXPECT: VALUE-AT-TIME-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=b0696a24cd29dcf19309623752f4de60ef1f2aae38ad9d93a0f973bb8f46625e; exit=0; EXPECT=matched; output-sha256=9dc736f9959188982ac5777f43f5f6c763b4b4627f05bbe3fa01fb852bf0dbe8; output-bytes=129; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=a39720789bd5/52 entries
