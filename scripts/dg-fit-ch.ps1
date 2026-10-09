param([string]$comp = "fxmisc_dg_radius", [string]$frames = "3", [string]$exp = "1")
$env:DG_OUTSIDE = 1
$env:DG_P = "2.11"
foreach ($ch in "0", "1", "2") {
  $env:DG_CH = $ch
  "== channel $ch"
  node scripts/dg-fit-src.ts $comp $frames $exp
}
Remove-Item Env:DG_OUTSIDE, Env:DG_P, Env:DG_CH
