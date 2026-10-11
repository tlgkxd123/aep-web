// Particle Match's Export to Particular: a new After Effects project with the Particular layers over their
// soundtrack, and layers added to a composition of the open project.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { CompItem, Layer, Property, PropertyGroup } from "../src/aep/model.ts";
import { activeCameraLayer, defaultCameraZoom, localTransform } from "../src/aep/transform.ts";
import { Editor } from "../src/edit/editor.ts";
import { addLayer } from "../src/edit/layers.ts";
import { DEFAULT_COMP_SETTINGS, importFootage, newComposition, newProject, type FootageFile } from "../src/edit/project.ts";
import { audioFeatures, channelReader } from "../src/extra/pmatch/audio.ts";
import { effectParam, MIRROR, PARTICULAR, PARTICULAR_PARAM as P, particularSettings } from "../src/extra/pmatch/particular.ts";
import { addParticularLayers, compTarget, layerSound, particularProject, soundLayers } from "../src/extra/pmatch/particularExport.ts";
import { clearAudio, registerAudio } from "../src/media/audio.ts";
import { swingingFeatures, syntheticModel } from "./pmatch-fixtures.ts";

afterEach(clearAudio);

const VIDEO: FootageFile = {
  path: "C:\\media\\reference.mp4",
  info: { kind: "video", format: "XCEX", width: 1280, height: 720, duration: 10, frameRate: 30, hasAlpha: false, audioTrackRate: 48000 },
};
const SONG: FootageFile = {
  path: "C:\\media\\song.wav",
  info: { kind: "audio", format: "WAVE", width: 0, height: 0, duration: 4, frameRate: 0, hasAlpha: false, audio: { sampleRate: 48000, samples: 192000 } },
};
const COMP = { name: "Particles", width: 1920, height: 1080, frameRate: 30, duration: 5 };

const onlyComp = (bytes: Uint8Array): CompItem => {
  const comps = [...Editor.fromBytes(bytes).project.items.values()].filter((i): i is CompItem => i.kind === "comp");
  expect(comps).toHaveLength(1);
  return comps[0];
};
const effectsOf = (layer: Layer) =>
  (layer.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Effect Parade")?.children ?? []).map((e) => e.matchName);
const timeFactorKeys = (layer: Layer) => effectParam(layer, PARTICULAR, P.timeFactor)!.keyframes.map((k) => k.value);

/** Bass kicks twice a second over a quiet hum. */
function kicks(seconds: number, rate: number): Float32Array {
  const out = new Float32Array(seconds * rate);
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const phase = (t * 2) % 1;
    out[i] = 0.05 * Math.sin(2 * Math.PI * 440 * t) + 0.8 * Math.exp(-phase * 12) * Math.sin(2 * Math.PI * 55 * t);
  }
  return out;
}

describe("Export to Particular as a new project", () => {
  it("holds a comp of the chosen settings with one Particular layer per speed class over the soundtrack", async () => {
    const model = syntheticModel(700);
    const features = swingingFeatures(6);
    const { bytes, settings } = await particularProject(model, { comp: COMP, soundtrack: VIDEO, features });
    const comp = onlyComp(bytes);
    expect({ name: comp.name, width: comp.width, height: comp.height, frameRate: comp.frameRate }).toEqual({ name: "Particles", width: 1920, height: 1080, frameRate: 30 });
    expect(comp.duration).toBeCloseTo(5, 6);
    expect(settings).toEqual(particularSettings(model, { width: 1920, height: 1080, frameRate: 30, duration: 5, zoom: 1920 / 0.72 }, features));

    const [slow, medium, fast, reference] = comp.layers;
    expect([slow, medium, fast].map((l) => l.name)).toEqual(["Particles (slow)", "Particles (medium)", "Particles (fast)"]);
    for (const layer of [slow, medium, fast]) {
      expect(effectsOf(layer)).toEqual([PARTICULAR, MIRROR]);
      expect(timeFactorKeys(layer)).toEqual((settings.timeFactor as { value: number }[]).map((k) => k.value));
    }
    // The soundtrack: the reference video at its path, heard but not seen, framed as the particles are.
    const footage = Editor.fromBytes(bytes).project.items.get(reference.sourceId);
    expect(footage?.kind === "footage" && footage.mainSource.sourceType === "FileSource" ? footage.mainSource.file : null).toBe(VIDEO.path);
    expect(reference.enabled).toBe(false);
    expect(reference.audioEnabled).toBe(true);
    expect(localTransform(reference, 0).scale.slice(0, 2).map((v) => Math.round(v * 1000) / 1000)).toEqual([150, 150]);
  });

  it("puts an audio file under the particles as a layer that is heard", async () => {
    const { bytes } = await particularProject(syntheticModel(null), { comp: { ...COMP, duration: 4 }, soundtrack: SONG, features: swingingFeatures(4) });
    const comp = onlyComp(bytes);
    const song = comp.layers.at(-1)!;
    const footage = Editor.fromBytes(bytes).project.items.get(song.sourceId);
    expect(footage?.kind === "footage" && footage.hasAudio && footage.mainSource.sourceType === "FileSource" ? footage.mainSource.file : null).toBe(SONG.path);
    expect(song.audioEnabled).toBe(true);
    expect(comp.layers.slice(0, -1).every((l) => effectsOf(l)[0] === PARTICULAR)).toBe(true);
  });

  it("runs the particles at a constant speed without a soundtrack", async () => {
    const { bytes, settings } = await particularProject(syntheticModel(null), { comp: COMP, soundtrack: null, features: null });
    const comp = onlyComp(bytes);
    expect(typeof settings.timeFactor).toBe("number");
    expect(comp.layers.map((l) => l.name)).toEqual(settings.layers.map((l) => l.name));
    for (const layer of comp.layers) {
      const factor = effectParam(layer, PARTICULAR, P.timeFactor)!;
      expect(factor.keyframes).toHaveLength(0);
      expect(factor.value).toBeCloseTo(settings.timeFactor as number, 4);
    }
  });
});

