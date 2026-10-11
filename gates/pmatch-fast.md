# Gates: pmatch-fast - a more detailed Particle Match model, trained and played much faster

OWNS: src/extra/pmatch/**, ml/pmatch/**, src/ui/ParticleMatch*.tsx, src/ui/particle-match.css, server/pmatch-trainer.ts, scripts/pmatch-*.ts, scripts/check-pmatch-*.ts, scripts/lib/pmatch-*.ts, tests/particle-match*.test.ts, tests/data/pmatch-*, tests/particular-*.test.ts, tests/pmatch-fixtures.ts, gates/pmatch-fast.md, AGENTS.md

Scope: the Particle Match world model keeps more of what its reference shows (sprites with their halos, at 64 texels, from crops whose background leaves the halos in, and the right particles drawn with each sprite), analyses and calibrates at full resolution and full frame rate several times faster (the shake measured in workers, the GPU read back without stalling, fewer calibration rounds, the PyTorch trainer without its repeated work), and the window previews it at the reference's full resolution and frame rate.

- [x] F0: this ledger states outcomes that can fail
  CHECK: node C:/Users/schxm/.claude/skills/unlazy/scripts/gate-lint.mjs gates/pmatch-fast.md
  EXPECT: LINT OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=f440f1dd0c308c72beb73c4bb97afe86c3290f5dbcdff2245b526f252f2aaa44; exit=0; EXPECT=matched; output-sha256=48630b7361dd44ee870917b12c3d19b9d7bdea738aaca16bb04d4cab83b772d2; output-bytes=8; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] G1: the whole codebase type-checks under strict TypeScript
  CHECK: npx tsc --noEmit && echo TYPECHECK-CLEAN
  EXPECT: TYPECHECK-CLEAN
  EVIDENCE: automatic-evidence=v1; definition-sha256=57dc83bb9816e14468e084c3ab9458f41fc7eafc53dc20cf5ca0402ff1ad7978; exit=0; EXPECT=matched; output-sha256=76d5b239b071ba8554562df3eb886f8aa0f98c7a2286fa89e34313077236fe4e; output-bytes=17; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] G5: the production bundle builds
  CHECK: npx vite build
  EXPECT: /built in/
  EVIDENCE: automatic-evidence=v1; definition-sha256=202b6423274a1e776d6ddcc8d133917c5c706a45d1cd69c285f24b4a854abbd3; exit=0; EXPECT=matched; output-sha256=3da9e9cbc3db31e5a99e2d970d4aa083ce60136ede98b2b2af41c58f8896fc39; output-bytes=1278; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] F1: analysing the reference at full resolution and every frame (1080p60, 50-62 s, in headless Edge on the RTX) takes at most 6 ms per frame, measured on the whole analysis (it took 15.9)
  CHECK: node scripts/pmatch-profile.ts --require 6
  EXPECT: PMATCH-ANALYSIS-FAST
  EVIDENCE: automatic-evidence=v1; definition-sha256=71e179ed319fea4525dcba14e81910badc78ec9c16a60aa0c87af1d4e5e4f4c4; exit=0; EXPECT=matched; output-sha256=0417233cd165d69916847d0321a61a7b0953a969c9bc9623e4b43f8a1054d3ef; output-bytes=322; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] F2: analysing the 30 s training window, training the PyTorch model and calibrating it takes at most 45 s on this machine (it took 145)
  CHECK: node scripts/pmatch-train.ts --max-seconds 45
  EXPECT: PMATCH-TIME-OK
  EVIDENCE: automatic-evidence=v1; definition-sha256=beee1c607d73f3acd2f39f7f0b3d156f005e0761234af208b9163b3c55262bee; exit=0; EXPECT=matched; output-sha256=b503208b180f42bdad05cef55743f9683eb9e4ee357a946c27a6e1c293565d5a; output-bytes=2440; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] F3: trained on 50-80 s, the model still matches the held-out 136-166 s (particles per frame within 15 %, KS at most 0.15 for brightness, size and distance, median radial speed within 25 % in each radius quartile, quarter-second speed series correlating at least 0.5, each sprite at least 0.85 like the held-out crops most like it, unmirrored), and in more detail: its particles' light falls off from their centre out to their halo as the reference's does (in each brightness third, the mean light over the peak at 0-16 px differs from the reference's by at most a quarter of the reference's light, rings weighted by their pixels) and they look like the same sprites in the same proportions (total variation distance of the sprite classes of model and reference crops at most 0.15)
  CHECK: node scripts/pmatch-report.ts --check torch,match,mirror,detail
  EXPECT: /PMATCH-TORCH-CUDA[\s\S]*PMATCH-REFERENCE-PASSED[\s\S]*PMATCH-UNMIRRORED[\s\S]*PMATCH-DETAIL-PASSED/
  EVIDENCE: automatic-evidence=v1; definition-sha256=793b106fa5364101202cabc7a871c9aee7b815b6bd8d4f1cfd3221903aa64e80; exit=0; EXPECT=matched; output-sha256=e8db71a12d4e812b64a99a91ad1e14ef5f05c38852d7b2b7cf06246a44826307; output-bytes=2957; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] F4: the learned particles play at the reference's full resolution: the window's preview draws one 1920 x 1080 frame of the trained model (sampling, rendering, presenting, waiting for the GPU) in at most 4 ms (median of 120 frames in headless Edge on the RTX)
  CHECK: node scripts/pmatch-inference.ts --require 4
  EXPECT: PMATCH-INFERENCE-FAST
  EVIDENCE: automatic-evidence=v1; definition-sha256=1e8c5ec793fb184f00c18f103bae9c1f9d95aaedbeaefe2aecbf082f36245d6a; exit=0; EXPECT=matched; output-sha256=1787b23ec767c5626548fe271223d7fb97f60e9b85eb9e065eaf76b60eeb7707; output-bytes=111; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] F5: the PyTorch modules behave as specified (flow, TCN, projective fit, clock fit, export round trip)
  CHECK: uv run --project ml/pmatch pytest -q ml/pmatch/tests
  EXPECT: /\d+ passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=7fbc3d5c43fa766919196a8536d93042a7ed3fe9efd72a538b11844edc5dec26; exit=0; EXPECT=matched; output-sha256=d578d2b6da8a2279da3a53ac85041b4bb247a06286a65f0946727dffe411527e; output-bytes=111; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] F6: the app runs the networks PyTorch exports exactly, and the runtime pieces still behave (clock, sampling, encoding)
  CHECK: uv run --project ml/pmatch python -m pmatch parity tests/data/pmatch-parity.json && npx vitest run tests/particle-match-parity.test.ts tests/particle-match.test.ts
  EXPECT: /Test Files\s+2 passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=bb247206f2bcfb196d3b08e89963dc884f40c0e163d4299f7f4f70537ef326a8; exit=0; EXPECT=matched; output-sha256=de8167cfcaeb9668b191d9496eda4c08995579c48b4f416b7f93adf093f17b97; output-bytes=376; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] F7: the Particular layers derived from a model still build, save and export
  CHECK: npx vitest run tests/particular-layers.test.ts tests/particular-export.test.ts
  EXPECT: /Test Files\s+2 passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=dfc910a44a9cae883f91b60b226142002652aa2f74595632f47b5a1cd69c2c48; exit=0; EXPECT=matched; output-sha256=d13f82e85d62e7363ac6636e480755bc4609c6ba90972acb43f12a24dadaf308; output-bytes=1954; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries

- [x] F8: training through the window still works end to end (its own dev server, headless Edge): it analyses a reference window, trains through the dev server's trainer and shows the learned particles on a canvas as large as the reference video, with a report naming PyTorch and the GPU
  CHECK: node scripts/check-pmatch-ui.ts --serve --from 50 --to 62
  EXPECT: PMATCH-UI-PASSED
  EVIDENCE: automatic-evidence=v1; definition-sha256=39751b6a2a09dfb74b4a927991b5f62f19d8f52506c817b94ac46d7709675c5f; exit=0; EXPECT=matched; output-sha256=556ed58a0ac0c02a09761c45da6dc856997f6560f29f24a1272ebe24e6d5bee6; output-bytes=1791; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=92add6e87031/53 entries
