// An Avee Player template converted around the song the user picked: the song probed
// and kept for the viewer as importing it would, its sound decoded for the beat, and the
// template's images put in the footage store under the paths the project records.
import type { FootageFile } from "../edit/project.ts";
import { decodeAudio, type AudioData } from "../media/audio.ts";
import { identifyLocal } from "../media/localFootage.ts";
import { isImportable, probeMedia } from "../media/probe.ts";
import { footageStore } from "../media/store.ts";
import { checkQuickStartMedia } from "../quickstart/build.ts";
import { convertViz, type VizProject } from "./convert.ts";
import type { VizTemplate } from "./scene.ts";

export async function createVizProject(template: VizTemplate, songFile?: File): Promise<VizProject> {
  let song: FootageFile | undefined;
  let audio: AudioData | undefined;
  if (songFile) {
    if (!isImportable(songFile.name)) throw new Error(`"${songFile.name}" cannot be imported.`);
    const [path] = await identifyLocal([songFile]);
    song = { path: path ?? songFile.name, info: await probeMedia(songFile, songFile.name) };
    checkQuickStartMedia({ song });
    try {
      audio = await decodeAudio(new Uint8Array(await songFile.arrayBuffer()));
    } catch {
      throw new Error(`Could not read the sound of "${songFile.name}".`);
    }
  }
  const project = await convertViz(template, { song, audio });
  footageStore.addFiles([...project.footage, ...(song && songFile ? [{ path: song.path, blob: songFile }] : [])]);
  return project;
}
