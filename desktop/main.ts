// The desktop app: Electron serves the production build over loopback, where
// fetch, media and the secure-context APIs behave as they do in the dev server,
// and mounts the dev server's local footage service so projects opened here find
// their footage on this machine's disks.
import { app, BrowserWindow, dialog, Menu, session, shell } from "electron";
import { execFile } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve, sep } from "node:path";
import { localFootage } from "../server/local-footage.ts";

type Next = () => void;
type FootageHandler = (req: IncomingMessage, res: ServerResponse, next: Next) => void;
type MiddlewareHost = { middlewares: { use(path: string, handler: FootageHandler): void } };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

/** The app's files: `dist/` beside the source when run from the repo, inside app.asar when packaged. */
const distDir = resolve(app.getAppPath(), "dist");
const footage = new Map<string, FootageHandler>();
let window: BrowserWindow | null = null;

/** Where Windows lists display adapters, one numbered subkey each. */
const DISPLAY_CLASS = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";

interface Adapter {
  name: string;
  vramMiB: number;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { windowsHide: true }, (error, stdout) => (error ? reject(error) : resolvePromise(stdout)));
  });
}

/** The value `reg query` printed for `name`, as in `DriverDesc    REG_SZ    NVIDIA GeForce RTX 3070`. */
function regValue(stdout: string, name: string): string | undefined {
  const line = stdout.split(/\r?\n/).find((l) => l.trimStart().startsWith(`${name} `));
  return line?.trim().split(/\s{2,}/).at(-1)?.trim();
}

async function regQuery(key: string, value: string): Promise<string | undefined> {
  try {
    return regValue(await run("reg", ["query", key, "/v", value]), value);
  } catch {
    return undefined;
  }
}

/**
 * The display adapters' names and dedicated memory from Windows' driver registry. Browsers expose no video memory,
 * so the desktop app reads it here and tells the page (see playback/lowVram.ts).
 */
async function windowsAdapters(): Promise<Adapter[]> {
  if (process.platform !== "win32") return [];
  let listed: string;
  try {
    listed = await run("reg", ["query", DISPLAY_CLASS]);
  } catch {
    return [];
  }
  const subkeys = listed
    .split(/\r?\n/)
    .map((line) => /\\(\d{4})\s*$/.exec(line.trim())?.[1])
    .filter((key): key is string => !!key);
  const adapters: Adapter[] = [];
  for (const subkey of subkeys) {
    const key = `${DISPLAY_CLASS}\\${subkey}`;
    const [name, memory] = await Promise.all([
      regQuery(key, "DriverDesc"),
      regQuery(key, "HardwareInformation.qwMemorySize"),
    ]);
    // Newer Windows stores the memory as a QWORD (`0x200000000`); older ones as bytes.
    const bytes = memory && /0x([0-9a-f]+)/i.exec(memory)?.[1];
    if (!name || !bytes) continue;
    adapters.push({ name, vramMiB: Math.round(Number.parseInt(bytes, 16) / (1024 * 1024)) });
  }
  return adapters;
}

/** The memory of the adapter Chromium renders on, in MiB, when Windows reports it. */
async function activeVramMiB(): Promise<number | undefined> {
  let active: string | undefined;
  try {
    const info = (await app.getGPUInfo("complete")) as { gpuDevice?: { active?: boolean; deviceString?: string }[] };
    active = info.gpuDevice?.find((device) => device.active)?.deviceString?.toLowerCase();
  } catch {
    return undefined;
  }
  if (!active) return undefined;
  const adapters = await windowsAdapters();
  const match =
    adapters.find((adapter) => adapter.name.toLowerCase() === active) ??
    adapters.find((adapter) => {
      const name = adapter.name.toLowerCase();
      return name.includes(active) || active.includes(name);
    });
  return match?.vramMiB;
}

function end(res: ServerResponse, status: number, body = ""): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" }).end(body);
}

/** The app's index.html, with the local footage service's per-start token in its head. */
function page(tags: string[]): Buffer {
  const html = readFileSync(join(distDir, "index.html"), "utf8");
  return Buffer.from(html.replace("</head>", `${tags.join("")}</head>`));
}

