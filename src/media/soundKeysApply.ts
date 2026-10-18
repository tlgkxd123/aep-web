// Sound Keys' Apply button: analyses the Audio Layer over its whole extent in the
// comp and rewrites the keyframes of every active range's Output in one pass, so
// keys left by earlier partial applies (which make an integrating Output jump
// back to zero) are replaced.
import type { CompItem, Layer, Project, PropertyGroup } from "../aep/model.ts";
import type { Editor } from "../edit/editor.ts";
import { effectProperty } from "../render/effectParams.ts";
import { layerAudio, mixWindow } from "./mix.ts";
import { appliedSettings, computeSoundKeysAsync, keyGrid } from "./soundKeys.ts";
import { footageStore } from "./store.ts";

/** Applies Sound Keys; resolves with a summary, rejects with a message the UI can show. */
export async function applySoundKeys(
  editor: Editor,
  project: Project,
  comp: CompItem,
  layer: Layer,
  effect: PropertyGroup,
  progress?: (done: number) => void,
): Promise<string> {
  const settings = appliedSettings(project, comp, layer, effect);
  if (!settings.ranges.length) throw new Error("No range is active.");
  const audioLayer = comp.layers.find((l) => l.index === settings.audioLayer);
  if (!audioLayer) throw new Error("Choose an Audio Layer first.");
  const { from, to, count } = keyGrid(audioLayer, comp.duration, settings.keysPerSecond);
  if (!count) throw new Error(`"${audioLayer.name}" is not in the composition's duration.`);
  let audio = layerAudio(project, audioLayer, from);
  for (let tries = 0; audio === "pending" && tries < 20; tries++) {
    await footageStore.idle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    audio = layerAudio(project, audioLayer, from);
  }
  if (audio === "pending") throw new Error(`The audio of "${audioLayer.name}" is still loading.`);
  if (!audio) throw new Error(`"${audioLayer.name}" has no audio that could be loaded.`);
  const sound = audio;
  const rate = sound.rate * sound.timeScale;
  const result = await computeSoundKeysAsync(settings, rate, (first, length) => mixWindow(sound, first, length, settings.channel), from, to, progress);
  const entries = settings.ranges.flatMap((range, i) => {
    const prop = effectProperty(effect, range.output);
    return prop ? [{ prop, keys: result.times.map((time, k) => ({ time, value: result.outputs[i][k] })) }] : [];
  });
  editor.replaceKeyframes(comp, layer, entries, -Infinity, Infinity, "Sound Keys Apply");
  return `${result.times.length} keyframes on ${entries.map((e) => e.prop.name).join(", ")}`;
}
