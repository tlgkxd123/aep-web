// Projects saved as a .zip with their footage (src/edit/collect.ts): the archive
// Save writes from the located footage, and what opening one adds to the footage
// store.
import type { Project } from "../aep/model.ts";
import { archiveContents, archiveFootage, collectProject } from "../edit/collect.ts";
import type { Editor } from "../edit/editor.ts";
import { footageStore } from "../media/store.ts";
import { readZip, writeZip } from "../media/zip.ts";

export interface Archived {
  blob: Blob;
  /** Names of the footage items left out because their files are not located. */
  missing: string[];
  /**
   * Once the archive is written to `file`, reads its footage from there: Blobs
   * of the file it overwrote can no longer be read.
   */
  rebind(file: Blob): void;
}

/** The project and its located footage as a .zip named `name`. */
export async function projectArchive(editor: Editor, name: string, onProgress?: (done: number, total: number) => void): Promise<Archived> {
  const { entries, missing } = collectProject(editor, name, (item) => footageStore.sourceFiles(item));
  const { blob, offsets } = await writeZip(entries, { onProgress });
  return {
    blob,
    missing: missing.map((item) => item.name),
    rebind: (file) => {
      if (file.size !== blob.size) return;
      const blobs = new Map<Blob, Blob>();
      entries.forEach(({ data }, i) => {
        if (!ArrayBuffer.isView(data)) blobs.set(data, file.slice(offsets[i], offsets[i] + data.size, data.type));
      });
      footageStore.rebind(blobs);
    },
  };
}

export interface OpenedArchive {
  /** The .aep inside. */
  bytes: Uint8Array;
  /**
   * Adds the archive's footage for `project` to the footage store. Resolves to
   * whether every file of the archive was taken, so that saving over the
   * archive loses none.
   */
  addFootage(project: Project): Promise<boolean>;
}

export async function openProjectArchive(file: Blob): Promise<OpenedArchive> {
  const { project, files } = archiveContents(await readZip(file));
  const bytes = new Uint8Array(await (await project.read()).arrayBuffer());
  return {
    bytes,
    addFootage: async (parsed) => {
      const { footage, complete } = await archiveFootage(files, parsed);
      footageStore.addFiles(footage);
      return complete;
    },
  };
}
