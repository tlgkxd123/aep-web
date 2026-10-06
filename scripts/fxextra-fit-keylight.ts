// Compares the Keylight model in src/render/effects/keylight.ts with After Effects'
// output on the palette cells of the fxextra Keylight fixtures, per quadrant.
//
//   node scripts/fxextra-fit-keylight.ts [--verbose]
import { readFileSync } from "node:fs";
import { keylightPixel, type KeylightSettings } from "../src/render/effects/keylightMath.ts";
import { paletteCells } from "./fxextra-cells.ts";
import { framePath } from "./lib/suites.ts";
import { readTiff } from "./lib/tiff.ts";

const RED = [1, 0.003921568859368563, 0];
/** aepfix.BG, under every Keylight tile. */
const BG = [0.12, 0.16, 0.3];
const ORANGE = [0.6431372761726379, 0.1197720468044281, 0.05800845846533775];
const base: KeylightSettings = { view: 11, unpremultiply: true, screen: RED, gain: 1, balance: 0.5, clipBlack: 0, clipWhite: 1, sourceAlpha: 3, replace: [0.4980392156862745, 0.4980392156862745, 0.4980392156862745] };
const cases: [string, number, Partial<KeylightSettings>][] = [
  ["fxextra_keylight_red", 0, {}],
  ["fxextra_keylight_red", 1, { view: 5 }],
  ["fxextra_keylight_red", 2, { view: 10 }],
  ["fxextra_keylight_red", 3, { balance: 0 }],
  ["fxextra_keylight_colours", 0, { screen: ORANGE }],
  ["fxextra_keylight_colours", 1, { screen: [1, 0.0941176563501358, 0] }],
  ["fxextra_keylight_colours", 2, { screen: [1, 0.11372549831867218, 1] }],
  ["fxextra_keylight_colours", 3, { screen: [0, 1, 0] }],
  ["fxextra_keylight_mattes", 0, { view: 5, balance: 0 }],
  ["fxextra_keylight_mattes", 1, { view: 5, screen: ORANGE }],
  ["fxextra_keylight_mattes", 2, { view: 5, balance: 1 }],
  ["fxextra_keylight_mattes", 3, { view: 5, screen: [0.1, 0.3, 0.9] }],
  ["fxextra_keylight_controls", 0, { view: 5, gain: 1.5 }],
  ["fxextra_keylight_controls", 1, { view: 5, clipBlack: 0.2, clipWhite: 0.8 }],
  ["fxextra_keylight_controls", 2, { unpremultiply: false }],
  ["fxextra_keylight_controls", 3, { sourceAlpha: 1 }],
  ["fxextra_keylight_final2", 0, { gain: 0.6 }],
  ["fxextra_keylight_final2", 1, { clipBlack: 0.1, clipWhite: 0.7 }],
  ["fxextra_keylight_final2", 2, { balance: 0, screen: ORANGE }],
  ["fxextra_keylight_final2", 3, { screen: [0, 0.2, 1] }],
  ["fxextra_keylight_gain", 0, { gain: 0.8 }],
  ["fxextra_keylight_gain", 1, { view: 5, gain: 2 }],
  ["fxextra_keylight_gain", 2, { gain: 1.3, clipBlack: 0.05, clipWhite: 0.9 }],
  ["fxextra_keylight_gain", 3, { gain: 1.2, balance: 0, screen: ORANGE }],
];
const verbose = process.argv.includes("--verbose");
const cells = paletteCells();
for (const [comp, q, overrides] of cases) {
  const tiff = readTiff(new Uint8Array(readFileSync(framePath(comp, 0))));
  const settings = { ...base, ...overrides };
  let worst = 0;
  let bad = 0;
  const lines: string[] = [];
  for (const cell of cells) {
    const x = (q % 2) * 160 + cell.col * 8 + 4;
    const y = Math.floor(q / 2) * 120 + cell.row * 8 + 4;
    const i = (y * tiff.width + x) * 4;
    const ref = [...tiff.data.subarray(i, i + 4)];
    const a = cell.src[3] / 255;
    const premul = [0, 1, 2].map((c) => (cell.src[c] / 255) * a);
    const keyed = keylightPixel([...premul, a], settings);
    // The references composite the keyed layer over the opaque fixture background.
    const out = [0, 1, 2].map((c) => Math.round((keyed[c] + BG[c] * (1 - keyed[3])) * 255)).concat(255);
    if (process.env.KL_DEBUG && cell.src.join(",") === process.env.KL_DEBUG) console.log(comp, q, settings, premul, a, keyed);
    const pRef = ref;
    const diff = Math.max(...pRef.map((v, c) => Math.abs(v - out[c])));
    worst = Math.max(worst, diff);
    if (diff > 3) {
      bad++;
      lines.push(`  ${cell.src.join(",").padEnd(16)} ref ${pRef.map((v) => Math.round(v)).join(",").padEnd(16)} ours ${out.join(",")}`);
    }
  }
  console.log(`${comp} q${q}: ${bad}/${cells.length} cells off by more than 3, worst ${worst.toFixed(1)}`);
  if (verbose) console.log(lines.slice(0, 25).join("\n"));
}
