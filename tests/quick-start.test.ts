// The Quick Start templates (src/quickstart/): a song's bass as keyframes, and the Trap Nation projects built
// around a song, a background and a logo, as they read back from the saved file.
import { afterEach, describe, expect, it } from "vitest";
import { currentValue, setExpressionScope, valueAtTime } from "../src/aep/evaluate.ts";
import type { CompItem, Layer, Property, PropertyGroup, Shape } from "../src/aep/model.ts";
import { Editor } from "../src/edit/editor.ts";
import { MaskMode } from "../src/edit/masks.ts";
import type { FootageFile } from "../src/edit/project.ts";
import { anchorInComp } from "../src/edit/transform-ops.ts";
import "../src/expressions/install.ts";
import type { AudioData } from "../src/media/audio.ts";
import { bassLevels, levelKeyframes } from "../src/quickstart/bass.ts";
import { buildQuickStart, quickStartFrameRate, RING_RADIUS } from "../src/quickstart/build.ts";
import { QUICK_START_TEMPLATES, type QuickStartId } from "../src/quickstart/catalog.ts";

afterEach(() => setExpressionScope(undefined));

const RATE = 48000;
const SECONDS = 4;

/** Kicks twice a second (55 Hz, decaying) over a quiet 440 Hz tone. */
function kicks(seconds = SECONDS, rate = RATE): AudioData {
  const data = new Float32Array(seconds * rate);
  for (let i = 0; i < data.length; i++) {
    const t = i / rate;
    const phase = (t * 2) % 1;
    data[i] = 0.05 * Math.sin(2 * Math.PI * 440 * t) + 0.8 * Math.exp(-phase * 12) * Math.sin(2 * Math.PI * 55 * t);
  }
  return { sampleRate: rate, numberOfChannels: 2, length: data.length, getChannelData: () => data };
}

const SONG: FootageFile = {
  path: "C:\\music\\song.wav",
  info: { kind: "audio", format: "WAVE", width: 0, height: 0, duration: SECONDS, frameRate: 0, hasAlpha: false, audio: { sampleRate: RATE, samples: RATE * SECONDS } },
};
const MUSIC_VIDEO: FootageFile = {
  path: "C:\\music\\video.mp4",
  info: { kind: "video", format: "XCEX", width: 1280, height: 720, duration: 3.5, frameRate: 30, hasAlpha: false, audioTrackRate: 48000 },
};
const WALLPAPER: FootageFile = { path: "C:\\art\\wallpaper.png", info: { kind: "png", format: "PNGf", width: 1280, height: 720, duration: 0, frameRate: 0, hasAlpha: false } };
const LOGO: FootageFile = { path: "C:\\art\\logo.jpg", info: { kind: "jpeg", format: "JPEG", width: 500, height: 400, duration: 0, frameRate: 0, hasAlpha: false } };

const reopen = (editor: Editor) => {
  const project = Editor.fromBytes(editor.save()).project;
  const comps = [...project.items.values()].filter((i): i is CompItem => i.kind === "comp");
  expect(comps).toHaveLength(1);
  return { project, comp: comps[0] };
};
const layerNamed = (comp: CompItem, name: string) => comp.layers.find((l) => l.name === name)!;
const groupOf = (layer: Layer, matchName: string) =>
  (layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === matchName)?.children ?? []).filter(
    (n): n is PropertyGroup => n.kind === "group",
  );
const effects = (layer: Layer) => groupOf(layer, "ADBE Effect Parade");
const masks = (layer: Layer) => groupOf(layer, "ADBE Mask Parade").filter((m) => !!m.mask);
const param = (effect: PropertyGroup, n: number) =>
  effect.children.find((c): c is Property => c.kind === "property" && c.matchName === `${effect.matchName}-${String(n).padStart(4, "0")}`)!;
const transform = (layer: Layer, matchName: string) =>
  (layer.properties.find((n): n is PropertyGroup => n.matchName === "ADBE Transform Group")!.children.find((c) => c.matchName === matchName) as Property);
const maskShape = (mask: PropertyGroup) => (mask.children.find((c) => c.matchName === "ADBE Mask Shape") as Property).value as unknown as Shape;
const bassSlider = (comp: CompItem) => param(effects(layerNamed(comp, "Controls")).find((e) => e.name === "Bass")!, 1);

