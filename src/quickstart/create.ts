// A Quick Start project from the files the user picked: each probed and kept for the viewer
// as importing it would, the song's sound decoded for its bass, the template built around them.
import type { FootageFile } from "../edit/project.ts";
import { decodeAudio, type AudioData } from "../media/audio.ts";
import { identifyLocal } from "../media/localFootage.ts";
import { isImportable, probeMedia } from "../media/probe.ts";
import { footageStore } from "../media/store.ts";
import { buildQuickStart, checkQuickStartMedia, type QuickStartProject } from "./build.ts";
import type { QuickStartId } from "./catalog.ts";

export interface QuickStartFiles {
  song: File;
  background?: File;
  logo?: File;
}

/** What the song picker offers: audio files and movies with sound. */
export const SONG_ACCEPT = ".mp3,.wav,.mp4,.m4v,.mov,audio/mpeg,audio/wav,video/mp4,video/quicktime";
/** What the background and logo pickers offer. */
export const PICTURE_ACCEPT = ".png,.jpg,.jpeg,.gif,.bmp,.tif,.tiff,.mp4,.m4v,.mov,image/*,video/mp4,video/quicktime";

export async function createQuickStart(id: QuickStartId, files: QuickStartFiles, particles = true): Promise<QuickStartProject> {
  const picked = [files.song, files.background, files.logo].filter((f): f is File => !!f);
  const rejected = picked.filter((f) => !isImportable(f.name));
  if (rejected.length) throw new Error(`${rejected.map((f) => `"${f.name}"`).join(", ")} cannot be imported.`);
  const paths = await identifyLocal(picked);
  const footage = new Map<File, FootageFile>();
  await Promise.all(picked.map(async (file, i) => footage.set(file, { path: paths[i] ?? file.name, info: await probeMedia(file, file.name) })));
  const of = (file: File | undefined) => (file ? footage.get(file) : undefined);
  const media = { song: of(files.song)!, background: of(files.background), logo: of(files.logo) };
  checkQuickStartMedia(media);
  let audio: AudioData;
  try {
    audio = await decodeAudio(new Uint8Array(await files.song.arrayBuffer()));
  } catch {
    throw new Error(`Could not read the sound of "${files.song.name}".`);
  }
  const project = await buildQuickStart(id, media, { audio, particles });
  footageStore.addFiles(picked.map((file) => ({ path: footage.get(file)!.path, blob: file })));
  return project;
}
