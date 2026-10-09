$env:DG_OUTSIDE = 1
"== absolute octave grid"
$env:DG_BASIS = "1,2,11"
node scripts/dg-fit-src.ts fxmisc_dg_radius 0,1,2,3,4 1
"== relative to R/8 (floor 2)"
$env:DG_BASIS = "2,2,10"
$env:DG_RADII = "10,25,50,100,300"
node scripts/dg-fit-src.ts fxmisc_dg_radius 0,1,2,3,4 1
Remove-Item Env:DG_OUTSIDE, Env:DG_BASIS, Env:DG_RADII
