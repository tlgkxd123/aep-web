// Dev-server plugin that lets the app load a project's footage straight from this
// machine's disks, so the user does not have to pick folders: the project's own
// absolute paths first, then a relink search (most trailing path components in
// common, file name at least) over the user's folders and the other drives.
//
// It also backs File > Import with a browser over this machine's folders and
// finds where a picked or dropped file lives, so imported footage records its
// real absolute path.
//
// Only the page served by this dev server can use it: every request needs the
// per-start token injected into index.html, and only media files that a locate,
// browse or identify request returned can be read.
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
  tif: "image/tiff", tiff: "image/tiff", psd: "image/vnd.adobe.photoshop", tga: "image/x-tga", exr: "image/x-exr",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo", mxf: "application/mxf",
  mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", aif: "audio/aiff", aiff: "audio/aiff",
  ai: "application/pdf", pdf: "application/pdf",
};
const SKIP_DIRS = new Set(["node_modules", ".git", "$recycle.bin", "system volume information", "windows", "program files", "program files (x86)", "programdata", "appdata", "recovery", "$windows.~ws", "$winreagent"]);
const MAX_BODY = 4 * 1024 * 1024;

const mediaType = (file: string) => MEDIA_TYPES[extname(file).slice(1).toLowerCase()];
const split = (path: string) => path.split(/[\\/]+/).filter(Boolean).map((p) => p.toLowerCase());

/** The user folders footage is kept in. */
function userFolders(): string[] {
  const home = process.env.USERPROFILE ?? homedir();
  return ["Downloads", "Desktop", "Documents", "Videos", "Pictures", "Music"].map((d) => join(home, d));
}

function searchRoots(): string[] {
  const configured = process.env.AEP_FOOTAGE_ROOTS?.split(";").filter(Boolean);
  if (configured?.length) return configured;
  const user = userFolders();
  const systemDrive = (process.env.SystemDrive ?? "C:").toUpperCase();
  const drives = "DEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${l}:\\`).filter((d) => !d.startsWith(systemDrive) && existsSync(d));
  return [...user, ...drives].filter((d) => existsSync(d));
}

/** Media files under the search roots, by lower-case file name. Rebuilt when the roots change (a drive is plugged in or removed). */
let index: Promise<Map<string, string[]>> | undefined;
let indexedRoots = "";

function buildIndex(): Promise<Map<string, string[]>> {
  const roots = searchRoots();
  if (roots.join("|") !== indexedRoots) {
    indexedRoots = roots.join("|");
    index = undefined;
  }
  return (index ??= (async () => {
    const byName = new Map<string, string[]>();
    const stack = [...roots];
    let slice = performance.now();
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name.toLowerCase())) stack.push(full);
        } else if (entry.isFile() && mediaType(entry.name)) {
          const key = entry.name.toLowerCase();
          const list = byName.get(key) ?? [];
          list.push(full);
          byName.set(key, list);
        }
      }
      // Keep the dev server responsive while walking large drives.
      if (performance.now() - slice > 10) {
        await new Promise((r) => setImmediate(r));
        slice = performance.now();
      }
    }
    return byName;
  })());
}

function commonTail(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** The file on this machine for a footage path stored in a project, or null. */
export async function resolveFootage(path: string): Promise<string | null> {
  if (existsSync(path) && statSync(path).isFile() && mediaType(path)) return path;
  const parts = split(path);
  const candidates = (await buildIndex()).get(parts[parts.length - 1] ?? "") ?? [];
  // A bare frame-number name ("1430.png") says nothing about which folder it came
  // from, so such files also need their parent folder to match.
  const stem = (parts[parts.length - 1] ?? "").replace(/\.[^.]*$/, "");
  const minScore = /[a-z]/i.test(stem) ? 1 : 2;
  let best: string | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = commonTail(parts, split(candidate));
    if (score > bestScore) [best, bestScore] = [candidate, score];
  }
  return bestScore >= minScore ? best : null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        fail(new Error("request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export interface LocateRequest {
  token: string;
  /** Footage file paths as the project stores them. */
  paths: string[];
  /** For image sequences: list the sibling frames (same folder and extension) of each found file. */
  sequences?: boolean[];
}

export interface LocateResult {
  path: string;
  file: string | null;
  siblings?: string[];
}

export interface BrowseEntry {
  name: string;
  path: string;
  folder: boolean;
  size?: number;
}

/** A folder's subfolders and media files for File > Import; the drives and user folders for "". */
function browse(dir: string): { dir: string; parent: string | null; entries: BrowseEntry[] } {
  if (!dir) {
    const home = process.env.USERPROFILE ?? homedir();
    const drives = "CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map((l) => `${l}:\\`).filter((d) => existsSync(d));
    const places = [home, ...["Desktop", "Documents", "Downloads", "Pictures", "Videos"].map((d) => join(home, d))].filter((d) => existsSync(d));
    return { dir: "", parent: null, entries: [...places, ...drives].map((path) => ({ name: path, path, folder: true })) };
  }
  const entries: BrowseEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith("$")) entries.push({ name: entry.name, path, folder: true });
    } else if (entry.isFile() && mediaType(entry.name)) {
      let size: number | undefined;
      try {
        size = statSync(path).size;
      } catch {
        continue;
      }
      entries.push({ name: entry.name, path, folder: false, size });
    }
  }
  const parent = dirname(dir);
  return { dir, parent: parent === dir ? "" : parent, entries };
}

