// Projects saved as a .zip with their footage, like File > Dependencies > Collect
// Files: the project at the top of the archive and its file footage in
// "(Footage)", below the folders the items have in the Project panel. The
// archived project points its footage there through After Effects' relative
// link (the `alas` ascend counts), so After Effects finds the footage wherever
// the archive is extracted, and this app finds it in the archive itself.
import { utf8Of } from "../aep/decode.ts";
import type { FootageItem, Item, Project } from "../aep/model.ts";
import { findChild, findList } from "../aep/riff.ts";
import type { ZipEntry, ZipInput } from "../media/zip.ts";
import { Editor } from "./editor.ts";

export const FOOTAGE_FOLDER = "(Footage)";

/** A located footage file, named as its item expects it. */
export interface SourceFile {
  name: string;
  blob: Blob;
}

export interface Collection {
  /** The project first, then the footage files. */
  entries: ZipInput[];
  /** File footage whose files are not located: it keeps pointing where it did. */
  missing: FootageItem[];
}

type FileSource = Extract<FootageItem["mainSource"], { sourceType: "FileSource" }>;

interface Alas {
  fullpath?: string;
  platform?: number;
  target_is_folder?: boolean;
  ascendcount_base?: number;
  ascendcount_target?: number;
}

const isFileFootage = (item: Item): item is FootageItem & { mainSource: FileSource } =>
  item.kind === "footage" && item.mainSource.sourceType === "FileSource";

/** A file or folder name every file system takes. */
export function safeName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "_").replace(/[. ]+$/, "").trim();
  return safe && safe !== "." && safe !== ".." ? safe : "_";
}

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? "";

/** The Project panel folders an item sits in, outermost first. */
function panelFolders(project: Project, item: Item): string[] {
  const names: string[] = [];
  const seen = new Set<number>();
  for (let id = item.parentFolderId; id && !seen.has(id); ) {
    seen.add(id);
    const folder = project.items.get(id);
    if (folder?.kind !== "folder") break;
    names.unshift(safeName(folder.name));
    id = folder.parentFolderId;
  }
  return names;
}

/** The archive's name without its extension, as the project inside it is named. */
export const archiveStem = (name: string) => safeName(name.replace(/\.(zip|aep)$/i, "")) || "Project";

/**
 * Lays out the project's file footage for an archive named `archiveName` and
 * writes the project pointing at it. `filesOf` gives an item's located files
 * (undefined when they are not located).
 */
export function collectProject(editor: Editor, archiveName: string, filesOf: (item: FootageItem) => SourceFile[] | undefined): Collection {
  const project = editor.project;
  const stem = archiveStem(archiveName);
  const footage: ZipInput[] = [];
  const missing: FootageItem[] = [];
  /** Where each collected item's target (its file, or a sequence's folder) is in the archive. */
  const targets = new Map<number, string>();
  const placedBlobs = new Map<Blob, string>();
  const takenPaths = new Set<string>();
  for (const item of project.items.values()) {
    if (!isFileFootage(item)) continue;
    const files = filesOf(item);
    if (!files?.length) {
      missing.push(item);
      continue;
    }
    const reused = placedBlobs.get(files[0].blob);
    if (reused) {
      targets.set(item.id, reused);
      continue;
    }
    const source = item.mainSource;
    const folders = [FOOTAGE_FOLDER, ...panelFolders(project, item)];
    const leaf = source.targetIsFolder ? safeName(baseName(source.file.replace(/[\\/][^\\/]*$/, "")) || item.name) : safeName(files[0].name);
    let target = [...folders, leaf].join("/");
    for (let n = 2; takenPaths.has(target.toLowerCase()); n++) target = [...folders, String(n), leaf].join("/");
    takenPaths.add(target.toLowerCase());
    placedBlobs.set(files[0].blob, target);
    targets.set(item.id, target);
    for (const file of files) {
      const path = source.targetIsFolder ? `${target}/${safeName(file.name)}` : target;
      footage.push({ path, data: file.blob, modified: (file.blob as Partial<File>).lastModified });
    }
  }

  const copy = Editor.fromBytes(editor.save());
  const encoder = new TextEncoder();
  for (const [id, target] of targets) {
    const alasChunk = findChild(findList(findList(copy.project.items.get(id)?.chunk, "Pin "), "Als2"), "alas");
    if (!alasChunk) continue;
    let alas: Alas;
    try {
      alas = JSON.parse(utf8Of(alasChunk)) as Alas;
    } catch {
      continue;
    }
    const parts = target.split("/");
    const posix = alas.platform === 2 || (alas.fullpath ?? "").startsWith("/");
    alas.fullpath = posix ? `/${stem}/${parts.join("/")}` : `C:\\${stem}\\${parts.join("\\")}`;
    // The project is the archive's only component below the folder it shares with its footage; a folder target also counts its frame.
    alas.ascendcount_base = 1;
    alas.ascendcount_target = parts.length + (alas.target_is_folder ? 1 : 0);
    alasChunk.data = encoder.encode(JSON.stringify(alas));
  }
  return { entries: [{ path: `${stem}.aep`, data: copy.save(), compress: true }, ...footage], missing };
}

const JUNK = /(^|\/)(__MACOSX\/|\._|\.DS_Store$|Thumbs\.db$)/i;

/** The project an archive holds (the .aep nearest its top) and its other files. */
export function archiveContents(entries: readonly ZipEntry[]): { project: ZipEntry; files: ZipEntry[] } {
  const usable = entries.filter((e) => !JUNK.test(e.path));
  const depth = (e: ZipEntry) => e.path.split("/").length;
  const projects = usable.filter((e) => /\.aep$/i.test(e.path)).sort((a, b) => depth(a) - depth(b) || a.path.localeCompare(b.path));
  const project = projects[0];
  if (!project) throw new Error("The archive holds no After Effects project (.aep)");
  return { project, files: usable.filter((e) => e !== project && !/\.aep$/i.test(e.path)) };
}

/** Whether a file of that path may be footage of `items`: their file names, or a sequence's prefix and extension. */
export function footageNamed(items: Iterable<Item>): (path: string) => boolean {
  const names = new Set<string>();
  const sequences: { prefix: string; extension: string }[] = [];
  for (const item of items) {
    if (!isFileFootage(item)) continue;
    const source = item.mainSource;
    names.add(source.fileName.toLowerCase());
    for (const name of source.sequence?.fileNames ?? []) names.add(name.toLowerCase());
    if (source.sequence) sequences.push({ prefix: source.sequence.prefix.toLowerCase(), extension: source.sequence.extension.toLowerCase() });
  }
  return (path) => {
    const name = baseName(path).toLowerCase();
    return names.has(name) || sequences.some((s) => name.startsWith(s.prefix) && name.endsWith(s.extension));
  };
}

/**
 * The archive's files the project can use, by their path in the archive. Stored
 * files are slices of the archive and all come along; compressed ones are
 * decompressed only when the project names them. `complete`: every file of the
 * archive was read and is named by the project, so an archive saved over this
 * one loses none of its files.
 */
export async function archiveFootage(files: readonly ZipEntry[], project: Project): Promise<{ footage: { path: string; blob: Blob }[]; complete: boolean }> {
  const named = footageNamed(project.items.values());
  const footage: { path: string; blob: Blob }[] = [];
  let complete = true;
  for (const file of files) {
    const wanted = named(file.path);
    complete &&= wanted;
    if (!file.stored && !wanted) continue;
    try {
      footage.push({ path: file.path, blob: await file.read() });
    } catch {
      // A file that cannot be read stays missing; the rest still load.
      complete = false;
    }
  }
  return { footage, complete };
}
