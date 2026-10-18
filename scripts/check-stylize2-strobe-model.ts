// Scores arithmetic variants of Strobe Light's on/off rule against the timing grids After Effects rendered
// (stylize2_strobe_timing at 24 fps and stylize2_strobe_timing_30 at 30 fps): which phase computation, precision
// and comparison reproduce every cell and frame.
//
//   node scripts/check-stylize2-strobe-model.ts
import { readFileSync } from "node:fs";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";
const TIMINGS = [[2, 4], [3, 6], [1, 4], [2, 8], [4, 8], [6, 12], [12, 24], [13.5, 24], [1, 2], [2.4, 6], [1, 3], [2, 5], [5, 10], [8, 16], [3, 4], [0.5, 1]];
const FRAMES = 48;

function observed(comp: string): boolean[][] {
  const rows = TIMINGS.map(() => [] as boolean[]);
  for (let f = 0; f < FRAMES; f++) {
    const img = readTiff(new Uint8Array(readFileSync(framePath(comp, f))));
    for (let k = 0; k < 16; k++) {
      const i = ((30 * Math.floor(k / 4) + 15) * img.width + 40 * (k % 4) + 20) * 4;
      rows[k].push(img.data[i + 1] < 128);
    }
  }
  return rows;
}

const grids = { 24: observed("stylize2_strobe_timing"), 30: observed("stylize2_strobe_timing_30") };
const f32 = Math.fround;
type Rule = (f: number, fps: number, d: number, p: number) => boolean;

const rules: Record<string, Rule> = {};
for (const prec of ["f64", "f32"] as const) {
  const r = prec === "f32" ? f32 : (x: number) => x;
  for (const cmp of ["<", "<="] as const) {
    const lt = cmp === "<" ? (a: number, b: number) => a < b : (a: number, b: number) => a <= b;
    for (const tform of ["f/fps", "f*(1/fps)"] as const) {
      const time = (f: number, fps: number) => (tform === "f/fps" ? r(f / fps) : r(f * r(1 / fps)));
      rules[`${prec} ${tform} fmod ${cmp}`] = (f, fps, d, p) => lt(r(time(f, fps) % r(p)), r(d));
      rules[`${prec} ${tform} t-floor(t/P)*P ${cmp}`] = (f, fps, d, p) => {
        const t = time(f, fps);
        const pp = r(p);
        return lt(r(t - r(Math.floor(r(t / pp)) * pp)), r(d));
      };
      rules[`${prec} ${tform} frac(t/P) vs D/P ${cmp}`] = (f, fps, d, p) => {
        const q = r(time(f, fps) / r(p));
        return lt(r(q - Math.floor(q)), r(r(d) / r(p)));
      };
      rules[`${prec} ${tform} frac(t/P)*P ${cmp}`] = (f, fps, d, p) => {
        const q = r(time(f, fps) / r(p));
        return lt(r(r(q - Math.floor(q)) * r(p)), r(d));
      };
      rules[`${prec} ${tform} t-trunc(t/P)*P via int ${cmp}`] = (f, fps, d, p) => {
        const t = time(f, fps);
        const n = Math.trunc(r(t / r(p)));
        return lt(r(t - r(n * r(p))), r(d));
      };
    }
  }
}

