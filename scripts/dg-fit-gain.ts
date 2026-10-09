// Fits Deep Glow 2's glow gain per frame (and the decode/encode exponents) on whole frames of
// opaque-source fixtures, with the octave kernel of src/render/effects/deepGlow.ts run on the CPU:
//   out = 1 - (1 - s)(1 - min(1, gain * K * s^p)^(1/q)).
//
//   node scripts/dg-fit-gain.ts <comp> <frames a,b,..> <radius> [p,q grid "2.2" "2.2,2.3"]
import { blurPlane, plane, reference, source } from "./dg-cpu.ts";

const DEEP_GLOW = { sigmaDivisor: 8.118, sigmaFloor: 2.147, minSigma: 0.858, octaveWeight: 1.132 };
const [comp, framesArg, radiusArg, pArg = "2.2", qArg = "2.2"] = process.argv.slice(2);
const radius = Number(radiusArg);
const count = Math.min(8, Math.log2(radius / DEEP_GLOW.sigmaDivisor / DEEP_GLOW.minSigma) + 1);
const octaves: [number, number][] = [];
for (let i = 0; i < Math.ceil(count); i++) {
  const s = (radius * 2 ** -i) / DEEP_GLOW.sigmaDivisor;
  octaves.push([Math.hypot(s, DEEP_GLOW.sigmaFloor), DEEP_GLOW.octaveWeight * Math.min(1, count - i)]);
}
for (const p of pArg.split(",").map(Number)) {
  for (const q of qArg.split(",").map(Number)) {
    const lines: string[] = [];
    let total = 0;
    for (const f of framesArg.split(",").map(Number)) {
      const src = source(comp, f);
      const ref = reference(comp, f);
      const { width: w, height: h } = src;
      const glow = [0, 1, 2].map((c) => {
        const lin = plane(src, c, (v) => Math.pow(v, p));
        const sum = new Float64Array(w * h);
        for (const [sigma, weight] of octaves) blurPlane(lin, w, h, sigma).forEach((v, i) => (sum[i] += weight * v));
        return sum;
      });
      let best = { gain: 0, err: Infinity, bad: 0 };
      for (let gain = 0; gain <= 40; gain += gain < 0.1 ? 0.001 : gain < 2 ? 0.01 : 0.1) {
        let err = 0;
        let bad = 0;
        for (let i = 0; i < w * h; i++) {
          for (let c = 0; c < 3; c++) {
            const s = src.data[i * 4 + c];
            const v = 255 * (1 - (1 - s) * (1 - Math.pow(Math.min(1, gain * glow[c][i]), 1 / q)));
            const d = Math.abs(Math.round(v) - Math.round(ref.data[i * 4 + c] * 255));
            err += d;
            if (d > 3) bad++;
          }
        }
        if (err < best.err) best = { gain, err, bad };
      }
      total += best.err / (w * h * 3);
      lines.push(`f${f}: gain ${best.gain.toFixed(3)} mean ${(best.err / (w * h * 3)).toFixed(3)} >3: ${((100 * best.bad) / (w * h * 3)).toFixed(2)}%`);
    }
    console.log(`p ${p} q ${q}: ${lines.join(" | ")}`);
  }
}