describe("Export to Particular into an open project", () => {
  const cameraComp = () => {
    const editor = Editor.fromBytes(new Uint8Array(readFileSync("refs/fixtures/fixtures.aep")));
    const comp = [...editor.project.items.values()].find((i): i is CompItem => i.kind === "comp" && i.name === "three_d_camera")!;
    const camera = activeCameraLayer(comp, 0)!;
    const options = camera.properties.find((n): n is PropertyGroup => n.kind === "group" && n.matchName === "ADBE Camera Options Group")!;
    const zoom = options.children.find((n): n is Property => n.kind === "property" && n.matchName === "ADBE Camera Zoom")!;
    editor.setValue(comp, camera, zoom, 600, 0);
    return { editor, comp };
  };

  it("aims the emission for the comp's camera and undoes in one step", async () => {
    const { editor, comp } = cameraComp();
    const model = syntheticModel(null);
    const original = editor.save();
    expect(compTarget(comp)).toEqual({ width: 160, height: 120, frameRate: 24, duration: 1, zoom: 600 });
    const { ids, settings } = await addParticularLayers(editor, comp, model, null);
    expect(settings).toEqual(particularSettings(model, { width: 160, height: 120, frameRate: 24, duration: 1, zoom: 600 }, null));
    const aimed = (zoom: number) => particularSettings(model, { ...compTarget(comp), zoom }, null).layers[0].numbers.get(P.worldRotationY)!;
    expect(Math.abs(aimed(600) - aimed(defaultCameraZoom(comp)))).toBeGreaterThan(0.5);
    expect(comp.layers.slice(0, ids.length).map((l) => l.id)).toEqual(ids);
    for (const layer of comp.layers.slice(0, ids.length)) expect(effectParam(layer, PARTICULAR, P.worldRotationY)?.value).toBeCloseTo(aimed(600), 4);
    editor.undo();
    expect(Buffer.from(editor.save()).equals(Buffer.from(original))).toBe(true);
  });

  it("keys Physics Time Factor from an audio layer of the comp", async () => {
    const editor = newProject();
    const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, frameRate: 30, duration: 4 });
    const [song] = importFootage(editor, [SONG]);
    addLayer(editor, comp, { kind: "item", itemId: song.id });
    addLayer(editor, comp, { kind: "solid", color: [0, 0, 0], width: 1920, height: 1080 });
    const samples = kicks(4, 48000);
    registerAudio(song.id, { sampleRate: 48000, numberOfChannels: 1, length: samples.length, getChannelData: () => samples });

    const layers = soundLayers(editor.project, comp);
    expect(layers.map((l) => l.sourceId)).toEqual([song.id]);
    const sound = await layerSound(editor.project, layers[0], comp.duration);
    const expected = audioFeatures(channelReader([samples]), 48000, comp.duration);
    expect(sound?.features).toEqual(expected);

    const model = syntheticModel(null);
    const { ids, settings } = await addParticularLayers(editor, comp, model, sound!.features);
    expect(Array.isArray(settings.timeFactor)).toBe(true);
    expect(settings).toEqual(particularSettings(model, compTarget(comp), expected));
    const added = comp.layers.find((l) => l.id === ids[0])!;
    expect(timeFactorKeys(added)).toEqual((settings.timeFactor as { value: number }[]).map((k) => k.value));
  });
});
