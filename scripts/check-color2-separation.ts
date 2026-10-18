// For a hard-threshold colour key (Leave Color with no softness and the like), which distance
// metric separates the probe cells the effect kept from those it changed? Prints, per metric,
// the largest distance kept and the smallest changed (a clean metric has kept < changed).
// With --mask the frame is a matte (Change Color's mask view): opaque cells count as kept.
//   node scripts/check-color2-separation.ts <frame> <r,g,b target 0..255> [--comp color2_probe] [--mask]
import { existsSync, readFileSync } from "node:fs";
import { rgbToHsl } from "../src/render/effects/colorExtraMath.ts";
import { framePath } from "./lib/suites.ts";
import { readTiff, type Image } from "./lib/tiff.ts";

const [frameArg, targetArg] = process.argv.slice(2);
const compArg = process.argv.indexOf("--comp");
const comp = compArg > 0 ? process.argv[compArg + 1] : "color2_probe";
const target = targetArg.split(",").map((v) => Number(v) / 255);
const read = (f: number): Image => {
  if (!existsSync(framePath(comp, f))) throw new Error(`no frame ${f} of ${comp}`);
  return readTiff(new Uint8Array(readFileSync(framePath(comp, f))));
};
const src = read(0);
const out = read(Number(frameArg));
const mask = process.argv.includes("--mask");
const cell = (img: Image, k: number) => {
  const o = ((Math.floor(k / 16) * 8 + 4) * img.width + (k % 16) * 8 + 4) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
};
const turn = (a: number) => {
  const d = Math.abs(a) % 1;
  return Math.min(d, 1 - d);
};
const hsvSat = (c: number[]) => {
  const mx = Math.max(...c);
  return mx > 0 ? (mx - Math.min(...c)) / mx : 0;
};
const yiqAngle = ([r, g, b]: number[]) => Math.atan2(0.211 * r - 0.523 * g + 0.312 * b, 0.596 * r - 0.274 * g - 0.322 * b) / (2 * Math.PI);
const chroma = ([r, g, b]: number[]) => {
  const s = r + g + b || 1;
  return [r / s, g / s, b / s];
};
const METRICS: Record<string, (c: number[]) => number> = {
  rgb: (c) => Math.hypot(c[0] - target[0], c[1] - target[1], c[2] - target[2]) / Math.sqrt(3),
  hslHue: (c) => turn(rgbToHsl(c)[0] - rgbToHsl(target)[0]),
  yiqAngle: (c) => turn(yiqAngle(c) - yiqAngle(target)),
  chromaticity: (c) => {
    const a = chroma(c);
    const b = chroma(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  },
  hueSat: (c) => {
    const h = rgbToHsl(c);
    const t = rgbToHsl(target);
    return Math.hypot(turn(h[0] - t[0]) * 2, h[1] - t[1]);
  },
  hueHsvSat: (c) => Math.hypot(turn(rgbToHsl(c)[0] - rgbToHsl(target)[0]) * 2, hsvSat(c) - hsvSat(target)),
  uv: (c) => {
    const uv = ([r, g, b]: number[]) => [-0.147 * r - 0.289 * g + 0.436 * b, 0.615 * r - 0.515 * g - 0.1 * b];
    const a = uv(c);
    const b = uv(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  },
  uvOverMax: (c) => {
    const uv = (x: number[]) => {
      const m = Math.max(...x) || 1;
      const [r, g, b] = x.map((v) => v / m);
      return [-0.147 * r - 0.289 * g + 0.436 * b, 0.615 * r - 0.515 * g - 0.1 * b];
    };
    const a = uv(c);
    const b = uv(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  },
  uvOverSum: (c) => {
    const uv = (x: number[]) => {
      const m = x[0] + x[1] + x[2] || 1;
      const [r, g, b] = x.map((v) => v / m);
      return [-0.147 * r - 0.289 * g + 0.436 * b, 0.615 * r - 0.515 * g - 0.1 * b];
    };
    const a = uv(c);
    const b = uv(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  },
  uvLinear: (c) => {
    const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const uv = (x: number[]) => {
      const [r, g, b] = x.map(lin);
      return [-0.147 * r - 0.289 * g + 0.436 * b, 0.615 * r - 0.515 * g - 0.1 * b];
    };
    const a = uv(c);
    const b = uv(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  },
  lab: (c) => {
    const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const ab = (x: number[]) => {
      const [r, g, b] = x.map(lin);
      const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.9505;
      const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.089;
      const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
      return [500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
    };
    const a = ab(c);
    const b = ab(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1]) / 100;
  },
  iq: (c) => {
    const iq = ([r, g, b]: number[]) => [0.596 * r - 0.274 * g - 0.322 * b, 0.211 * r - 0.523 * g + 0.312 * b];
    const a = iq(c);
    const b = iq(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  },
  cbcr: (c) => {
    const f = ([r, g, b]: number[]) => [-0.1687 * r - 0.3313 * g + 0.5 * b, 0.5 * r - 0.4187 * g - 0.0813 * b];
    const a = f(c);
    const b = f(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  },
  diff601: (c) => {
    const f = ([r, g, b]: number[]) => {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      return [r - y, b - y];
    };
    const a = f(c);
    const b = f(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  },
  diffW3C: (c) => {
    const f = ([r, g, b]: number[]) => {
      const y = 0.3 * r + 0.59 * g + 0.11 * b;
      return [r - y, g - y, b - y];
    };
    const a = f(c);
    const b = f(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  },
  diff709: (c) => {
    const f = ([r, g, b]: number[]) => {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return [r - y, b - y];
    };
    const a = f(c);
    const b = f(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  },
  meanDiff: (c) => {
    const f = ([r, g, b]: number[]) => {
      const y = (r + g + b) / 3;
      return [r - y, g - y, b - y];
    };
    const a = f(c);
    const b = f(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  },
  hex: (c) => {
    const f = ([r, g, b]: number[]) => [r - (g + b) / 2, (Math.sqrt(3) / 2) * (g - b)];
    const a = f(c);
    const b = f(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  },
  hslVector: (c) => {
    const f = (x: number[]) => {
      const [h, s] = rgbToHsl(x);
      return [s * Math.cos(2 * Math.PI * h), s * Math.sin(2 * Math.PI * h)];
    };
    const a = f(c);
    const b = f(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  },
  hsvVector: (c) => {
    const f = (x: number[]) => {
      const h = rgbToHsl(x)[0];
      const s = hsvSat(x);
      return [s * Math.cos(2 * Math.PI * h), s * Math.sin(2 * Math.PI * h)];
    };
    const a = f(c);
    const b = f(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  },
  rgChroma: (c) => {
    const a = chroma(c);
    const b = chroma(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  },
  normalized: (c) => {
    const n = (x: number[]) => {
      const l = Math.hypot(...x) || 1;
      return x.map((v) => v / l);
    };
    const a = n(c);
    const b = n(target);
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  },
};
const kept: number[][] = [];
const changed: number[][] = [];
for (let k = 0; k < 192; k++) {
  const c = cell(src, k);
  const o = cell(out, k);
  if (Math.max(...c) - Math.min(...c) < 6) continue;
  const unchanged = mask ? o[0] * o[3] > 127 * 255 : c.every((v, i) => Math.abs(v - o[i]) <= 1);
  (unchanged ? kept : changed).push(c.map((v) => v / 255));
}
console.log(`${kept.length} kept, ${changed.length} changed`);
if (process.argv.includes("--fit-uv")) {
  const LUMAS: Record<string, number[]> = { "601": [0.299, 0.587, 0.114], w3c: [0.3, 0.59, 0.11], "709": [0.2126, 0.7152, 0.0722] };
  for (const [lname, w] of Object.entries(LUMAS)) {
    let best = { ratio: 0, gap: -Infinity, overlap: Infinity };
    for (let ratio = 0.2; ratio <= 4; ratio *= 1.02) {
      const f = ([r, g, b]: number[]) => {
        const y = w[0] * r + w[1] * g + w[2] * b;
        return [(b - y) * ratio, r - y];
      };
      const t = f(target);
      const m = (c: number[]) => {
        const a = f(c);
        return Math.hypot(a[0] - t[0], a[1] - t[1]);
      };
      const maxKept = Math.max(...kept.map(m));
      const minChanged = Math.min(...changed.map(m));
      const overlap = kept.filter((c) => m(c) >= minChanged).length + changed.filter((c) => m(c) <= maxKept).length;
      const gap = (minChanged - maxKept) / maxKept;
      if (overlap < best.overlap || (overlap === best.overlap && gap > best.gap)) best = { ratio, gap, overlap };
    }
    console.log(`luma ${lname}: best (B-Y)/(R-Y) scale ${best.ratio.toFixed(3)}, overlap ${best.overlap}, relative gap ${best.gap.toFixed(4)}`);
  }
}
for (const [name, m] of Object.entries(METRICS)) {
  const maxKept = Math.max(...kept.map(m));
  const minChanged = Math.min(...changed.map(m));
  const overlap = kept.filter((c) => m(c) >= minChanged).length + changed.filter((c) => m(c) <= maxKept).length;
  console.log(`${name.padEnd(14)} kept <= ${maxKept.toFixed(4)}  changed >= ${minChanged.toFixed(4)}  ${maxKept < minChanged ? "clean" : `${overlap} cells overlap`}`);
  if (process.argv.includes(`--show=${name}`)) {
    const show = (label: string, cs: number[][]) =>
      cs.forEach((c) => console.log(`    ${label} ${c.map((v) => Math.round(v * 255))} ${m(c).toFixed(4)}`));
    show("kept", kept.filter((c) => m(c) >= minChanged));
    show("changed", changed.filter((c) => m(c) <= maxKept));
  }
}