/**
 * The absolute path of a file the browser picked or dropped, which it only
 * knows by name, size and modification time: a match among the indexed media
 * files and the user folders, when exactly one file matches.
 */
async function identify(name: string, size: number, lastModified: number, folders: Iterable<string>): Promise<string | null> {
  const same = (path: string) => {
    try {
      const stat = statSync(path);
      return stat.size === size && Math.abs(stat.mtimeMs - lastModified) < 2000;
    } catch {
      return false;
    }
  };
  // Files sit directly in a folder this session used or in a user folder often enough to look there before
  // waiting for the index (minutes on large drives).
  const near = [...new Set([...folders, ...userFolders()].map((folder) => join(folder, basename(name))))].filter(same);
  if (near.length === 1) return near[0];
  const matches = [...new Set([...((await buildIndex()).get(name.toLowerCase()) ?? []), ...near])].filter(same);
  return matches.length === 1 ? matches[0] : null;
}

export function localFootage(): Plugin {
  const token = randomBytes(24).toString("hex");
  const readable = new Set<string>();
  /** Folders of footage this session located or browsed: where picked files most likely come from. */
  const folders = new Set<string>([process.cwd()]);
  return {
    name: "aep-local-footage",
    apply: "serve",
    transformIndexHtml: () => [{ tag: "meta", attrs: { name: "aep-local-footage", content: token }, injectTo: "head" }],
    configureServer(server) {
      server.middlewares.use("/__aep/footage", async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          // Same-origin only: a foreign page could send requests but never learns the token.
          if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(res, 403, { error: "forbidden" });
          if (req.method === "POST" && url.pathname === "/locate") {
            const body = JSON.parse(await readBody(req)) as LocateRequest;
            if (body.token !== token) return send(res, 403, { error: "forbidden" });
            const results: LocateResult[] = [];
            for (const [i, path] of body.paths.entries()) {
              const file = await resolveFootage(path);
              const result: LocateResult = { path, file };
              if (file) {
                readable.add(file);
                folders.add(dirname(file));
              }
              if (file && body.sequences?.[i]) {
                const ext = extname(file).toLowerCase();
                result.siblings = readdirSync(dirname(file))
                  .filter((name) => extname(name).toLowerCase() === ext)
                  .map((name) => join(dirname(file), name));
                for (const s of result.siblings) readable.add(s);
              }
              results.push(result);
            }
            return send(res, 200, { results });
          }
          if (req.method === "POST" && url.pathname === "/browse") {
            const body = JSON.parse(await readBody(req)) as { token: string; dir: string };
            if (body.token !== token) return send(res, 403, { error: "forbidden" });
            const listing = browse(body.dir);
            if (listing.dir) folders.add(listing.dir);
            for (const entry of listing.entries) if (!entry.folder) readable.add(entry.path);
            return send(res, 200, listing);
          }
          if (req.method === "POST" && url.pathname === "/identify") {
            const body = JSON.parse(await readBody(req)) as { token: string; files: { name: string; size: number; lastModified: number }[] };
            if (body.token !== token) return send(res, 403, { error: "forbidden" });
            const paths: (string | null)[] = [];
            for (const f of body.files) {
              const path = await identify(f.name, f.size, f.lastModified, folders);
              if (path) readable.add(path);
              paths.push(path);
            }
            return send(res, 200, { paths });
          }
          if (req.method === "GET" && url.pathname === "/file") {
            const file = url.searchParams.get("file") ?? "";
            if (url.searchParams.get("token") !== token || !readable.has(file)) return send(res, 403, { error: "forbidden" });
            res.statusCode = 200;
            res.setHeader("Content-Type", mediaType(file) ?? "application/octet-stream");
            res.setHeader("Content-Length", String(statSync(file).size));
            res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(basename(file))}"`);
            createReadStream(file).pipe(res);
            return;
          }
          send(res, 404, { error: "not found" });
        } catch (e) {
          send(res, 500, { error: (e as Error).message });
        }
      });
    },
  };
}
