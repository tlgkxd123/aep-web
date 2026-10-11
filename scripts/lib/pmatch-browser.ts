// Headless Edge (on the high-performance GPU) with the Particle Match harness
// (src/extra/pmatch/harness.ts) for the scripts/pmatch-*.ts checks: builds the bundle,
// serves it with the files a check names, collects what the page uploads, trains the
// PyTorch model on analyses the page posts to /train (server/pmatch-trainer.ts), and
// calls window.pmatch.
import { createReadStream, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { build } from "vite";
import { handleTrainRequest } from "../../server/pmatch-trainer.ts";

export const PMATCH_OUT = resolve("dist-tools/pmatch");

/** The Trap Nation "Butterflies" upload the reference checks use (not in the repository). */
export const REFERENCE =
  process.env.PMATCH_REFERENCE ?? join(process.env.USERPROFILE ?? "", "Downloads", "William Black & Fairlane - Butterflies (ft. Dia Frampton) - Trap Nation (1080p, h264).mp4");

export interface PmatchBrowser {
  page: Page;
  /** Calls window.pmatch[name](...args) in the page. */
  call<T>(name: string, ...args: unknown[]): Promise<T>;
  /** Bytes the page uploaded under `key`. */
  uploaded(key: string): Buffer;
  /** Serves `path` at the returned URL. */
  serve(path: string, name?: string): string;
  /** Serves bytes at the returned URL. */
  serveBytes(bytes: Uint8Array, name: string): string;
  close(): Promise<void>;
}

export async function buildHarness(): Promise<Buffer> {
  const outDir = join(PMATCH_OUT, "harness");
  await build({
    root: resolve("."),
    configFile: false,
    logLevel: "error",
    build: { outDir, emptyOutDir: true, minify: false, lib: { entry: resolve("src/extra/pmatch/harness.ts"), name: "Pmatch", formats: ["iife"], fileName: () => "pmatch.js" } },
  });
  return readFileSync(join(outDir, "pmatch.js"));
}

/** `trained`: where the trainer keeps the last analysis, raw model and PyTorch checkpoint. */
export async function openPmatch(options: { harness?: Buffer; trained?: string } = {}): Promise<PmatchBrowser> {
  mkdirSync(PMATCH_OUT, { recursive: true });
  const harness = options.harness ?? (await buildHarness());
  const uploads = new Map<string, Buffer>();
  const files = new Map<string, string>();
  const blobs = new Map<string, Uint8Array>();
  const server: Server = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? "/");
    if (req.method === "POST" && url === "/train") return void handleTrainRequest(req, res, { keep: options.trained ?? join(PMATCH_OUT, "trained") });
    if (req.method === "POST" && url.startsWith("/upload/")) {
      const parts: Buffer[] = [];
      req.on("data", (c: Buffer) => parts.push(c));
      req.on("end", () => {
        uploads.set(url.slice("/upload/".length), Buffer.concat(parts));
        res.writeHead(204).end();
      });
      return;
    }
    if (url === "/pmatch.js") return void res.writeHead(200, { "content-type": "text/javascript" }).end(harness);
    if (files.has(url)) {
      const path = files.get(url)!;
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": statSync(path).size });
      return void createReadStream(path).pipe(res);
    }
    if (blobs.has(url)) return void res.writeHead(200, { "content-type": "application/octet-stream" }).end(blobs.get(url));
    res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><html><body><script src="/pmatch.js"></script></body></html>');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const browser: Browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-unsafe-webgpu", "--force-high-performance-gpu"],
  });
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`page ${m.type()}: ${m.text()}`);
  });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => (globalThis as { pmatch?: unknown }).pmatch !== undefined);
  let served = 0;
  return {
    page,
    call: <T>(name: string, ...args: unknown[]) =>
      page.evaluate(([n, a]) => (globalThis as any).pmatch[n as string](...(a as unknown[])), [name, args] as const) as Promise<T>,
    uploaded(key) {
      const data = uploads.get(key);
      if (!data) throw new Error(`the page did not upload ${key}`);
      return data;
    },
    serve(path, name) {
      const url = `/files/${served++}/${name ?? "file"}`;
      files.set(url, path);
      return url;
    },
    serveBytes(bytes, name) {
      const url = `/blobs/${served++}/${name}`;
      blobs.set(url, bytes);
      return url;
    },
    async close() {
      await browser.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Float32 view of an uploaded buffer. */
export function floats(data: Buffer): Float32Array {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return new Float32Array(copy.buffer);
}
