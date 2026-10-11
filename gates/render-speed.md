# Gates: render speed - 30+ fps preview of the user's project

OWNS: src/render/**, src/playback/**, src/ui/CompositionPanel.tsx, scripts/check-video-playback.ts, scripts/profile-render.ts, scripts/check-render-cache.ts, scripts/check-render-scale.ts, scripts/lib/harness-page.ts, scripts/pixel-regression.ts, scripts/comp-tree.ts, scripts/trace-summary.ts, scripts/probe-gpu.ts, tests/render-cache.test.ts, gates/render-speed.md

Scope: "Render This" in the user's project (Downloads/Trap nation v9.2.aep, 1920x1080 at 60 fps) previews in the dev-server app at 30+ fps on this laptop's integrated GPU (Intel UHD, which the user's Chrome uses) and on its discrete GPU (RTX 3070), first pass with nothing cached, the sound unbroken and the UI responsive; frames rendered with the new frame-to-frame caches are bit-identical to frames rendered without them, reduced resolutions match the full render, and no After Effects match is lost.

- [x] G0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/render-speed.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=edd99a830effb296a4e3795b22cede4304cab5a573bc2d73d1b90512ad709f63; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN
  EVIDENCE: automatic-evidence=v1; definition-sha256=57dc83bb9816e14468e084c3ab9458f41fc7eafc53dc20cf5ca0402ff1ad7978; exit=0; EXPECT=matched; output-sha256=76d5b239b071ba8554562df3eb886f8aa0f98c7a2286fa89e34313077236fe4e; output-bytes=17; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web\gates; path=92add6e87031/53 entries

- [x] G4: the UI smoke test, the playback tests and the render cache unit tests pass
  CHECK: npx vitest run tests/ui.test.tsx tests/playback.test.ts tests/audio-preview.test.ts tests/render-cache.test.ts
  EXPECT: /Test Files\s+4 passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=fa2f45c74cf853a53e1f962c4a04ed4780421c0365fa50617f25f68938a1e1e6; exit=0; EXPECT=matched; output-sha256=911c31871690deb139ab524b89f6875a61568319440170b241f26f8311c205f5; output-bytes=516; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] G5: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/
  EVIDENCE: automatic-evidence=v1; definition-sha256=202b6423274a1e776d6ddcc8d133917c5c706a45d1cd69c285f24b4a854abbd3; exit=0; EXPECT=matched; output-sha256=e2197b4a3b347ed95bf4ce6aa9fbf195797a8d96fa3d1a3a942786323a552b5d; output-bytes=1044; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] C1: 90 consecutive frames of "Render This" from 0:30 (and 60 from the start of "Glow Spectrum" and "Pre-comp 2") rendered with the frame caches equal, pixel for pixel, the same frames rendered by a renderer without them, and the caches served a share of the layers
  CHECK: node scripts/check-render-cache.ts "C:/Users/schxm/Downloads/Trap nation v9.2.aep" "Render This@30:90,Glow Spectrum@0:60,Pre-comp 2@0:60" --require
  EXPECT: /^(?=[\s\S]*Render This: CACHE-IDENTICAL frames=90 [^\n]*hits=[1-9])(?=[\s\S]*Glow Spectrum: CACHE-IDENTICAL frames=60)[\s\S]*Pre-comp 2: CACHE-IDENTICAL frames=60/
  EVIDENCE: automatic-evidence=v1; definition-sha256=5d24ae0f96ef5a45c63dd73534a7ffcec0222749a7a908d31c247db1cb691180; exit=0; EXPECT=matched; output-sha256=756a95e8e9a58afec84494472ede8539365def3b35c4917c31e0d3217e5f244b; output-bytes=355; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] C2: no frame of any fixture suite that matches After Effects on master stops matching here (every suite whose project file exists, rendered in both trees)
  CHECK: node scripts/pixel-regression.ts
  EXPECT: PIXELS-NOT-REGRESSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=c1640a20f7fe5ad2469dca78ed74b50d1d5c018d0098be8450985d33ab601196; exit=0; EXPECT=matched; output-sha256=6338db26cb86c1f2d4632e80780db6c5a5826a061607a92e715a6f19e71ab06c; output-bytes=468; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] S1: at Half, Third and Quarter resolution the user's spectrum, glow, movie and particle comps match their full-resolution render averaged down (mean error at most 0.5/255, at most 1% of pixels off by more than 24)
  CHECK: node scripts/check-render-scale.ts "C:/Users/schxm/Downloads/Trap nation v9.2.aep" "Glow Spectrum@10,Pre-comp 2@30,Audio Spectrum  Glow@30,Audio Spectrum Comp 1@30,Intro@30,Particles@30" --factors 2,3,4 --max-mean 0.5 --max-gross 0.01 --require
  EXPECT: SCALE-ALL-MATCH frames=6 factors=2,3,4
  EVIDENCE: automatic-evidence=v1; definition-sha256=846501d5b55921354e2793dbe04463c4edd8bcc603474d685ff93307dec81e4e; exit=0; EXPECT=matched; output-sha256=3e373f6e1a662a746fb36c934c40e8a882e4331bca418176c11ca8166fdaf527; output-bytes=2454; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] P1: on the discrete GPU, "Render This" plays from 0:30 for 10 s showing 30+ frames per second on a first pass, every shown frame complete
  CHECK: node scripts/check-video-playback.ts "C:/Users/schxm/Downloads/Trap nation v9.2.aep" "Render This" 10 30 --serve --discrete --require-fps 30
  EXPECT: /Render This: PLAYBACK-FPS-OK/
  EVIDENCE: automatic-evidence=v1; definition-sha256=35c2e5f856b348335e67c8a246a7d4e44a60018188482725194cee62cc445417; exit=0; EXPECT=matched; output-sha256=7859a511ac62e35f3d0ae4c2191854fe1dc2bed758037eb64dc35347800ff3d1; output-bytes=1707; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] P2: on the integrated GPU (the browser default), "Render This" plays from 0:30 for 10 s showing 30+ frames per second on a first pass, every shown frame complete
  CHECK: node scripts/check-video-playback.ts "C:/Users/schxm/Downloads/Trap nation v9.2.aep" "Render This" 10 30 --serve --require-fps 30
  EXPECT: /Render This: PLAYBACK-FPS-OK/
  EVIDENCE: automatic-evidence=v1; definition-sha256=a9d7b5f5990ad385729160fa18a60d320ff76cd1b974aaa732cea3b6657e2b33; exit=0; EXPECT=matched; output-sha256=99e0651b53369794ec70c894c57577ae2f035cb1a5b044cce8eeb86e7d9d5540; output-bytes=1689; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] P3: during playback on the integrated GPU the song plays as one stream (started once, never stopped) with the picture within 3 frames (50 ms) of it, and once the sound has started the page never goes 100 ms without an animation frame
  CHECK: node scripts/check-video-playback.ts "C:/Users/schxm/Downloads/Trap nation v9.2.aep" "Render This" 10 30 --serve --require-audio --max-drift 3 --require-smooth 100
  EXPECT: /^(?=[\s\S]*AUDIO-CONTINUOUS-OK starts=1 stops=0)[\s\S]*UI-RESPONSIVE-OK/
  EVIDENCE: automatic-evidence=v1; definition-sha256=3773f664ee78eaa106d79c0b79b5fd722ee3ca71ca8ec023fc90a5dd419f7094; exit=0; EXPECT=matched; output-sha256=4f066e205f983251239c9eccd113ac02558a2005242e18bc034d9ca0848a0208; output-bytes=1851; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] P4: the spectrum and particles comps the user works in also play at 30+ fps on the integrated GPU (Glow Spectrum, Pre-comp 2, Particles)
  CHECK: node scripts/check-video-playback.ts "C:/Users/schxm/Downloads/Trap nation v9.2.aep" "Glow Spectrum,Pre-comp 2,Particles" 6 30 --serve --require-fps 30
  EXPECT: /^(?=[\s\S]*Glow Spectrum: PLAYBACK-FPS-OK)(?=[\s\S]*Pre-comp 2: PLAYBACK-FPS-OK)[\s\S]*Particles: PLAYBACK-FPS-OK/
  EVIDENCE: automatic-evidence=v1; definition-sha256=7546ada81f57a1f901d624d44e9517534b4759dba988f94b3fbcc34312d3d3c0; exit=0; EXPECT=matched; output-sha256=36577fc79b176476a9d7c8649f578d9be826c7c8a33930ba2e3cbac8138ffb36; output-bytes=3374; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries
