// The palette cases of the keying fixtures for scripts/check-keying-fit.ts: each quadrant of each frame of the comps
// scripts/fixtures/build_keying.py tiles the palette with, and the keyingMath.ts model of its effect at the
// parameters the fixture keyed for that frame.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { colorKey, colorRange, extract, linearKey, linearKeyAlpha, lumaKey, spillStandard, spillSuppress } from "../src/render/effects/keyingMath.ts";
import type { KeyingCell } from "./check-keying-cells.ts";
import { ROOT } from "./lib/suites.ts";

type Value = number | number[];
type Params = Record<string, Value | Value[]>;

export interface KeyingCase {
  comp: string;
  frame: number;
  quadrant: number;
  label?: string;
  /** Premultiplied RGBA 0-1 in and out. */
  model: (src: number[], cell: KeyingCell) => number[];
  skip?: (cell: KeyingCell) => boolean;
}

interface TileTable {
  frames: number;
  bg: number[] | null;
  tiles: ({ effect: string; params: Params } | null)[];
}

/** A parameter's value at a frame: lists of numbers for scalar parameters, and lists of lists, are keyed per frame. */
function at(value: Value | Value[], frame: number, vector: boolean): Value {
  if (!Array.isArray(value)) return value;
  const keyed = Array.isArray(value[0]) || !vector;
  if (!keyed) return value as number[];
  return (value as Value[])[Math.min(frame, value.length - 1)];
}

const VECTORS = new Set(["ADBE Linear Color Key2:3", "ADBE Color Key:1", "ADBE Color Difference Key:3", "ADBE Spill Suppressor:1", "ADBE Spill2:3"]);

type Model = (p: (index: number) => Value) => ((src: number[]) => number[]) | null;

const straight = (src: number[]) => [0, 1, 2].map((c) => (src[3] > 0 ? src[c] / src[3] : 0));

/** A pixel keeping `m` of its alpha (or given its new alpha `a`); View = Matte shows that alpha as grey. */
function keyed(src: number[], m: number, view = 1, a = src[3] * m): number[] {
  if (view === 3) return [a, a, a, 1];
  if (view === 2) return src;
  return straight(src).map((v) => Math.min(1, v) * a).concat(a);
}

const n = (v: Value) => v as number;
const v3 = (v: Value) => v as number[];

const MODELS: Record<string, Model> = {
  "ADBE Linear Color Key2": (p) => (src) => {
    const m = linearKey(straight(src), { key: v3(p(3)), match: n(p(4)), tolerance: n(p(5)) / 100, softness: n(p(6)) / 100, keep: p(7) === 2 });
    return keyed(src, m, n(p(2)), linearKeyAlpha(src[3], m, p(7) === 2));
  },
  "ADBE Color Key": (p) => (src) => keyed(src, colorKey(straight(src), src[3], v3(p(1)), n(p(2)))),
  "ADBE Luma Key": (p) => (src) => keyed(src, lumaKey(straight(src), n(p(1)), n(p(2)), n(p(3)))),
  "ADBE Extract": (p) => (src) =>
    keyed(src, extract(straight(src), src[3], { channel: n(p(2)), black: n(p(3)), white: n(p(4)), blackSoftness: n(p(5)), whiteSoftness: n(p(6)), invert: !!p(7) })),
  "ADBE Color Range": (p) => (src) =>
    keyed(src, colorRange(straight(src), n(p(3)), [n(p(4)), n(p(6)), n(p(8))], [n(p(5)), n(p(7)), n(p(9))], n(p(2)))),
  "ADBE Spill Suppressor": (p) => (src) => spillSuppress(straight(src), v3(p(1)), n(p(3)) / 100).map((v) => v * src[3]).concat(src[3]),
  "ADBE Spill2": (p) =>
    n(p(1)) === 1 ? (src) => spillStandard(straight(src), n(p(1001)) / 100).map((v) => v * src[3]).concat(src[3]) : null,
};

const PALETTE_SOURCES = new Set(["keying_lck_rgb", "keying_lck_hue", "keying_lck_chroma", "keying_lck_keep", "keying_ckey_tol", "keying_luma_types", "keying_extract", "keying_crange", "keying_cdk_views", "keying_dmatte", "keying_spill", "keying_spill2", "keying_spill2_std"]);

function load(): KeyingCase[] {
  const table = JSON.parse(readFileSync(join(ROOT, "fixtures", "keying.palette.json"), "utf8")).comps as Record<string, TileTable>;
  const cases: KeyingCase[] = [];
  for (const [comp, t] of Object.entries(table)) {
    if (!PALETTE_SOURCES.has(comp)) continue;
    for (let frame = 0; frame < t.frames; frame++) {
      t.tiles.forEach((tile, quadrant) => {
        if (!tile) return;
        const make = MODELS[tile.effect];
        const p = (index: number) => at(tile.params[`p${index}`], frame, VECTORS.has(`${tile.effect}:${index}`));
        const model = make?.(p);
        if (!model) return;
        const label = Object.keys(tile.params).map((k) => `${k}=${JSON.stringify(p(Number(k.slice(1))))}`).join(" ");
        cases.push({ comp, frame, quadrant, label, model: (src) => model(src) });
      });
    }
  }
  return cases;
}

export const keyingCases = load();
