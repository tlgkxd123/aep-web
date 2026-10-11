// Export to Particular (Extra > Particle Match): the Trapcode Particular layers a world model's settings make
// (particular.ts), added to a composition of the open project, or saved as a new After Effects project whose
// comp also holds the soundtrack the layers' Physics Time Factor follows.
import type { CompItem, Layer, Project } from "../../aep/model.ts";
import { cameraAt } from "../../aep/transform.ts";
import type { Editor } from "../../edit/editor.ts";
import { addLayer } from "../../edit/layers.ts";
import { DEFAULT_COMP_SETTINGS, importFootage, newComposition, newProject, type CompSettings, type FootageFile } from "../../edit/project.ts";
import { writeTransform } from "../../edit/transform-ops.ts";
import { layerAudio } from "../../media/mix.ts";
import { footageStore } from "../../media/store.ts";
import type { AudioFeatures } from "./audio.ts";
import type { ParticleWorldModel } from "./model.ts";
import { createParticularLayers, particularSettings, type ParticularSettings, type ParticularTarget } from "./particular.ts";
import { mixSound, type Sound } from "./soundtrack.ts";

/** Lookups of a layer's sound while its footage decodes, at most. */
const DECODE_ROUNDS = 20;
const MAX_DEPTH = 16;

/** The comp a model's layers are made for: its size, rate and duration, and its camera's zoom at 0 s. */
export function compTarget(comp: CompItem): ParticularTarget {
  return { width: comp.width, height: comp.height, frameRate: comp.frameRate, duration: comp.duration, zoom: cameraAt(comp, 0).zoom };
}

function audible(project: Project, layer: Layer, depth: number): boolean {
  if (!layer.audioEnabled || depth > MAX_DEPTH) return false;
  const source = project.items.get(layer.sourceId);
  if (source?.kind === "footage") return source.hasAudio;
  return source?.kind === "comp" && source.layers.some((l) => audible(project, l, depth + 1));
}

/** The layers of `comp` that can be heard: footage with sound, or comps holding such layers, audio switched on. */
export function soundLayers(project: Project, comp: CompItem): Layer[] {
  return comp.layers.filter((l) => audible(project, l, 0));
}

/** The sound of `layer` over [0, duration) seconds of its comp, once its footage has decoded; null without one. */
export async function layerSound(project: Project, layer: Layer, duration: number): Promise<Sound | null> {
  let audio = layerAudio(project, layer, 0);
  for (let round = 0; audio === "pending" && round < DECODE_ROUNDS; round++) {
    await footageStore.idle();
    audio = layerAudio(project, layer, 0);
  }
  return audio && audio !== "pending" ? mixSound(audio, duration) : null;
}

/** Adds the model's Particular layers on top of `comp` as one undoable step, their time factor following `features`. */
export async function addParticularLayers(
  editor: Editor,
  comp: CompItem,
  model: ParticleWorldModel,
  features: AudioFeatures | null,
): Promise<{ ids: number[]; settings: ParticularSettings }> {
  const settings = particularSettings(model, compTarget(comp), features);
  return { ids: await createParticularLayers(editor, comp, settings), settings };
}

export interface ProjectExport {
  comp: Pick<CompSettings, "name" | "width" | "height" | "frameRate" | "duration">;
  /** The file the soundtrack comes from, put under the particles with its sound on (and a movie's picture off); null for none. */
  soundtrack: FootageFile | null;
  /** The soundtrack's features from the comp's start (null: constant speed). */
  features: AudioFeatures | null;
}

/** A new project whose comp holds the model's Particular layers over their soundtrack, as saved bytes. */
export async function particularProject(model: ParticleWorldModel, options: ProjectExport): Promise<{ bytes: Uint8Array; settings: ParticularSettings }> {
  const editor = newProject();
  const comp = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, ...options.comp });
  const soundtrack = options.soundtrack;
  if (soundtrack) {
    const [item] = importFootage(editor, [soundtrack]);
    const id = addLayer(editor, comp, { kind: "item", itemId: item.id });
    const { width, height } = soundtrack.info;
    if (width > 0) {
      // The picture is framed as the particles are: centred, scaled to the comp's height.
      editor.perform("Reference Layer", [comp], () => {
        const layer = comp.layers.find((l) => l.id === id);
        if (!layer) throw new Error("the soundtrack layer was not created");
        editor.setLayerSwitch(comp, layer, "enabled", false);
        const scale = (100 * comp.height) / height;
        if (Math.abs(scale - 100) > 1e-9) writeTransform(editor, comp, id, { scale: [scale, scale] }, 0);
      });
    }
  }
  const settings = particularSettings(model, compTarget(comp), options.features);
  await createParticularLayers(editor, comp, settings);
  return { bytes: editor.save(), settings };
}
