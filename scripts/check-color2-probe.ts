// Compares the per-pixel models of colorExtraMath.ts with After Effects' render of the
// color2 probe comp (scripts/fixtures/build_color2.py --probe): frame k shows the 256
// colour cells of color2_probe_cells through the k-th probe setting (frame 0 through
// none). Each 8 px cell is read at its centre before and after the effect, the model
// runs on the input with the parameters the probe project holds for that frame's layer,
// and the worst cells are listed (8-bit values, straight colour).
//
// --set 10=0 runs the model with parameter 10 overridden.
//
//   node scripts/check-color2-probe.ts [--comp color2_probe2] [--effect <match name>] [--frames 1,2] [--dump] [--worst n] [--set i=v,...]
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { COLOR_MODELS, type ColorModel } from "../src/render/effects/colorExtraMath.ts";
import { params, type Params } from "../src/render/effects/stockUtil.ts";
import { framePath, ROOT } from "./lib/suites.ts";
import { readTiff, type Image } from "./lib/tiff.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const COMP = opt("--comp") ?? "color2_probe";
const dump = args.includes("--dump");
const worst = Number(opt("--worst") ?? 6);
const only = opt("--effect");

const bytes = readFileSync(join(ROOT, "fixtures", "color2.probe.aep"));
const project = parseProject(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
const item = [...project.items.values()].find((i) => i.kind === "comp" && i.name === COMP);
if (!item || item.kind !== "comp") throw new Error(`no comp ${COMP}`);

const read = (f: number): Image | undefined => (existsSync(framePath(COMP, f)) ? readTiff(new Uint8Array(readFileSync(framePath(COMP, f)))) : undefined);
const src = read(0);
if (!src) throw new Error(`${COMP} has no reference frames`);
const cell = (img: Image, k: number) => {
  const x = (k % 16) * 8 + 4;
  const y = Math.floor(k / 16) * 8 + 4;
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
};

const total = Math.round((item.duration ?? 0) * item.frameRate);
const frames = opt("--frames")?.split(",").map(Number) ?? Array.from({ length: total }, (_, f) => f).slice(1);
for (const f of frames) {
  const t = f / item.frameRate;
  const layer = item.layers.find((l) => l.inPoint <= t + 1e-6 && t < l.outPoint - 1e-6);
  if (!layer) continue;
  const parade = layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade");
  const effect = parade?.children.find((n): n is PropertyGroup => n.kind === "group");
  if (!effect || (only && effect.matchName !== only)) continue;
  const out = read(f);
  if (!out) {
    console.log(`${effect.matchName}@${f}: no reference`);
    continue;
  }
  const model = COLOR_MODELS[effect.matchName] as ColorModel | undefined;
  const base = params(effect, layer, t);
  const overrides = new Map((opt("--set") ?? "").split(",").filter(Boolean).map((s) => s.split("=").map(Number) as [number, number]));
  const p: Params = {
    ...base,
    num: (i, f) => overrides.get(i) ?? base.num(i, f),
    bool: (i, f) => (overrides.has(i) ? overrides.get(i) !== 0 : base.bool(i, f)),
    choice: (i, f, m) => overrides.get(i) ?? base.choice(i, f, m),
  };
  const fn = model?.(p, layer, t, effect);
  const rows: { k: number; inp: number[]; ae: number[]; ours?: number[]; err: number }[] = [];
  for (let k = 0; k < 256; k++) {
    const inp = cell(src, k);
    const ae = cell(out, k);
    let ours: number[] | undefined;
    let err = 0;
    if (fn) {
      const r = fn([inp[0] / 255, inp[1] / 255, inp[2] / 255, inp[3] / 255]);
      ours = r.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
      // Fully transparent results have no colour to compare.
      err = ae[3] === 0 && ours[3] === 0 ? 0 : Math.max(...ours.map((v, i) => Math.abs(v - ae[i])));
    }
    rows.push({ k, inp, ae, ours, err });
  }
  if (args.includes("--per-channel")) {
    // Is the effect one curve per channel? The grey cells (192..255) give each channel's curve.
    const curve = (c: number, v: number) => {
      const greys = rows.slice(192).map((r) => [r.inp[c], r.ae[c]]);
      let k = 0;
      while (k < greys.length - 2 && greys[k + 1][0] < v) k++;
      const [x0, y0] = greys[k];
      const [x1, y1] = greys[k + 1];
      return y0 + ((y1 - y0) * (v - x0)) / Math.max(1, x1 - x0);
    };
    const errs = rows.slice(0, 192).map((r) => ({ r, e: Math.max(...[0, 1, 2].map((c) => Math.abs(curve(c, r.inp[c]) - r.ae[c]))) }));
    errs.sort((a, b) => b.e - a.e);
    console.log(`  per-channel curve: worst ${errs[0].e.toFixed(1)}, ${errs.filter((x) => x.e > 3).length} cells off by more than 3`);
    for (const { r, e } of errs.slice(0, worst)) console.log(`    #${r.k} in ${r.inp.slice(0, 3).join(",")} ae ${r.ae.slice(0, 3).join(",")} (${e.toFixed(1)})`);
  }
  const bad = rows.filter((r) => r.err > 3).length;
  const mean = rows.reduce((s, r) => s + r.err, 0) / rows.length;
  console.log(`${effect.matchName}@${f}: ${fn ? `max ${Math.max(...rows.map((r) => r.err))}, ${bad} cells off by more than 3, mean ${mean.toFixed(2)}` : "no model"}`);
  const shown = dump ? rows : [...rows].sort((a, b) => b.err - a.err).slice(0, fn ? worst : 0);
  for (const r of shown) console.log(`  #${r.k} in ${r.inp.slice(0, 3).join(",")} ae ${r.ae.join(",")}${r.ours ? ` ours ${r.ours.join(",")} (${r.err})` : ""}`);
}
