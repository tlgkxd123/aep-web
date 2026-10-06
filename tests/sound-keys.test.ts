// Sound Keys' Apply: the analysis follows the audio inside each range box, and
// the generated keyframes replace only the applied span (saved, undoable).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CompItem, Property, PropertyGroup } from "../src/aep/model.ts";
import { parseProject } from "../src/aep/parse.ts";
import { Editor } from "../src/edit/editor.ts";
import { computeSoundKeys, FALLOFF, RANGE_TYPE, type SoundKeysRange, type SoundKeysSettings } from "../src/media/soundKeys.ts";

const RATE = 44100;
const W = 1920;
const H = 1080;
/** Display column of frequency `hz` (log axis 15 Hz .. 22050 Hz over 5%..95% of the width). */
const columnOf = (hz: number) => 0.05 * W + 0.9 * W * (Math.log(hz / 15) / Math.log(22050 / 15));

function settings(ranges: Partial<SoundKeysRange>[]): SoundKeysSettings {
  return {
    width: W,
    height: H,
    channel: undefined,
    scale: 1,
    eq: [1, 1, 1, 1],
    keysPerSecond: 30,
    audioLayer: 1,
    ranges: ranges.map((r, i) => ({
      output: 21 + 12 * i, type: RANGE_TYPE.AVERAGE, x0: 0, x1: 0, yTop: 100, yBottom: 830,
      falloff: FALLOFF.INSTANT, falloffTime: 0, min: 0, max: 100, ...r,
    })),
  };
}

/** A 60 Hz tone that is on for the first second only. */
const tone = (first: number, length: number) =>
  Float32Array.from({ length }, (_, i) => {
    const t = (first + i) / RATE;
    return t >= 0 && t < 1 ? 0.5 * Math.sin(2 * Math.PI * 60 * t) : 0;
  });

describe("Sound Keys analysis", () => {
  it("rises where the range covers the tone and stays at zero elsewhere", () => {
    const s = settings([
      { x0: columnOf(50), x1: columnOf(72) },
      { x0: columnOf(2000), x1: columnOf(4000) },
    ]);
    const { times, outputs } = computeSoundKeys(s, RATE, tone, 0, 2);
    expect(times).toHaveLength(61);
    const at = (t: number) => times.findIndex((x) => Math.abs(x - t) < 1e-9);
    expect(outputs[0][at(0.5)]).toBeGreaterThan(20);
    expect(outputs[0][at(1.6)]).toBe(0);
    expect(Math.max(...outputs[1])).toBe(0);
  });

  it("integrates, falls off linearly and maps the output range", () => {
    const box = { x0: columnOf(50), x1: columnOf(72) };
    const s = settings([
      { ...box, falloff: FALLOFF.INTEGRATE, min: 0, max: 1 },
      { ...box, falloff: FALLOFF.LINEAR, falloffTime: 2 },
      { ...box, min: -180, max: 180 },
    ]);
    const { times, outputs } = computeSoundKeys(s, RATE, tone, 0, 2);
    const integrated = outputs[0];
    for (let i = 1; i < integrated.length; i++) expect(integrated[i]).toBeGreaterThanOrEqual(integrated[i - 1]);
    const end = times.length - 1;
    const instant = outputs[2];
    // After the tone stops the instant output drops to its minimum; the linear one is still falling.
    expect(instant[end]).toBe(-180);
    expect(outputs[1][end]).toBeGreaterThan(0);
  });
});

describe("replaceKeyframes", () => {
  it("replaces only the applied span, as one undo step that survives saving", () => {
    const editor = Editor.fromBytes(new Uint8Array(readFileSync(new URL("../refs/fixtures/fixtures.aep", import.meta.url))));
    const opacityIn = (c: CompItem, layerId: number) => {
      const group = c.layers.find((l) => l.id === layerId)?.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Transform Group");
      return group?.children.find((n): n is Property => n.kind === "property" && n.matchName === "ADBE Opacity");
    };
    const stored = (p: Property | undefined) => !!p?.chunk && !p.synthesized && !p.keyframes.length;
    const comp = [...editor.project.items.values()].find(
      (i): i is CompItem => i.kind === "comp" && i.duration >= 1 && i.layers.some((l) => stored(opacityIn(i, l.id))),
    )!;
    const layer = comp.layers.find((l) => stored(opacityIn(comp, l.id)))!;
    const opacityOf = (c: CompItem) => opacityIn(c, layer.id)!;
    const keys = (count: number, value: (i: number) => number) => Array.from({ length: count }, (_, i) => ({ time: i * 0.1, value: value(i) }));
    editor.replaceKeyframes(comp, layer, [{ prop: opacityOf(comp), keys: keys(6, (i) => i * 10) }], 0, 0.5);
    editor.replaceKeyframes(comp, layer, [{ prop: opacityOf(comp), keys: [{ time: 0.2, value: 99 }] }], 0.15, 0.35);
    const saved = () => [...parseProject(editor.save()).items.values()].find((i): i is CompItem => i.kind === "comp" && i.id === comp.id)!;
    const after = opacityOf(saved()).keyframes;
    expect(after.map((k) => Math.round(k.time * 10))).toEqual([0, 1, 2, 4, 5]);
    expect(after.map((k) => k.value)).toEqual([0, 10, 99, 40, 50]);
    editor.undo();
    expect(opacityOf(saved()).keyframes.map((k) => k.value)).toEqual([0, 10, 20, 30, 40, 50]);
  });
});
