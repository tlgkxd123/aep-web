// Builds the projectops fixture suite (refs/fixtures/projectops.aep and its
// manifest) entirely through the editor's project operations: a new project,
// new compositions and folders, imported, replaced, renamed, moved, deleted
// and duplicated items. After Effects renders it (scripts/render-refs.ts
// --suite projectops) as the acceptance test that AE opens and reads what
// the operations write.
//
//   node scripts/fixtures/build_projectops.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CompItem, FootageItem } from "../../src/aep/model.ts";
import {
  DEFAULT_COMP_SETTINGS,
  deleteItems,
  duplicateComp,
  importFootage,
  moveItems,
  newComposition,
  newFolder,
  newProject,
  renameItem,
  replaceFootage,
  type CompSettings,
} from "../../src/edit/project.ts";
import { probeMedia } from "../../src/media/probe.ts";
import { addLayer, addSolid } from "../lib/projectops-layers.ts";

const REFS = resolve("refs");
const MEDIA = ["straight.png", "photo.jpg", "big.png", "clip.mp4", "still.bmp", "alpha.tif"];

const editor = newProject();
const suite = newFolder(editor);
renameItem(editor, suite, "projectops");
const manifest: { comp: string; frames: number[]; fps: number }[] = [];

const comp = (name: string, patch: Partial<CompSettings> = {}, frames = [0], folderId = suite.id): CompItem => {
  const settings = { ...DEFAULT_COMP_SETTINGS, name, width: 160, height: 120, frameRate: 24, duration: 1, ...patch };
  const created = newComposition(editor, settings, folderId);
  manifest.push({ comp: name, frames, fps: settings.frameRate });
  return created;
};

async function footage(name: string): Promise<FootageItem> {
  const path = join(REFS, "media", name);
  const info = await probeMedia(new Blob([readFileSync(path)]), name);
  return importFootage(editor, [{ path, info }], suite.id)[0];
}

const file = async (name: string) => {
  const path = join(REFS, "media", name);
  return { path, info: await probeMedia(new Blob([readFileSync(path)]), name) };
};

const current = <T>(item: { id: number }) => editor.project.items.get(item.id) as T;

// A solid on a colored background.
const solidComp = comp("projectops_solid", { bgColor: [0.2, 0.4, 0.6] });
addSolid(editor, solidComp, "Red Solid 1", [1, 0, 0], [80, 60]);

// Imported PNG with straight alpha; a second import used in the comp and then deleted takes its layer with it.
const png = await footage("straight.png");
// Comps showing partly transparent pixels keep a black background: AE's TIFF output is matted with it.
const pngComp = comp("projectops_png");
addLayer(editor, pngComp, png);
const big = await footage("big.png");
addLayer(editor, current<CompItem>(pngComp), big);
deleteItems(editor, [current<FootageItem>(big)]);

// Footage replaced after its layer was made: a JPEG becomes a straight-alpha PNG.
const jpeg = await footage("photo.jpg");
const replacedComp = comp("projectops_replaced");
addLayer(editor, replacedComp, jpeg);
replaceFootage(editor, current<FootageItem>(jpeg), await file("straight.png"));

// Created at the root as "Comp 1", renamed, moved into a subfolder; its footage renamed and moved too.
const moved = newFolder(editor);
renameItem(editor, current(moved), "moved");
moveItems(editor, [current(moved)], suite.id);
const untitled = newComposition(editor, { ...DEFAULT_COMP_SETTINGS, width: 160, height: 120, frameRate: 24, duration: 1 });
const bmp = await footage("still.bmp");
addLayer(editor, current<CompItem>(untitled), current<FootageItem>(bmp));
renameItem(editor, current(untitled), "projectops_renamed");
renameItem(editor, current(bmp), "Renamed still");
moveItems(editor, [current(untitled), current(bmp)], moved.id);
manifest.push({ comp: "projectops_renamed", frames: [0], fps: 24 });

// A duplicate of the PNG comp.
const copy = duplicateComp(editor, current<CompItem>(pngComp));
renameItem(editor, current(copy), "projectops_duplicate");
manifest.push({ comp: "projectops_duplicate", frames: [0], fps: 24 });

// Non-default Composition Settings: 30 fps, 2 s, a 1 s start timecode, a half-size solid. aerender
// counts frames in display timecode, so frame 30 is the comp's first frame (frame 0 renders empty).
const settingsComp = comp("projectops_settings", { width: 200, height: 100, frameRate: 30, duration: 2, displayStartTime: 1, bgColor: [0, 0.6, 0.2] }, [30, 59]);
addSolid(editor, settingsComp, "Blue Solid 1", [0.1, 0.2, 0.9], [100, 50]);

// A new composition nested in another, under a PNG layer.
const precomp = comp("projectops_precomp");
addLayer(editor, precomp, current<CompItem>(solidComp));
addLayer(editor, current<CompItem>(precomp), current<FootageItem>(png));

// Imported movie.
const clip = await footage("clip.mp4");
const movieComp = comp("projectops_mp4", {}, [0, 12]);
addLayer(editor, movieComp, current<FootageItem>(clip));

// Imported TIFF (AE needs its importer header in opti).
const tiff = await footage("alpha.tif");
const tiffComp = comp("projectops_tiff");
addLayer(editor, tiffComp, current<FootageItem>(tiff));

// Undone work leaves nothing behind.
newComposition(editor, { ...DEFAULT_COMP_SETTINGS, name: "projectops_undone" });
editor.undo();

writeFileSync(join(REFS, "fixtures", "projectops.aep"), editor.save());
writeFileSync(
  join(REFS, "fixtures", "projectops.manifest.json"),
  JSON.stringify({ project: "projectops.aep", media: MEDIA.map((m) => `media/${m}`), comps: manifest }, null, 1) + "\n",
);
console.log(`built ${manifest.length} comps into ${join(REFS, "fixtures", "projectops.aep")}`);