for (const pprec of ["f64", "f32"] as const) {
  const rp = pprec === "f32" ? f32 : (x: number) => x;
  for (const tprec of ["f64", "f32"] as const) {
    const rt = tprec === "f32" ? f32 : (x: number) => x;
    const tag = `params ${pprec} time ${tprec}`;
    rules[`${tag} fmod(t,P) < P-D`] = (f, fps, d, p) => rt(f / fps) % rp(p) < rp(p) - rp(d);
    rules[`${tag} fmod(t,P) <= P-D`] = (f, fps, d, p) => rt(f / fps) % rp(p) <= rp(p) - rp(d);
    rules[`${tag} fmod(t,P)+D < P`] = (f, fps, d, p) => (rt(f / fps) % rp(p)) + rp(d) < rp(p);
    rules[`${tag} t-floor(t/P)*P < P-D`] = (f, fps, d, p) => {
      const t = rt(f / fps);
      return t - Math.floor(t / rp(p)) * rp(p) < rp(p) - rp(d);
    };
    rules[`${tag} frac(t/P) < 1-D/P`] = (f, fps, d, p) => {
      const q = rt(f / fps) / rp(p);
      return q - Math.floor(q) < 1 - rp(d) / rp(p);
    };
    rules[`${tag} f32 all fmod < P-D`] = (f, fps, d, p) => f32(f32(rt(f / fps)) % rp(p)) < f32(rp(p) - rp(d));
  }
}

for (const pprec of ["f64", "f32"] as const) {
  const r = pprec === "f32" ? f32 : (x: number) => x;
  for (const form of ["p*fps", "p/(1/fps)", "f32(p)*fps"] as const) {
    const frames = (v: number, fps: number) => (form === "p*fps" ? r(v * fps) : form === "p/(1/fps)" ? r(v / r(1 / fps)) : r(f32(v) * fps));
    rules[`frames ${pprec} ${form} f-floor(f/P)*P < P-D`] = (f, fps, d, p) => {
      const pc = frames(p, fps);
      const dc = frames(d, fps);
      return r(f - r(Math.floor(r(f / pc)) * pc)) < r(pc - dc);
    };
    rules[`frames ${pprec} ${form} fmod(f,P) < P-D`] = (f, fps, d, p) => {
      const pc = frames(p, fps);
      return r(f % pc) < r(pc - frames(d, fps));
    };
    rules[`frames ${pprec} ${form} fmod(f,P)+D < P`] = (f, fps, d, p) => {
      const pc = frames(p, fps);
      return r(r(f % pc) + frames(d, fps)) < pc;
    };
  }
}

for (const per of [1, 100, 1000, 25, 125] as const) {
  for (const conv of ["trunc", "round"] as const) {
    for (const prec of ["f64", "f32"] as const) {
      const r = prec === "f32" ? f32 : (x: number) => x;
      const ticks = (v: number, fps: number) => (conv === "trunc" ? Math.trunc(r(r(v) * fps * per)) : Math.round(r(r(v) * fps * per)));
      for (const cmp of ["phase < P-D", "phase+D < P", "phase < P-D (D,P trunc of P-D)"] as const) {
        rules[`ticks x${per} ${conv} ${prec} ${cmp}`] = (f, fps, d, p) => {
          const pt = ticks(p, fps);
          const t = f * per;
          if (pt <= 0) return false;
          const phase = t % pt;
          if (cmp === "phase < P-D") return phase < pt - ticks(d, fps);
          if (cmp === "phase+D < P") return phase + ticks(d, fps) < pt;
          return phase < ticks(p - d, fps);
        };
      }
    }
  }
}

for (const scale of [100, 600, 1000, 2400, 3000, 6000, 30000, 60000, 120000, 705600000, 254016000000]) {
  for (const conv of ["trunc", "round", "ceil"] as const) {
    for (const prec of ["f64", "f32"] as const) {
      const r = prec === "f32" ? f32 : (x: number) => x;
      const ticks = (v: number) => (conv === "trunc" ? Math.trunc(r(r(v) * scale)) : conv === "round" ? Math.round(r(r(v) * scale)) : Math.ceil(r(r(v) * scale)));
      for (const tconv of ["trunc", "round"] as const) {
        const tt = (f: number, fps: number) => (tconv === "trunc" ? Math.trunc((f * scale) / fps) : Math.round((f * scale) / fps));
        rules[`abs ticks ${scale} P ${conv} ${prec} t ${tconv} phase < P-D`] = (f, fps, d, p) => {
          const pt = ticks(p);
          return pt > 0 && tt(f, fps) % pt < pt - ticks(d);
        };
        rules[`abs ticks ${scale} P ${conv} ${prec} t ${tconv} phase < (P-D)`] = (f, fps, d, p) => {
          const pt = ticks(p);
          return pt > 0 && tt(f, fps) % pt < ticks(p - d);
        };
      }
    }
  }
}

