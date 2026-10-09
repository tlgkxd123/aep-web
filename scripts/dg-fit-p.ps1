param([string]$comp = "deepglow_levels", [string]$frames = "1,2,6,7", [string]$exp = "1")
foreach ($p in "2.0", "2.1", "2.2") {
  $env:DG_P = $p
  node scripts/dg-fit-src.ts $comp $frames $exp
}
Remove-Item Env:DG_P