describe("the bass of a song", () => {
  it("rises to 100 on each kick and falls back between them", () => {
    const fps = 30;
    const levels = bassLevels(kicks(), fps, SECONDS * fps);
    expect(levels).toHaveLength(120);
    expect(Math.max(...levels)).toBe(100);
    expect(Math.min(...levels)).toBe(0);
    for (const kick of [0, 15, 30, 45, 60, 75, 90, 105]) {
      expect(levels[kick + 1]).toBeGreaterThan(70);
      expect(levels[kick + 12]).toBeLessThan(levels[kick + 1] / 2);
    }
  });

  it("reads silence as 0", () => {
    const silence: AudioData = { sampleRate: RATE, numberOfChannels: 1, length: RATE, getChannelData: () => new Float32Array(RATE) };
    expect([...bassLevels(silence, 30, 30)].every((v) => v === 0)).toBe(true);
  });

  it("keeps the keyframes linear interpolation needs to stay within the tolerance", () => {
    const fps = 30;
    const levels = bassLevels(kicks(), fps, SECONDS * fps);
    const keys = levelKeyframes(levels, fps, 0.5);
    expect(keys[0]).toEqual({ time: 0, value: levels[0] });
    expect(keys.at(-1)).toEqual({ time: (levels.length - 1) / fps, value: levels.at(-1) });
    expect(keys.length).toBeLessThan(levels.length);
    for (let f = 0; f < levels.length; f++) {
      const t = f / fps;
      const after = keys.findIndex((k) => k.time >= t - 1e-9);
      const b = keys[after];
      const a = keys[Math.max(0, after - 1)];
      const value = b.time - a.time > 1e-9 ? a.value + ((b.value - a.value) * (t - a.time)) / (b.time - a.time) : b.value;
      expect(Math.abs(value - levels[f])).toBeLessThanOrEqual(0.5 + 1e-9);
    }
    const flat = levelKeyframes(new Float32Array(300), fps);
    expect(flat.length).toBeGreaterThanOrEqual(2);
    expect(flat.every((k, i) => i === 0 || k.time - flat[i - 1].time <= 2 + 1e-9)).toBe(true);
  });
});