const conversions = { trunc: Math.trunc, round: Math.round, ceil: Math.ceil, floor: Math.floor, none: (x: number) => x };
for (const [pn, pc] of Object.entries(conversions)) {
  for (const [dn, dc] of Object.entries(conversions)) {
    for (const [tn, tc] of Object.entries(conversions)) {
      for (const cmp of ["<", "<="] as const) {
        rules[`ms P ${pn} D ${dn} t ${tn} ${cmp}`] = (f, fps, d, p) => {
          const pt = pc(p * 1000);
          if (pt <= 0) return false;
          const phase = tc((f * 1000) / fps) % pt;
          return cmp === "<" ? phase < pt - dc(d * 1000) : phase <= pt - dc(d * 1000);
        };
        rules[`ms P ${pn} D ${dn} t ${tn} floor-div ${cmp}`] = (f, fps, d, p) => {
          const pt = pc(p * 1000);
          if (pt <= 0) return false;
          const t = tc((f * 1000) / fps);
          const phase = t - Math.floor(t / pt) * pt;
          return cmp === "<" ? phase < pt - dc(d * 1000) : phase <= pt - dc(d * 1000);
        };
      }
    }
  }
}

for (const scale of [1e4, 1e5, 1e6, 1e7]) {
  for (const [tn, tc] of Object.entries(conversions)) {
    for (const cmp of ["<", "<="] as const) {
      rules[`dec ${scale} P,D round t ${tn} ${cmp}`] = (f, fps, d, p) => {
        const pt = Math.round(p * scale);
        if (pt <= 0) return false;
        const phase = tc((f * scale) / fps) % pt;
        const on = pt - Math.round(d * scale);
        return cmp === "<" ? phase < on : phase <= on;
      };
    }
  }
}

function strobeOn(t: number, duration: number, period: number): boolean {
  const p = Math.round(period * 1e4);
  return p > 0 && (t * 1e4) % p < p - Math.round(duration * 1e4);
}
rules["renderer strobeOn"] = (f, fps, d, p) => strobeOn(f / fps, d, p);
rules["renderer strobeOn, time f*(1/fps)"] = (f, fps, d, p) => strobeOn(f * (1 / fps), d, p);

const results = Object.entries(rules).map(([name, rule]) => {
  let miss = 0;
  const where: string[] = [];
  for (const fps of [24, 30] as const) {
    TIMINGS.forEach(([dFrames, pFrames], k) => {
      const d = dFrames / 24;
      const p = pFrames / 24;
      for (let f = 0; f < FRAMES; f++) {
        if (rule(f, fps, d, p) !== grids[fps][k][f]) {
          miss++;
          if (where.length < 6) where.push(`${fps}fps cell ${k} f${f}`);
        }
      }
    });
  }
  return { name, miss, where };
});
results.sort((a, b) => a.miss - b.miss);
for (const r of results.filter((r, i) => i < 12 || r.name.startsWith("renderer"))) console.log(`${String(r.miss).padStart(4)}  ${r.name}  ${r.where.join(", ")}`);

const best = rules[results[0].name];
for (const fps of [24, 30] as const) {
  TIMINGS.forEach(([dFrames, pFrames], k) => {
    const model = Array.from({ length: FRAMES }, (_, f) => (best(f, fps, dFrames / 24, pFrames / 24) ? "#" : "."))
      .join("");
    const seen = grids[fps][k].map((v) => (v ? "#" : ".")).join("");
    if (model !== seen) console.log(`${fps} ${String(k).padStart(2)} (${dFrames},${pFrames})\n   seen  ${seen}\n   model ${model}`);
  });
}
