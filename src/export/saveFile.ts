import { Capacitor } from "@capacitor/core";

/** Where the Android app saves files, under the device's Documents folder. */
export const APP_FOLDER = "aep-web";
const CHUNK = 3 * 1024 * 1024;

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/**
 * Saves a file the way the platform allows: the browser's downloads, or, in the Android app (whose WebView ignores
 * downloads), Documents/aep-web. Returns where it went.
 */
export async function saveBlob(blob: Blob, name: string): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    const { Directory, Filesystem } = await import("@capacitor/filesystem");
    const path = `${APP_FOLDER}/${name}`;
    for (let at = 0; at === 0 || at < blob.size; at += CHUNK) {
      const data = base64(new Uint8Array(await blob.slice(at, at + CHUNK).arrayBuffer()));
      if (at === 0) await Filesystem.writeFile({ path, data, directory: Directory.Documents, recursive: true });
      else await Filesystem.appendFile({ path, data, directory: Directory.Documents });
    }
    return `Documents/${path}`;
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
  return "Downloads";
}
