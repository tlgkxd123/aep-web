import { Capacitor } from "@capacitor/core";
import type { Directory } from "@capacitor/filesystem";

/** Where the Android app saves files, under the device's Documents folder. */
export const APP_FOLDER = "aep-web";
const CHUNK = 3 * 1024 * 1024;
/** Numbered names tried when the requested one is taken by a file the app may not replace. */
const MAX_NUMBERED = 99;

/** Where a saved file went: its name, which can differ from the one asked for, and its folder. */
export interface SavedFile {
  name: string;
  folder: string;
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** `name` with the characters Android's shared storage refuses (FAT's) replaced by "_". */
function storageFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "_").trim();
  return safe && safe !== "." && safe !== ".." ? safe : "Untitled";
}

/** `name` for n = 1, then "stem (2).ext", "stem (3).ext"... */
function numberedFileName(name: string, n: number): string {
  if (n < 2) return name;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** Capacitor Filesystem's codes for a storage permission the user refused and a folder it could not create. */
const FOLDER_REFUSED = new Set(["OS-PLUG-FILE-0007", "OS-PLUG-FILE-0011"]);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const folderRefused = (e: unknown) => FOLDER_REFUSED.has(String((e as { code?: unknown } | null)?.code));
const refused = (e: unknown) => folderRefused(e) || /EACCES|EPERM|permission denied|operation not permitted/i.test(errorText(e));

/** The folder of a file:// URI, relative to shared storage when it is in it. */
function shownFolder(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ""))
    .replace(/^\/(storage\/emulated\/\d+|sdcard)\//, "")
    .replace(/\/[^/]*$/, "");
}

interface Target {
  directory: Directory;
  name: string;
  folder: string;
}

/**
 * Creates the file, empty. On Android 11 and later the app may create files in Documents but not overwrite one it
 * did not create (left there by an earlier install of the app, or copied there), so such a file keeps its name and
 * this one gets a numbered name. Where Documents takes no new files at all (Android 10 and earlier with the storage
 * permission refused), the file goes to the app's own folder, which needs no permission.
 */
async function createTarget(name: string): Promise<Target> {
  const { Directory, Filesystem } = await import("@capacitor/filesystem");
  const create = (directory: Directory, path: string) => Filesystem.writeFile({ path, data: "", directory, recursive: true });
  let refusal: unknown;
  for (let n = 1; n <= MAX_NUMBERED; n++) {
    const path = `${APP_FOLDER}/${numberedFileName(name, n)}`;
    try {
      await create(Directory.Documents, path);
      return { directory: Directory.Documents, name: numberedFileName(name, n), folder: `Documents/${APP_FOLDER}` };
    } catch (e) {
      if (!refused(e)) throw e;
      refusal = e;
      if (folderRefused(e)) break;
      const taken = await Filesystem.stat({ path, directory: Directory.Documents }).then(
        () => true,
        () => false,
      );
      if (!taken) break;
    }
  }
  try {
    const { uri } = await create(Directory.External, `${APP_FOLDER}/${name}`);
    return { directory: Directory.External, name, folder: shownFolder(uri) || APP_FOLDER };
  } catch (e) {
    throw new Error(`${name} could not be saved to Documents/${APP_FOLDER} (${errorText(refusal)}) or to the app's folder (${errorText(e)}).`);
  }
}

/**
 * Saves a file the way the platform allows: the browser's downloads, or, in the Android app (whose WebView ignores
 * downloads), Documents/aep-web. Resolves to where it went.
 */
export async function saveBlob(blob: Blob, name: string): Promise<SavedFile> {
  if (Capacitor.isNativePlatform()) {
    const { Filesystem } = await import("@capacitor/filesystem");
    const target = await createTarget(storageFileName(name));
    const path = `${APP_FOLDER}/${target.name}`;
    for (let at = 0; at < blob.size; at += CHUNK) {
      const data = base64(new Uint8Array(await blob.slice(at, at + CHUNK).arrayBuffer()));
      await Filesystem.appendFile({ path, data, directory: target.directory });
    }
    return { name: target.name, folder: target.folder };
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { name, folder: "Downloads" };
}