describe.each(QUICK_START_TEMPLATES.map((t) => [t.id, t.name] as [QuickStartId, string]))("the %s template", (id, name) => {
  const polar = id === "trap-nation-2020";

  it("is a comp as long as the song with the rig, the ring, the particles, the background and the song", async () => {
    const { editor } = await buildQuickStart(id, { song: SONG }, { audio: kicks() });
    expect(editor.history).toEqual([]);
    expect(editor.dirty).toBe(true);
    const { project, comp } = reopen(editor);
    const fps = quickStartFrameRate(id);
    expect({ name: comp.name, width: comp.width, height: comp.height, frameRate: comp.frameRate }).toEqual({ name, width: 1920, height: 1080, frameRate: fps });
    expect(comp.duration).toBeCloseTo(SECONDS, 6);
    expect(comp.layers.map((l) => l.name)).toEqual(["Controls", "Shake", "Bounce", "Logo", "Spectrum", "Particles", "Background", "song.wav"]);

    const byName = (n: string) => layerNamed(comp, n);
    expect(byName("Bounce").parentId).toBe(byName("Shake").id);
    expect(byName("Logo").parentId).toBe(byName("Bounce").id);
    expect(byName("Spectrum").parentId).toBe(byName("Bounce").id);
    expect(byName("Background").parentId).toBe(byName("Shake").id);
    expect(byName("Particles").parentId).toBe(0);
    const song = project.items.get(byName("song.wav").sourceId);
    expect(song?.kind === "footage" && song.mainSource.sourceType === "FileSource" ? song.mainSource.file : null).toBe(SONG.path);

    expect(effects(byName("Controls")).map((e) => e.name)).toEqual(["Bass", "Bounce", "Shake"]);
    expect(effects(byName("Particles")).map((e) => e.matchName)).toEqual(["tc Particular"]);
    expect(effects(byName("Background")).map((e) => e.matchName)).toEqual(["ADBE Ramp", "ADBE Gaussian Blur 2", "ADBE Brightness & Contrast 2"]);
    expect(effects(byName("Logo")).map((e) => e.matchName)).toEqual(["ADBE Ramp"]);
  });

  it("draws the ring from the song's bass with Audio Spectrums stacked back to front", async () => {
    const { editor } = await buildQuickStart(id, { song: SONG }, { audio: kicks() });
    const { comp } = reopen(editor);
    const spectrum = layerNamed(comp, "Spectrum");
    const songIndex = layerNamed(comp, "song.wav").index;
    const list = effects(spectrum);
    const spectra = list.filter((e) => e.matchName === "ADBE AudSpect");
    expect(list.map((e) => e.matchName).slice(spectra.length)).toEqual(polar ? ["ADBE Polar Coordinates", "ADBE Mirror", "ADBE Glo2"] : ["ADBE Mirror"]);
    expect(spectra.length).toBeGreaterThanOrEqual(3);
    spectra.forEach((effect, i) => {
      expect(param(effect, 1).value).toBe(songIndex);
      expect(param(effect, 4).value).toBe(polar ? 0 : 1);
      expect(param(effect, 21).value).toBe(2);
      expect(param(effect, 23).value).toBe(i > 0 ? 1 : 0);
      expect(param(effect, 14).value).toEqual(param(effect, 15).value);
    });
    // The front one is white and averages over the longest window.
    const durations = spectra.map((e) => param(e, 10).value as number);
    expect(durations).toEqual([...durations].sort((a, b) => a - b));
    expect((param(spectra.at(-1)!, 14).value as number[]).slice(0, 3)).toEqual([1, 1, 1]);

    if (polar) {
      expect(masks(spectrum)).toEqual([]);
      expect(param(spectra[0], 2).value).toEqual([0, 2 * RING_RADIUS]);
      expect(param(spectra[0], 3).value).toEqual([960, 2 * RING_RADIUS]);
      const polarFx = list.find((e) => e.matchName === "ADBE Polar Coordinates")!;
      expect([param(polarFx, 1).value, param(polarFx, 2).value]).toEqual([1, 1]);
    } else {
      const [ring] = masks(spectrum);
      expect(ring.name).toBe("Ring");
      expect(ring.mask?.maskMode).toBe(MaskMode.NONE);
      const shape = maskShape(ring);
      expect(shape.closed).toBe(false);
      expect(shape.vertices.map((v) => v.map(Math.round))).toEqual([
        [960, 540 - RING_RADIUS],
        [960 - RING_RADIUS, 540],
        [960, 540 + RING_RADIUS],
      ]);
    }
    const mirror = list.find((e) => e.matchName === "ADBE Mirror")!;
    expect([param(mirror, 1).value, param(mirror, 2).value]).toEqual([[960, 540], 0]);
  });

  it("keys Bass from the song and drives the bounce, the shake and the particles with it", async () => {
    const { editor } = await buildQuickStart(id, { song: SONG }, { audio: kicks() });
    const { project, comp } = reopen(editor);
    setExpressionScope({ project, warn: (message) => expect.fail(message) });
    const fps = quickStartFrameRate(id);
    const bass = bassSlider(comp);
    expect(bass.keyframes.length).toBeGreaterThan(8);
    expect(bass.keyframes.length).toBeLessThan(SECONDS * fps);
    expect(bass.keyframes.every((k) => (k.value as number) >= 0 && (k.value as number) <= 100)).toBe(true);

    const controls = layerNamed(comp, "Controls");
    const at = (layerName: string, prop: (l: Layer) => Property, time: number) => currentValue(prop(layerNamed(comp, layerName)), time, layerNamed(comp, layerName));
    const kick = 1 / fps;
    const between = 0.4;
    const level = (t: number) => (currentValue(bass, t, controls) as number) / 100;
    expect(level(kick)).toBeGreaterThan(0.7);
    expect(level(between)).toBeLessThan(0.2);

    // The expressions start from the rig's resting values: Shake at the comp's centre, Bounce at 100 %.
    for (const [name, matchName, rest] of [["Shake", "ADBE Position", [960, 540, 0]], ["Bounce", "ADBE Scale", [100, 100, 100]]] as const) {
      const layer = layerNamed(comp, name);
      expect(valueAtTime(transform(layer, matchName), 0, layer)).toEqual(rest);
    }
    const bounce = param(effects(controls).find((e) => e.name === "Bounce")!, 1).value as number;
    const scale = at("Bounce", (l) => transform(l, "ADBE Scale"), kick) as number[];
    expect(scale[0]).toBeCloseTo(100 + bounce * level(kick), 6);
    expect(scale[1]).toBeCloseTo(scale[0], 6);

    const shake = param(effects(controls).find((e) => e.name === "Shake")!, 1).value as number;
    const offset = (t: number) => {
      const [x, y] = at("Shake", (l) => transform(l, "ADBE Position"), t) as number[];
      return Math.hypot(x - 960, y - 540);
    };
    const times = Array.from({ length: SECONDS * 10 }, (_, i) => i / 10);
    expect(Math.max(...times.map(offset))).toBeLessThanOrEqual(2 * shake);
    expect(offset(2.9)).toBeLessThan(Math.max(...[kick, 0.5 + kick, 1 + kick].map(offset)));
    // The logo, the ring and the background stay centred, within the shake.
    for (const name of ["Logo", "Spectrum", "Background"]) {
      for (const t of [0, kick, 0.4, 2.9]) {
        const [x, y] = anchorInComp(comp, layerNamed(comp, name), t);
        expect(Math.hypot(x - 960, y - 540)).toBeLessThanOrEqual(2 * shake);
      }
    }

    const particular = effects(layerNamed(comp, "Particles"))[0];
    const timeFactor = (t: number) => at("Particles", () => param(particular, 25), t) as number;
    expect(timeFactor(kick)).toBeCloseTo(0.5 + 2.5 * level(kick), 6);
    expect(timeFactor(kick)).toBeGreaterThan(timeFactor(between));
  });

  it("puts the background image behind, covering the frame, and the logo in the ring's circle", async () => {
    const { editor } = await buildQuickStart(id, { song: SONG, background: WALLPAPER, logo: LOGO });
    const { comp } = reopen(editor);
    expect(comp.layers.map((l) => l.name)).toEqual(["Controls", "Shake", "Bounce", "logo.jpg", "Spectrum", "Particles", "wallpaper.png", "song.wav"]);
    const background = layerNamed(comp, "wallpaper.png");
    const backgroundScale = 110 * Math.max(1920 / 1280, 1080 / 720);
    expect((transform(background, "ADBE Scale").value as number[])[0]).toBeCloseTo(backgroundScale, 6);
    expect(effects(background).map((e) => e.matchName)).toEqual(["ADBE Gaussian Blur 2", "ADBE Brightness & Contrast 2"]);

    const logo = layerNamed(comp, "logo.jpg");
    expect((transform(logo, "ADBE Scale").value as number[])[0]).toBeCloseTo((100 * 2 * RING_RADIUS) / 400, 6);
    const [circle] = masks(logo);
    expect(circle.mask?.maskMode).toBe(MaskMode.ADD);
    const shape = maskShape(circle);
    expect(shape.closed).toBe(true);
    expect(shape.vertices.map((v) => v.map((c) => Math.round(c)))).toEqual([
      [250, 0],
      [50, 200],
      [250, 400],
      [450, 200],
    ]);
    expect(bassSlider(comp).keyframes).toEqual([]);
    for (const layer of [background, logo]) expect(anchorInComp(comp, layer, 0).map(Math.round)).toEqual([960, 540]);
  });
});

