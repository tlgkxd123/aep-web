// Fits candidate formulas for one output channel of a channel suite reference frame against the card's opaque
// cells: prints each candidate's worst and mean error (of 255) and the cells it misses most.
//
//   node scripts/check-channel-fit.ts <comp> <frame> <channel 0-3> <family>
import { cardCells, refPixel } from "./check-channel-probe.ts";

type Candidate = (r: number, g: number, b: number) => number;

const hsl = (r: number, g: number, b: number) => {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  const s = d === 0 ? 0 : l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  return { mx, mn, l, d, s };
};
const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;

const families: Record<string, Record<string, Candidate>> = {
  saturation: {
    hsl: (r, g, b) => hsl(r, g, b).s,
    hsv: (r, g, b) => (Math.max(r, g, b) ? hsl(r, g, b).d / Math.max(r, g, b) : 0),
    chroma: (r, g, b) => hsl(r, g, b).d,
    hslHigh: (r, g, b) => hsl(r, g, b).d / Math.max(1e-6, 2 - hsl(r, g, b).mx - hsl(r, g, b).mn),
    hslSwapped: (r, g, b) => {
      const h = hsl(r, g, b);
      return h.d === 0 ? 0 : h.l <= 0.5 ? h.d / (2 - h.mx - h.mn) : h.d / (h.mx + h.mn);
    },
    hslMin: (r, g, b) => Math.min(1, hsl(r, g, b).s),
    chromaL: (r, g, b) => hsl(r, g, b).d * (1 - Math.abs(hsl(r, g, b).mx + hsl(r, g, b).mn - 1)),
    lumaChroma: (r, g, b) => Math.hypot(r - luma(r, g, b), b - luma(r, g, b)),
  },
};

