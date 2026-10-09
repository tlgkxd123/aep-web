$env:DG_BASIS = "1,2,8"
$env:DG_COMP = "deepglow_glowab:20"
$env:DG_CH = "0"
node scripts/dg-fit-kernel.ts 0,1,2,3
$env:DG_CH = "1"
node scripts/dg-fit-kernel.ts 0,3
$env:DG_COMP = "deepglow_dot_hot:20"
node scripts/dg-fit-kernel.ts 2,3,4
Remove-Item Env:DG_COMP, Env:DG_CH, Env:DG_BASIS
