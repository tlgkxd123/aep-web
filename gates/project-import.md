# Gates: After Effects project import

OWNS: src/edit/import-project.ts, src/aep/parse.ts, src/ui/App.tsx, src/ui/useProjectOps.tsx, src/ui/ImportDialog.tsx, src/ui/projectFiles.ts, src/media/localFootage.ts, server/local-footage.ts, tests/project-import.test.ts, tests/project-import-ui.test.tsx, tests/project-ops-ui.test.tsx, scripts/check-project-import.ts, gates/project-import.md

Scope: Import native .aep projects into the current project as editable compositions, layers, solids, folders and footage with remapped references and undo.

- [x] G1: Imported hierarchies, layer references, effects, animation and repeated imports survive saving and undo; file import is reachable through the existing import UI.
  CHECK: npx vitest run tests/project-import.test.ts tests/project-import-ui.test.tsx tests/project-ops.test.ts tests/project-ops-ui.test.tsx --exclude dist-tools/**
  EXPECT: /Tests\s+\d+ passed/
  CWD: ..
  EVIDENCE: automatic-evidence=v1; definition-sha256=362a9c9f134cdd7d0e9cf5372e543a9f14997b662099490b71257c69d3b2edaf; exit=0; EXPECT=matched; output-sha256=545fc6ab293be2442bba438173353f787ec41ea2a5dc67493392c1763ff5c2e3; output-bytes=2852; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=f727919710e0/55 entries

- [x] G2: After Effects 2025 opens and renders a merged project with nested compositions, solids, shapes and effects.
  CHECK: node scripts/check-project-import.ts
  EXPECT: PROJECT-IMPORT-PASSED
  CWD: ..
  EVIDENCE: automatic-evidence=v1; definition-sha256=6b5a31004ed8321728fe3c91e78e0feec142752c2889e71fccda19d87bf32d19; exit=0; EXPECT=matched; output-sha256=45240d5718a4de799eae8f86c86bf962c75bef59c2f0cca4bee436761c4c0efb; output-bytes=257; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=f727919710e0/55 entries

- [x] G3: The production app bundles with project import.
  CHECK: npx vite build
  EXPECT: built in
  CWD: ..
  EVIDENCE: automatic-evidence=v1; definition-sha256=97bcf368a89be0aeb7a723cec1002974726a5b3d676331d2a30f09a689f99df0; exit=0; EXPECT=matched; output-sha256=9946bfd21e493a3d0c891797fcd59e1816394739630a109eab6c98c11e011964; output-bytes=1591; shell=C:\WINDOWS\system32\cmd.exe; cwd=C:\Users\schxm\projects\aep-web; path=f727919710e0/55 entries