describe("Quick Start media", () => {
  it("shows the background image in the circle when there is no logo", async () => {
    const { editor } = await buildQuickStart("trap-nation-2018", { song: SONG, background: WALLPAPER });
    const { comp } = reopen(editor);
    expect(comp.layers.map((l) => l.name)).toEqual(["Controls", "Shake", "Bounce", "wallpaper.png", "Spectrum", "Particles", "wallpaper.png", "song.wav"]);
    expect(comp.layers[3].sourceId).toBe(comp.layers[6].sourceId);
    expect(masks(comp.layers[3])).toHaveLength(1);
  });

  it("leaves the particles out on request", async () => {
    const { editor } = await buildQuickStart("trap-nation-2020", { song: SONG }, { particles: false });
    const { comp } = reopen(editor);
    expect(comp.layers.map((l) => l.name)).not.toContain("Particles");
    expect(comp.layers).toHaveLength(7);
  });

  it("takes the sound of a music video, which is heard but not seen", async () => {
    const { editor } = await buildQuickStart("trap-nation-2020", { song: MUSIC_VIDEO });
    const { comp } = reopen(editor);
    const video = layerNamed(comp, "video.mp4");
    expect(video.enabled).toBe(false);
    expect(video.audioEnabled).toBe(true);
    expect(comp.duration).toBeCloseTo(3.5, 6);
  });

  it("refuses a song without sound and a background that is not a picture", async () => {
    await expect(buildQuickStart("trap-nation-2018", { song: WALLPAPER })).rejects.toThrow(/has no sound/);
    await expect(buildQuickStart("trap-nation-2018", { song: { ...MUSIC_VIDEO, info: { ...MUSIC_VIDEO.info, audioTrackRate: undefined } } })).rejects.toThrow(/has no sound/);
    await expect(buildQuickStart("trap-nation-2018", { song: SONG, background: SONG })).rejects.toThrow(/not an image or a movie/);
  });
});