const [comp, frameArg, channelArg, family] = process.argv.slice(2);
const px = refPixel(comp, Number(frameArg));
const channel = Number(channelArg);
const cells = cardCells("a").filter((c) => c.rgba[3] === 255);
if (family.startsWith("scale:")) {
  // Compound Arithmetic's Scale: each channel's results stretched from their minimum and maximum over the frame
  // (premultiplied or straight values, opaque pixels or all) to 0..255; `scale:<copy frame>:<add|sub>`.
  const [copyFrame, op] = family.slice(6).split(":");
  const copy = refPixel(comp, Number(copyFrame));
  const a = cardCells("a");
  for (const mode of ["straight", "premul"]) {
    for (const which of ["all", "opaque"]) {
      const lo = [1e9, 1e9, 1e9];
      const hi = [-1e9, -1e9, -1e9];
      const values: { x: number; y: number; v: number[] }[] = [];
      for (let y = 0; y < 120; y++)
        for (let x = 0; x < 160; x++) {
          const cell = a[Math.floor(y / 10) * 16 + Math.floor(x / 10)].rgba;
          const b = copy(x, y);
          if (which === "opaque" && (cell[3] !== 255 || b[3] !== 255)) continue;
          const k = (v: number, alpha: number) => (mode === "premul" ? (v * alpha) / 255 : alpha ? v : 0);
          const v = [0, 1, 2].map((c) => (op === "add" ? k(cell[c], cell[3]) + k(b[c], b[3]) : k(cell[c], cell[3]) - k(b[c], b[3])));
          v.forEach((w, c) => ((lo[c] = Math.min(lo[c], w)), (hi[c] = Math.max(hi[c], w))));
          values.push({ x, y, v });
        }
      let worst = 0;
      for (const { x, y, v } of values) {
        if (x % 10 !== 5 || y % 10 !== 5 || px(x, y)[3] !== 255) continue;
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(((v[c] - lo[c]) / (hi[c] - lo[c])) * 255 - px(x, y)[c]));
      }
      let worstFixedHi = 0;
      for (const { x, y, v } of values) {
        if (x % 10 !== 5 || y % 10 !== 5 || px(x, y)[3] !== 255) continue;
        for (let c = 0; c < 3; c++) worstFixedHi = Math.max(worstFixedHi, Math.abs(((v[c] - Math.min(0, lo[c])) / (Math.max(255, hi[c]) - Math.min(0, lo[c]))) * 255 - px(x, y)[c]));
      }
      if (mode === "straight" && which === "all") {
        // Extremes with card B unstretched, at A's top left or centred.
        const bc = cardCells("b");
        for (const [name, ox, oy] of [["topleft", 0, 0], ["centred", 30, 20]] as const) {
          const l2 = [1e9, 1e9, 1e9];
          for (let y = 0; y < 120; y++)
            for (let x = 0; x < 160; x++) {
              const ca = a[Math.floor(y / 10) * 16 + Math.floor(x / 10)].rgba;
              const inside = x - ox >= 0 && y - oy >= 0 && x - ox < 100 && y - oy < 80;
              const cb = inside ? bc[Math.floor((y - oy) / 10) * 10 + Math.floor((x - ox) / 10)].rgba : [0, 0, 0, 0];
              for (let c = 0; c < 3; c++) l2[c] = Math.min(l2[c], (ca[3] ? ca[c] : 0) - (cb[3] ? cb[c] : 0));
            }
          console.log(`  unstretched ${name}: lo ${l2.join(",")}`);
        }
      }
      console.log(`${mode} ${which}: lo ${lo.map((v) => v.toFixed(1))} hi ${hi.map((v) => v.toFixed(1))} worst ${worst.toFixed(2)}, with 0..255 kept ${worstFixedHi.toFixed(2)}`);
    }
  }
  process.exit(0);
}
if (family.startsWith("pair:")) {
  // out = c0 + c1 a + c2 b per channel, where b (the second layer) is read from a Copy frame of the same comp.
  const copy = refPixel(comp, Number(family.slice(5)));
  const samples: [number, number, number][] = [];
  for (const cell of cells) {
    const [x, y] = [cell.i * 10 + 5, cell.j * 10 + 5];
    const b = copy(x, y);
    const out = px(x, y);
    if (b[3] !== 255 || out[3] !== 255) continue;
    for (let c = 0; c < 3; c++) if (channel > 2 || c === channel) samples.push([cell.rgba[c], b[c], out[c]]);
  }
  const inner = samples.filter((s) => s[2] > 0 && s[2] < 255);
  const rows = inner.map((s) => [1, s[0], s[1]]);
  const n = 3;
  const ata = [...Array(n)].map((_, i) => [...Array(n)].map((_, j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
  const aty = [...Array(n)].map((_, i) => rows.reduce((s, r, k) => s + r[i] * inner[k][2], 0));
  for (let i = 0; i < n; i++)
    for (let k = i + 1; k < n; k++) {
      const f = ata[k][i] / ata[i][i];
      for (let j = i; j < n; j++) ata[k][j] -= f * ata[i][j];
      aty[k] -= f * aty[i];
    }
  const x = Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) x[i] = (aty[i] - x.reduce((s, v, j) => (j > i ? s + ata[i][j] * v : s), 0)) / ata[i][i];
  const worst = Math.max(...rows.map((r, k) => Math.abs(r.reduce((s, v, i) => s + v * x[i], 0) - inner[k][2])));
  console.log(`out = ${x.map((v) => v.toFixed(4)).join(" + ")} * [1 a b], worst ${worst.toFixed(2)} over ${inner.length}`);
  for (const s of samples.slice(0, 24)) process.stdout.write(`${s.join(",")}  `);
  console.log();
  process.exit(0);
}
if (family === "linear") {
  // Least squares of out = a r + b g + c b + d (8-bit units), from the cells whose output is not clipped.
  const rows: number[][] = [];
  const ys: number[] = [];
  for (const cell of cells) {
    const want = px(cell.i * 10 + 5, cell.j * 10 + 5)[channel];
    if (want <= 0 || want >= 255) continue;
    rows.push([...cell.rgba.slice(0, 3), 255]);
    ys.push(want);
  }
  const ata = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
  const aty = [0, 1, 2, 3].map((i) => rows.reduce((s, r, k) => s + r[i] * ys[k], 0));
  for (let i = 0; i < 4; i++) {
    for (let k = i + 1; k < 4; k++) {
      const f = ata[k][i] / ata[i][i];
      for (let j = i; j < 4; j++) ata[k][j] -= f * ata[i][j];
      aty[k] -= f * aty[i];
    }
  }
  const x = [0, 0, 0, 0];
  for (let i = 3; i >= 0; i--) x[i] = (aty[i] - [0, 1, 2, 3].slice(i + 1).reduce((s, j) => s + ata[i][j] * x[j], 0)) / ata[i][i];
  const worst = Math.max(...rows.map((r, k) => Math.abs(r.reduce((s, v, i) => s + v * x[i], 0) - ys[k])));
  console.log(`coefficients ${x.map((v) => v.toFixed(5)).join(" ")} (offset in 8-bit: ${(x[3] * 255).toFixed(2)}), worst residual ${worst.toFixed(2)} over ${rows.length} cells`);
  process.exit(0);
}
if (family === "table") {
  for (const cell of cells) {
    const [r, g, b] = cell.rgba.map((v) => v / 255);
    const h = hsl(r, g, b);
    const want = px(cell.i * 10 + 5, cell.j * 10 + 5)[channel] / 255;
    console.log([...cell.rgba.slice(0, 3), want * 255, h.mx, h.mn, h.d, luma(r, g, b), h.d / want].map((v) => (Number.isInteger(v) ? v : v.toFixed(3))).join("\t"));
  }
  process.exit(0);
}
for (const [name, f] of Object.entries(families[family])) {
  let worst = 0;
  let sum = 0;
  const misses: string[] = [];
  for (const cell of cells) {
    const [r, g, b] = cell.rgba.map((v) => v / 255);
    const want = px(cell.i * 10 + 5, cell.j * 10 + 5)[channel];
    const got = Math.round(Math.min(1, Math.max(0, f(r, g, b))) * 255);
    const e = Math.abs(got - want);
    worst = Math.max(worst, e);
    sum += e;
    if (e > 3 && misses.length < 6) misses.push(`(${cell.rgba.slice(0, 3).join(",")}) want ${want} got ${got}`);
  }
  console.log(`${name.padEnd(12)} worst ${String(worst).padStart(3)} mean ${(sum / cells.length).toFixed(2)}  ${misses.join("; ")}`);
}
