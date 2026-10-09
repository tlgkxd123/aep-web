foreach ($s0 in "0.7", "0.84", "1.0", "1.19", "1.41", "1.68") {
  $env:DG_BASIS = "$s0,2,10"
  "== s0 $s0"
  node scripts/dg-fit-kernel.ts
}
Remove-Item Env:DG_BASIS
