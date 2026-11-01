# Gates: Portal Cards

Scope: Match the centered expanding image planes in INZO - ANGST (https://www.youtube.com/watch?v=SgaFHvsYDJ8, inspected at 40–44 seconds): nested opaque copies sharing a vanishing point, shallow seeded tilt and small offsets, continuous outward travel and clean edge exits. Preserve editable controls, image proportions, undo, save/reopen and seamless repeating sequences. This is an app effect; After Effects has no matching plugin.

- [x] G1: Types and production bundle compile.
  CHECK: npm run build
  EXPECT: built in
  EVIDENCE: automatic-evidence=v1; definition-sha256=46d72eccd628b28a4b0e974e69890ad856bb5d28a16876531804fc540a571513; exit=0; EXPECT=matched; output-sha256=2e78b881081549e1a2ca557f411b956cb30b2d4b0cec7fade8cf0cd5abf04e67; output-bytes=1644; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=cbccff5ca122/57 entries

- [x] G2: Portal Cards planes remain centered, grow outward at fixed proportions, keep opaque interiors, inherit the same seeded geometry across a spawn boundary, and preserve editable controls through undo and save/reopen.
  CHECK: npx vitest run --exclude "dist-tools/**" tests/portal-cards.test.ts tests/effect-library.test.tsx tests/effect-library-load.test.tsx
  EXPECT: /Test Files\s+3 passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=6866753abe02d5bafa1cfee182aaa890db44c763433191991470f05d95b1d502; exit=0; EXPECT=matched; output-sha256=18a3c35c8fb32d29ede45f8ea701af54259218cfe9dd5661287e3f5d1277567c; output-bytes=1350; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=cbccff5ca122/57 entries

- [x] G3: GPU renders nested opaque image planes with centered outward travel, shallow seeded tilt, clean exits, deterministic scrubbing, independent rotation, pulse, reduced resolution and transparency; randomized and regular sequences loop continuously.
  CHECK: node scripts/check-portal-cards.ts
  EXPECT: Portal Cards GPU checks passed
  EVIDENCE: automatic-evidence=v1; definition-sha256=8bb16a2126bfc8cf569e3fa320cf8306817633dc614af0c0c48484da0b29ae1d; exit=0; EXPECT=matched; output-sha256=b15530c153953c3d1d40e0aaa56efc23fac17c1d21ad2db343fae1137ad73adf; output-bytes=69; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=cbccff5ca122/57 entries

- [ ] G4: Rendered landscape and portrait sequences visually reproduce the reference's centered nested layout, outward growth and restrained random tilt.
  EVIDENCE: pending

- [x] G5: Opening older Portal Cards instances adds editable Randomness and Random Seed controls and current rotation ranges, preserving stored values, animation, expressions and unrelated project chunks through save/reopen.
  CHECK: npx vitest run --exclude "dist-tools/**" tests/portal-cards.test.ts tests/effect-library.test.tsx tests/effects-editing.test.ts tests/effect-names.test.ts
  EXPECT: /Test Files\s+4 passed/
  EVIDENCE: automatic-evidence=v1; definition-sha256=6dc359cbc4957d7f20832f24a9fe4a93b20b395d68a18f35041d847c9af8d1fc; exit=0; EXPECT=matched; output-sha256=c6c96d1e2c4c8e645fc567fda963725658506851b1c055d760ef5577cfb3aa8a; output-bytes=1829; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=cbccff5ca122/57 entries