/** A file below dist, or null when the path leaves it. */
function distFile(pathname: string): string | null {
  const file = resolve(distDir, `.${pathname}`);
  return file === distDir || file.startsWith(distDir + sep) ? file : null;
}

function serveFile(req: IncomingMessage, res: ServerResponse, file: string, index: Buffer): void {
  if (file === join(distDir, "index.html")) {
    res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : index);
    return;
  }
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    end(res, 404, "Not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": String(size),
    "cache-control": "public, max-age=31536000, immutable",
  });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
}

/** dist's files, and the local footage endpoints at /__aep/footage. */
function handler(index: Buffer) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const mounted = "/__aep/footage";
    if (url.pathname === mounted || url.pathname.startsWith(`${mounted}/`)) {
      const route = footage.get(mounted);
      if (!route) return end(res, 503, "Local footage is unavailable");
      // connect strips a middleware's mount path before calling it.
      req.url = url.pathname.slice(mounted.length) + url.search || "/";
      route(req, res, () => end(res, 404, "Not found"));
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") return end(res, 405, "Method not allowed");
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return end(res, 400, "Bad request");
    }
    if (pathname === "/") return serveFile(req, res, join(distDir, "index.html"), index);
    const file = distFile(pathname);
    if (!file) return end(res, 403, "Forbidden");
    if (!existsSync(file) || !statSync(file).isFile()) {
      // Single-page app: unknown paths without an extension get the page.
      if (extname(pathname)) return end(res, 404, "Not found");
      return serveFile(req, res, join(distDir, "index.html"), index);
    }
    serveFile(req, res, file, index);
  };
}

async function startServer(): Promise<string> {
  if (!existsSync(join(distDir, "index.html"))) {
    throw new Error(`The app's build is missing from ${distDir}. Run npm run build:desktop.`);
  }
  const plugin = localFootage() as unknown as {
    configureServer(server: MiddlewareHost): void;
    transformIndexHtml(): { tag: string; attrs?: Record<string, string> }[];
  };
  const tags = plugin.transformIndexHtml().map(({ tag, attrs }) => {
    const attributes = Object.entries(attrs ?? {}).map(([name, value]) => ` ${name}="${value}"`).join("");
    return `<${tag}${attributes}>`;
  });
  const vram = await activeVramMiB();
  if (vram) tags.push(`<meta name="aep-gpu-vram" content="${vram}">`);
  const index = page(tags);
  plugin.configureServer({
    middlewares: {
      use(path, route) {
        footage.set(path, route);
      },
    },
  });
  return new Promise((ok, fail) => {
    const server = createServer(handler(index));
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      ok(`http://127.0.0.1:${address.port}/`);
    });
  });
}

async function createWindow(): Promise<void> {
  const url = await startServer();
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#1b1b1b",
    title: "AEP Web",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window = win;
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (window === win) window = null;
  });
  // The app is the page; links and dropped files stay here, external links go to the browser.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) void shell.openExternal(target);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, target) => {
    if (target !== url) {
      event.preventDefault();
      if (/^https?:/i.test(target)) void shell.openExternal(target);
    }
  });
  win.webContents.on("before-input-event", (_event, input) => {
    if (input.type === "keyDown" && (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i"))) {
      win.webContents.toggleDevTools();
    }
  });
  await win.loadURL(url);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId("com.aepweb.desktop");
  if (process.env.AEP_WEB_SOFTWARE_GL === "1") {
    // Machines without a usable GPU, and headless checks, render through SwiftShader.
    app.commandLine.appendSwitch("use-angle", "swiftshader");
    app.commandLine.appendSwitch("enable-unsafe-swiftshader");
  }
  app.on("second-instance", () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("window-all-closed", () => app.quit());
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    // The page saves by download (it has no File System Access picker here); ask where.
    session.defaultSession.on("will-download", (_event, item) => {
      item.setSaveDialogOptions({ title: "Save", defaultPath: join(app.getPath("downloads"), item.getFilename()) });
    });
    try {
      await createWindow();
    } catch (e) {
      dialog.showErrorBox("AEP Web could not start", (e as Error).message);
      app.quit();
    }
  });
}
