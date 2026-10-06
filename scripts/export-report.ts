// Export gate: renders Render Queue items in headless Edge and checks the files
// with readers that share no code with the writers.
//
//   node scripts/export-report.ts [--require] [--gpu] [--only case,case]
//
// PNG sequences (zip) must hold exactly the renderer's frames, byte for byte.
// H.264 MP4 and VP9 WebM are demuxed in Node, decoded with VideoDecoder and
// must reach PSNR >= 35 dB on every frame against the renderer's frames, with
// the right frame count, duration, frame rate and colour signalling. WebM alpha
// is decoded from its BlockAdditional stream the same way. Every file is also
// played in a <video> element (duration, size, PSNR >= 30 dB, alpha). The page
// is served from 127.0.0.1 because WebCodecs needs a secure context.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright-core";
import { build } from "vite";
import { SAMPLES } from "./lib/paths.ts";
import { ROOT } from "./lib/suites.ts";
import { encodePng } from "./lib/png.ts";
import { decodePng } from "./lib/png-decode.ts";
import { readZip } from "./lib/zip-read.ts";
import { demuxMp4 } from "./lib/mp4-demux.ts";
import { demuxWebm } from "./lib/webm-demux.ts";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const only = opt("--only")?.split(",");
const DECODE_PSNR = 35;
const VIDEO_ELEMENT_PSNR = 30;

type Format = "h264" | "vp9" | "png";
type Channels = "rgb" | "rgba";
interface Settings {
  resolution: 1 | 2 | 3 | 4;
  timeSpan: "workArea" | "comp" | "custom";
  customStart: number;
  customDuration: number;
  frameRate: number | null;
}
interface Case {
  name: string;
  file: string;
  comp: string;
  settings: Partial<Settings>;
  outputs: { format: Format; channels: Channels }[];
  stopAfter?: number;
  /** Large saturated flat areas: also prove the flat-area check fails for a wrong colour matrix or range. */
  control?: boolean;
}

const fixtures = join(ROOT, "fixtures/fixtures.aep");
const complete = join(resolve(SAMPLES), "versions/ae2025/complete.aep");
const all = (alpha: boolean): Case["outputs"] => [
  { format: "png", channels: "rgba" },
  { format: "png", channels: "rgb" },
  { format: "h264", channels: "rgb" },
  { format: "vp9", channels: "rgb" },
  ...(alpha ? [{ format: "vp9" as const, channels: "rgba" as const }] : []),
];
const CASES = ([
  { name: "shape_animated_trim", file: fixtures, comp: "shape_animated_trim", settings: {}, outputs: all(true) },
  { name: "blend_overlay", file: fixtures, comp: "blend_overlay", settings: {}, outputs: [{ format: "h264", channels: "rgb" }, { format: "vp9", channels: "rgb" }], control: true },
  { name: "anim_rotation_opacity", file: fixtures, comp: "anim_rotation_opacity", settings: {}, outputs: [{ format: "png", channels: "rgba" }, { format: "vp9", channels: "rgba" }] },
  { name: "Main_Comp full", file: complete, comp: "Main_Comp", settings: { timeSpan: "custom", customStart: 2, customDuration: 0.5 }, outputs: [{ format: "h264", channels: "rgb" }, { format: "png", channels: "rgb" }] },
  { name: "Main_Comp half", file: complete, comp: "Main_Comp", settings: { resolution: 2, timeSpan: "custom", customStart: 2, customDuration: 0.5 }, outputs: [{ format: "png", channels: "rgba" }, { format: "vp9", channels: "rgb" }] },
  { name: "Main_Comp third", file: complete, comp: "Main_Comp", settings: { resolution: 3, timeSpan: "custom", customStart: 3, customDuration: 0.5 }, outputs: [{ format: "vp9", channels: "rgba" }, { format: "h264", channels: "rgb" }] },
  { name: "DropFrame_Comp", file: complete, comp: "DropFrame_Comp", settings: { timeSpan: "custom", customStart: 0, customDuration: 0.5 }, outputs: [{ format: "h264", channels: "rgb" }, { format: "vp9", channels: "rgb" }] },
  { name: "Small_Comp third (odd width)", file: complete, comp: "Small_Comp", settings: { resolution: 3, timeSpan: "custom", customStart: 0, customDuration: 0.5 }, outputs: [{ format: "png", channels: "rgba" }, { format: "h264", channels: "rgb" }, { format: "vp9", channels: "rgba" }] },
  { name: "Main_Comp stopped", file: complete, comp: "Main_Comp", settings: { timeSpan: "custom", customStart: 2, customDuration: 1 }, outputs: [{ format: "png", channels: "rgb" }], stopAfter: 3 },
] satisfies Case[] as Case[]).filter((c) => !only || only.some((o) => c.name.includes(o)));

const outDir = resolve("dist-tools/export-harness");
await build({
  root: resolve("."),
  configFile: false,
  logLevel: "error",
  build: { outDir, emptyOutDir: true, minify: false, lib: { entry: resolve("scripts/export/export-entry.ts"), name: "AepExport", formats: ["iife"], fileName: () => "export.js" } },
});
const harnessJs = readFileSync(join(outDir, "export.js"));
const reportDir = resolve("dist-tools/export-report");
mkdirSync(reportDir, { recursive: true });

const uploads = new Map<string, Buffer>();
const server = createServer((req, res) => {
  if (req.method === "POST" && req.url?.startsWith("/upload/")) {
    const key = decodeURIComponent(req.url.slice("/upload/".length));
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      uploads.set(key, Buffer.concat(parts));
      res.writeHead(204).end();
    });
    return;
  }
  if (req.url === "/export.js") res.writeHead(200, { "content-type": "text/javascript" }).end(harnessJs);
  else res.writeHead(200, { "content-type": "text/html" }).end('<!doctype html><html><body><script src="/export.js"></script></body></html>');
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;

const gpu = args.includes("--gpu");
const browser = await chromium.launch({ channel: "msedge", headless: true, args: gpu ? [] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log(`page error: ${e.message}`));
await page.goto(`http://127.0.0.1:${port}/`);
const call = <T>(fn: string, ...params: unknown[]): Promise<T> =>
  page.evaluate(([f, p]) => (globalThis as any).aepExport[f as string](...(p as unknown[])), [fn, params] as const) as Promise<T>;

interface Result {
  label: string;
  ok: boolean;
  detail: string;
}
const results: Result[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
};

// Codec support in this browser.
const probe = await call<{ userAgent: string; secure: boolean; rows: Record<string, string | boolean>[] }>("probe", 1920, 1080, 24);
console.log(`${probe.userAgent}${gpu ? " (GPU)" : " (swiftshader)"}, secure context: ${probe.secure}`);
console.log("VideoEncoder/VideoDecoder.isConfigSupported at 1920x1080, 24 fps:");
for (const row of probe.rows) {
  console.log(`  ${String(row.label).padEnd(28)} encode sw ${String(row["encode prefer-software"]).padEnd(5)} hw ${String(row["encode prefer-hardware"]).padEnd(5)} decode ${row.decode}`);
}
const supported = (prefix: string) => probe.rows.some((r) => String(r.label).startsWith(prefix) && !String(r.label).includes("alpha") && (r["encode prefer-software"] === true || r["encode prefer-hardware"] === true));
check("H.264 encoding is supported", supported("H.264"));
check("VP9 encoding is supported", supported("VP9 vp09"));

// Independent BT.709 limited-range YUV to RGB, then comparisons.
const KR = 0.2126;
const KB = 0.0722;
const KG = 1 - KR - KB;
function i420ToRgba(
  buf: Buffer,
  width: number,
  height: number,
  layout: { offset: number; stride: number }[],
  format: string | null,
  matrix = { kr: KR, kb: KB, fullRange: false },
): Uint8Array {
  const { kr, kb, fullRange } = matrix;
  const kg = 1 - kr - kb;
  const out = new Uint8Array(width * height * 4);
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const Y = buf[layout[0].offset + y * layout[0].stride + x];
      let U: number;
      let V: number;
      if (format === "NV12") {
        const o = layout[1].offset + (y >> 1) * layout[1].stride + (x >> 1) * 2;
        U = buf[o];
        V = buf[o + 1];
      } else {
        U = buf[layout[1].offset + (y >> 1) * layout[1].stride + (x >> 1)];
        V = buf[layout[2].offset + (y >> 1) * layout[2].stride + (x >> 1)];
      }
      const yy = fullRange ? Y / 255 : (Y - 16) / 219;
      const pb = (U - 128) / (fullRange ? 255 : 224);
      const pr = (V - 128) / (fullRange ? 255 : 224);
      const r = yy + 2 * (1 - kr) * pr;
      const b = yy + 2 * (1 - kb) * pb;
      const g = (yy - kr * r - kb * b) / kg;
      const p = (y * width + x) * 4;
      out[p] = clamp(r * 255);
      out[p + 1] = clamp(g * 255);
      out[p + 2] = clamp(b * 255);
      out[p + 3] = 255;
    }
  }
  return out;
}
/** What a lossless 4:2:0 codec returns for an RGB image: BT.709 limited range, 2x2 mean chroma, back with nearest chroma. */
function roundTrip420(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const cw = (width + 1) >> 1;
  const ch = (height + 1) >> 1;
  const buf = Buffer.alloc(width * height + 2 * cw * ch);
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  for (let i = 0; i < width * height; i++) {
    buf[i] = clamp(16 + 219 * ((KR * rgba[i * 4] + KG * rgba[i * 4 + 1] + KB * rgba[i * 4 + 2]) / 255));
  }
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = 2 * cy; y < Math.min(height, 2 * cy + 2); y++) {
        for (let x = 2 * cx; x < Math.min(width, 2 * cx + 2); x++) {
          r += rgba[(y * width + x) * 4] / 255;
          g += rgba[(y * width + x) * 4 + 1] / 255;
          b += rgba[(y * width + x) * 4 + 2] / 255;
          n++;
        }
      }
      r /= n;
      g /= n;
      b /= n;
      const yy = KR * r + KG * g + KB * b;
      buf[width * height + cy * cw + cx] = clamp(128 + (224 * (b - yy)) / (2 * (1 - KB)));
      buf[width * height + cw * ch + cy * cw + cx] = clamp(128 + (224 * (r - yy)) / (2 * (1 - KR)));
    }
  }
  const out = i420ToRgba(buf, width, height, [{ offset: 0, stride: width }, { offset: width * height, stride: cw }, { offset: width * height + cw * ch, stride: cw }], "I420");
  for (let p = 3; p < out.length; p += 4) out[p] = rgba[p];
  return out;
}
/**
 * Pixels whose 5x5 neighbourhood varies by at most 2/255 in every channel (premultiplied when asked): there 4:2:0
 * chroma is exact, so any error left is codec loss or a wrong colour matrix or range.
 */
function flatMask(rgba: Uint8Array, width: number, height: number, premultiplied: boolean): Uint8Array {
  const R = 2;
  const flat = new Uint8Array(width * height).fill(1);
  const values = new Uint8Array(width * height);
  const lo = new Uint8Array(width * height);
  const hi = new Uint8Array(width * height);
  for (let c = 0; c < 4; c++) {
    for (let p = 0; p < values.length; p++) values[p] = premultiplied && c < 3 ? Math.round((rgba[p * 4 + c] * rgba[p * 4 + 3]) / 255) : rgba[p * 4 + c];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let min = 255, max = 0;
        for (let dx = -R; dx <= R; dx++) {
          const v = values[y * width + Math.min(width - 1, Math.max(0, x + dx))];
          if (v < min) min = v;
          if (v > max) max = v;
        }
        lo[y * width + x] = min;
        hi[y * width + x] = max;
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let min = 255, max = 0;
        for (let dy = -R; dy <= R; dy++) {
          const q = Math.min(height - 1, Math.max(0, y + dy)) * width + x;
          if (lo[q] < min) min = lo[q];
          if (hi[q] > max) max = hi[q];
        }
        if (max - min > 2) flat[y * width + x] = 0;
      }
    }
  }
  return flat;
}
/** RGB PSNR over the flat pixels of `want` (premultiplied by each image's alpha when asked). */
function psnrFlat(got: Uint8Array, want: Uint8Array, mask: Uint8Array, premultiplied = false): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const p = i * 4;
    const fa = premultiplied ? got[p + 3] / 255 : 1;
    const fb = premultiplied ? want[p + 3] / 255 : 1;
    for (let c = 0; c < 3; c++) {
      const d = got[p + c] * fa - want[p + c] * fb;
      sum += d * d;
      n++;
    }
  }
  return n ? psnrOf(sum, n) : Infinity;
}
const share = (mask: Uint8Array) => mask.reduce((n, v) => n + v, 0) / mask.length;
function lumaPlane(buf: Buffer, width: number, height: number, layout: { offset: number; stride: number }[]): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) out.set(buf.subarray(layout[0].offset + y * layout[0].stride, layout[0].offset + y * layout[0].stride + width), y * width);
  return out;
}
function matte(rgba: Uint8Array, bg: number[]): Uint8Array {
  const out = new Uint8Array(rgba.length);
  const b = bg.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255));
  for (let p = 0; p < rgba.length; p += 4) {
    const a = rgba[p + 3];
    for (let c = 0; c < 3; c++) out[p + c] = Math.round((rgba[p + c] * a + b[c] * (255 - a)) / 255);
    out[p + 3] = 255;
  }
  return out;
}
function cropRgba(rgba: Uint8Array, stride: number, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) out.set(rgba.subarray(y * stride * 4, (y * stride + width) * 4), y * width * 4);
  return out;
}
const psnrOf = (sum: number, n: number) => (sum === 0 ? Infinity : 10 * Math.log10((255 * 255 * n) / sum));
/** PSNR over RGB; with `premultiplied`, colour is compared after multiplying by each image's own alpha. */
function psnrRgb(a: Uint8Array, b: Uint8Array, premultiplied = false): number {
  let sum = 0;
  let n = 0;
  for (let p = 0; p < a.length; p += 4) {
    const fa = premultiplied ? a[p + 3] / 255 : 1;
    const fb = premultiplied ? b[p + 3] / 255 : 1;
    for (let c = 0; c < 3; c++) {
      const d = a[p + c] * fa - b[p + c] * fb;
      sum += d * d;
      n++;
    }
  }
  return psnrOf(sum, n);
}
function psnrAlpha(alpha: Uint8Array, rgba: Uint8Array, stride = 1): number {
  let sum = 0;
  for (let i = 0; i < rgba.length / 4; i++) {
    const d = alpha[i * stride + (stride === 4 ? 3 : 0)] - rgba[i * 4 + 3];
    sum += d * d;
  }
  return psnrOf(sum, rgba.length / 4);
}
const fmtDb = (v: number) => (v === Infinity ? "inf" : `${v.toFixed(1)} dB`);
const minOf = (v: number[]) => v.reduce((m, x) => Math.min(m, x), Infinity);

function saveDebug(name: string, width: number, height: number, rgba: Uint8Array) {
  writeFileSync(join(reportDir, `${name.replace(/[^\w.-]+/g, "_")}.png`), encodePng(width, height, rgba));
}

let loadedFile = "";
for (const c of CASES) {
  console.log(`\n== ${c.name} (${c.comp})`);
  if (loadedFile !== c.file) {
    await call("load", readFileSync(c.file).toString("base64"));
    loadedFile = c.file;
  }
  const settings: Settings = { resolution: 1, timeSpan: "workArea", customStart: 0, customDuration: 0, frameRate: null, ...c.settings };
  const ref = await call<{ frames: number; width: number; height: number; fps: number; times: number[]; bgColor: number[]; frameRate: number }>("reference", c.name, c.comp, settings);
  const refFrame = (i: number) => new Uint8Array(uploads.get(`${c.name}/ref/${i}`)!);
  console.log(`${ref.frames} frames at ${ref.fps.toFixed(3)} fps, ${ref.width}x${ref.height}`);
  for (const o of c.outputs) {
    const key = `${c.name}/${o.format}-${o.channels}`;
    const tag = `${c.name} ${o.format} ${o.channels.toUpperCase()}`;
    const run = await call<{
      statuses: string[];
      status: string;
      error?: string;
      frame: number;
      frames: number;
      fileName: string;
      bytes: number;
      sinkClosed: boolean;
      sinkAborted: boolean;
      maxFrame: number;
      ms: number;
      idle: boolean;
    }>("exportItem", key, c.comp, settings, { format: o.format, channels: o.channels, bitrate: null }, c.stopAfter);
    if (c.stopAfter !== undefined) {
      check(
        `${tag}: Stop ends the render as User Stopped and discards the file`,
        run.status === "User Stopped" && run.statuses.join(">") === "Queued>Rendering>User Stopped" && run.sinkAborted && !run.sinkClosed && run.frame < run.frames && run.idle,
        `${run.statuses.join(" > ")}, ${run.frame}/${run.frames} frames, sink ${run.sinkAborted ? "aborted" : run.sinkClosed ? "closed" : "open"}`,
      );
      continue;
    }
    const rendered = run.status === "Done" && run.statuses.join(">") === "Queued>Rendering>Done" && run.maxFrame === ref.frames && run.sinkClosed && !run.sinkAborted && run.idle;
    check(`${tag}: queue item renders to Done`, rendered, `${run.statuses.join(" > ")}${run.error ? ` (${run.error})` : ""}, progress ${run.maxFrame}/${ref.frames}, ${(run.bytes / 1024).toFixed(0)} KB in ${(run.ms / 1000).toFixed(1)} s`);
    if (!rendered) continue;
    const file = new Uint8Array(uploads.get(`${key}/out`)!);
    const evenW = o.format === "h264" ? ref.width & ~1 : ref.width;
    const evenH = o.format === "h264" ? ref.height & ~1 : ref.height;
    const expectRgb = (i: number) => cropRgba(matte(refFrame(i), ref.bgColor), ref.width, evenW, evenH);

    if (o.format === "png") {
      let detail = "";
      let ok = true;
      try {
        const entries = readZip(file);
        const stem = run.fileName.replace(/\.zip$/, "");
        const names = ref.times.map((t) => `${stem}_${String(Math.round(t * ref.fps)).padStart(5, "0")}.png`);
        if (entries.length !== ref.frames || entries.some((e, i) => e.name !== names[i])) {
          ok = false;
          detail = `entries ${entries.slice(0, 3).map((e) => e.name).join(", ")}... (${entries.length}), expected ${names[0]}... (${ref.frames})`;
        } else {
          let differing = 0;
          let wrongType = 0;
          entries.forEach((e, i) => {
            const png = decodePng(e.data);
            if (png.colorType !== (o.channels === "rgba" ? 6 : 2) || png.width !== ref.width || png.height !== ref.height) wrongType++;
            const want = o.channels === "rgba" ? refFrame(i) : matte(refFrame(i), ref.bgColor);
            if (png.rgba.length !== want.length || png.rgba.some((v, k) => v !== want[k])) {
              if (differing === 0) {
                saveDebug(`${key}-png-${i}`, png.width, png.height, png.rgba);
                saveDebug(`${key}-ref-${i}`, ref.width, ref.height, want);
              }
              differing++;
            }
          });
          ok = differing === 0 && wrongType === 0;
          detail = `${entries.length} PNGs (${names[0]} ...), ${differing} differ from the renderer, ${wrongType} with wrong size or colour type`;
        }
      } catch (e) {
        ok = false;
        detail = (e as Error).message;
      }
      check(`${tag}: zip holds the renderer's frames byte for byte`, ok, detail);
      continue;
    }

    // Container structure.
    let samples: { offset: number; size: number; timestamp: number; duration: number; key: boolean }[] = [];
    let alphaSamples: typeof samples | null = null;
    let codec = "";
    let description: number[] | null = null;
    const frameUs = 1e6 / ref.fps;
    if (o.format === "h264") {
      try {
        const mp4 = demuxMp4(file);
        const fpsMeasured = mp4.samples.map((s) => mp4.timescale / s.duration);
        const durationS = mp4.duration / mp4.timescale;
        const movieS = mp4.movieDuration / mp4.movieTimescale;
        const expectS = ref.frames / ref.fps;
        const colr = mp4.colr;
        const problems = [
          mp4.sampleEntry !== "avc1" && `sample entry ${mp4.sampleEntry}`,
          (mp4.width !== evenW || mp4.height !== evenH) && `size ${mp4.width}x${mp4.height}`,
          mp4.samples.length !== ref.frames && `${mp4.samples.length} samples`,
          !mp4.samples[0]?.key && "first sample is not a sync sample",
          fpsMeasured.some((f) => Math.abs(f - ref.fps) > 0.01) && `frame rate ${minOf(fpsMeasured).toFixed(3)}`,
          Math.abs(durationS - expectS) > 0.5 / ref.fps && `media duration ${durationS.toFixed(4)} s`,
          Math.abs(movieS - expectS) > 0.5 / ref.fps && `movie duration ${movieS.toFixed(4)} s`,
          !(colr && colr.primaries === 1 && colr.transfer === 1 && colr.matrix === 1 && !colr.fullRange) && `colr ${JSON.stringify(colr)}`,
          !mp4.avcC && "no avcC",
        ].filter(Boolean);
        check(
          `${tag}: MP4 has ${ref.frames} frames at ${ref.fps.toFixed(3)} fps, ${(expectS).toFixed(3)} s, BT.709`,
          problems.length === 0,
          problems.length ? problems.join("; ") : `${mp4.width}x${mp4.height}, timescale ${mp4.timescale}, ${durationS.toFixed(4)} s, ${(file.length / 1024).toFixed(0)} KB`,
        );
        const avcC = mp4.avcC!;
        const hex = (n: number) => n.toString(16).padStart(2, "0");
        codec = `avc1.${hex(avcC[1])}${hex(avcC[2])}${hex(avcC[3])}`;
        description = [...avcC];
        samples = mp4.samples.map((s) => ({ offset: s.offset, size: s.size, timestamp: Math.round((s.cts * 1e6) / mp4.timescale), duration: Math.round((s.duration * 1e6) / mp4.timescale), key: s.key }));
      } catch (e) {
        check(`${tag}: MP4 demuxes`, false, (e as Error).message);
        continue;
      }
    } else {
      try {
        const webm = demuxWebm(file);
        const toS = (t: number) => (t * webm.timecodeScale) / 1e9;
        const expectS = ref.frames / ref.fps;
        const deltas = webm.blocks.slice(1).map((b, i) => toS(b.time - webm.blocks[i].time));
        const alpha = o.channels === "rgba";
        const seekOk = [0x1549a966, 0x1654ae6b, 0x1c53bb6b].every((id) => webm.seekHead.get(id) !== undefined && webm.segmentChildren.get(id)?.[0] === webm.seekHead.get(id));
        const problems = [
          webm.docType !== "webm" && `DocType ${webm.docType}`,
          webm.codec !== "V_VP9" && `codec ${webm.codec}`,
          (webm.width !== ref.width || webm.height !== ref.height) && `size ${webm.width}x${webm.height}`,
          webm.blocks.length !== ref.frames && `${webm.blocks.length} blocks`,
          !webm.blocks[0]?.key && "first block is not a keyframe",
          webm.duration === undefined ? "no Duration" : Math.abs(toS(webm.duration) - expectS) > 0.5 / ref.fps && `Duration ${toS(webm.duration).toFixed(4)} s`,
          !webm.defaultDuration ? "no DefaultDuration" : Math.abs(1e9 / webm.defaultDuration - ref.fps) > 0.01 && `DefaultDuration ${webm.defaultDuration}`,
          deltas.some((d) => Math.abs(d - 1 / ref.fps) > 0.0011) && `block spacing ${minOf(deltas).toFixed(4)} s`,
          (webm.cues.length === 0 || webm.cues.some((q) => !webm.clusterPositions.includes(q.clusterPosition)) || webm.cues[0].time !== 0) && `cues ${JSON.stringify(webm.cues.slice(0, 3))}`,
          !seekOk && "SeekHead positions do not match Info/Tracks/Cues",
          !(webm.colour?.matrix === 1 && webm.colour.range === 1 && webm.colour.transfer === 1 && webm.colour.primaries === 1) && `Colour ${JSON.stringify(webm.colour)}`,
          alpha && webm.alphaMode !== 1 && `AlphaMode ${webm.alphaMode}`,
          alpha && webm.blocks.some((b) => !b.alpha || b.alpha.id !== 1) && "blocks without BlockAdditional 1",
          !alpha && (webm.alphaMode !== 0 || webm.blocks.some((b) => b.alpha)) && "unexpected alpha",
        ].filter(Boolean);
        check(
          `${tag}: WebM has ${ref.frames} frames at ${ref.fps.toFixed(3)} fps, ${expectS.toFixed(3)} s, cues, BT.709${alpha ? ", AlphaMode 1 with alpha in every block" : ""}`,
          problems.length === 0,
          problems.length ? problems.join("; ") : `${webm.width}x${webm.height}, ${webm.cues.length} cues, ${webm.clusterPositions.length} clusters, ${(file.length / 1024).toFixed(0)} KB`,
        );
        codec = "vp09.00.10.08";
        const ts = (b: { time: number }) => Math.round((b.time * webm.timecodeScale) / 1000);
        samples = webm.blocks.map((b) => ({ offset: b.offset, size: b.size, timestamp: ts(b), duration: Math.round(frameUs), key: b.key }));
        if (alpha) alphaSamples = webm.blocks.map((b) => ({ offset: b.alpha!.offset, size: b.alpha!.size, timestamp: ts(b), duration: Math.round(frameUs), key: b.key }));
      } catch (e) {
        check(`${tag}: WebM demuxes`, false, (e as Error).message);
        continue;
      }
    }

    // VideoDecoder round trip.
    type Picture = { format: string | null; width: number; height: number; timestamp: number; layout: { offset: number; stride: number }[] };
    try {
      const pictures = await call<Picture[]>("decode", key, codec, description, samples, `${key}/dec`);
      const alphaPictures = alphaSamples ? await call<Picture[]>("decode", key, codec, null, alphaSamples, `${key}/deca`) : null;
      const codecDb: number[] = [];
      const flatDb: number[] = [];
      const rgbDb: number[] = [];
      const alphaDb: number[] = [];
      const flatShare: number[] = [];
      const premultiplied = !!alphaPictures;
      let sizeOk = pictures.length === ref.frames && (!alphaPictures || alphaPictures.length === ref.frames);
      let worst: { db: number; i: number; rgba: Uint8Array } = { db: Infinity, i: -1, rgba: new Uint8Array(0) };
      const misreads = { bt601: [] as number[], full: [] as number[] };
      pictures.forEach((pic, i) => {
        if (pic.width !== evenW || pic.height !== evenH) sizeOk = false;
        const planes = uploads.get(`${key}/dec/${i}`)!;
        const rgba = i420ToRgba(planes, pic.width, pic.height, pic.layout, pic.format);
        if (alphaPictures) {
          const ap = alphaPictures[i];
          const alpha = lumaPlane(uploads.get(`${key}/deca/${i}`)!, ap.width, ap.height, ap.layout);
          for (let k = 0; k < alpha.length; k++) rgba[k * 4 + 3] = alpha[k];
          alphaDb.push(psnrAlpha(alpha, refFrame(i)));
        }
        const want = alphaPictures ? refFrame(i) : expectRgb(i);
        const mask = flatMask(want, evenW, evenH, premultiplied);
        flatShare.push(share(mask));
        const db = psnrRgb(rgba, roundTrip420(want, evenW, evenH), premultiplied);
        codecDb.push(db);
        flatDb.push(psnrFlat(rgba, want, mask, premultiplied));
        rgbDb.push(psnrRgb(rgba, want, premultiplied));
        if (db < worst.db) worst = { db, i, rgba };
        if (c.control && !alphaPictures) {
          misreads.bt601.push(psnrFlat(i420ToRgba(planes, pic.width, pic.height, pic.layout, pic.format, { kr: 0.299, kb: 0.114, fullRange: false }), want, mask));
          misreads.full.push(psnrFlat(i420ToRgba(planes, pic.width, pic.height, pic.layout, pic.format, { kr: KR, kb: KB, fullRange: true }), want, mask));
        }
      });
      if (misreads.bt601.length) {
        const bt601 = minOf(misreads.bt601);
        const full = minOf(misreads.full);
        check(
          `${tag}: control - the flat-area check fails when the same video is read as BT.601 or as full range`,
          bt601 < DECODE_PSNR && full < DECODE_PSNR,
          `BT.601 misread ${fmtDb(bt601)}, full-range misread ${fmtDb(full)}`,
        );
      }
      const minCodec = minOf(codecDb);
      const minFlat = minOf(flatDb);
      const minAlpha = minOf(alphaDb);
      const ok = sizeOk && minCodec >= DECODE_PSNR && minFlat >= DECODE_PSNR && (!alphaPictures || minAlpha >= DECODE_PSNR);
      if (!ok && worst.i >= 0) saveDebug(`${key}-decoded-${worst.i}`, evenW, evenH, worst.rgba);
      check(
        `${tag}: VideoDecoder output reaches ${DECODE_PSNR} dB on every frame against the frame's 4:2:0 round trip and on the frame's flat areas${alphaPictures ? ", premultiplied, alpha too" : ""}`,
        ok,
        `${pictures.length} pictures (${pictures[0]?.format}, ${pictures[0]?.width}x${pictures[0]?.height}), min ${fmtDb(minCodec)}, flat areas (${(minOf(flatShare) * 100).toFixed(0)}%+ of pixels) min ${fmtDb(minFlat)}${alphaPictures ? `, alpha min ${fmtDb(minAlpha)}` : ""}; whole-frame RGB min ${fmtDb(minOf(rgbDb))}`,
      );
    } catch (e) {
      check(`${tag}: VideoDecoder decodes the samples`, false, (e as Error).message);
    }

    // The browser's own demuxer and decoder, as a player would use them.
    const mime = o.format === "h264" ? "video/mp4" : "video/webm";
    const played = await call<{ duration?: number; width?: number; height?: number; error?: string }>("video", key, mime, ref.frames, ref.fps);
    if (played.error) {
      check(`${tag}: <video> plays the file`, false, played.error);
      continue;
    }
    const flatDb: number[] = [];
    const rgbDb: number[] = [];
    const alphaDb: number[] = [];
    const withAlpha = o.channels === "rgba" && o.format === "vp9";
    for (let i = 0; i < ref.frames; i++) {
      const grab = new Uint8Array(uploads.get(`${key}/video/${i}`)!);
      const want = withAlpha ? refFrame(i) : expectRgb(i);
      flatDb.push(psnrFlat(grab, want, flatMask(want, evenW, evenH, withAlpha), withAlpha));
      rgbDb.push(psnrRgb(grab, want, withAlpha));
      if (withAlpha) alphaDb.push(psnrAlpha(grab, refFrame(i), 4));
    }
    const expectS = ref.frames / ref.fps;
    const minFlat = minOf(flatDb);
    const minAlpha = minOf(alphaDb);
    const ok =
      Math.abs(played.duration! - expectS) <= 0.5 / ref.fps &&
      played.width === evenW &&
      played.height === evenH &&
      minFlat >= DECODE_PSNR &&
      (!withAlpha || minAlpha >= VIDEO_ELEMENT_PSNR);
    check(
      `${tag}: <video> plays ${expectS.toFixed(3)} s at ${evenW}x${evenH}, flat areas >= ${DECODE_PSNR} dB on every frame${withAlpha ? `, alpha >= ${VIDEO_ELEMENT_PSNR} dB` : ""}`,
      ok,
      `duration ${played.duration?.toFixed(4)} s, ${played.width}x${played.height}, flat areas min ${fmtDb(minFlat)}${withAlpha ? `, alpha min ${fmtDb(minAlpha)}` : ""}; whole-frame RGB min ${fmtDb(minOf(rgbDb))}`,
    );
  }
}

await browser.close();
server.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} export checks passed`);
if (args.includes("--require")) {
  if (failed.length === 0 && results.length > 0) console.log("EXPORT-PASSED");
  else {
    console.log("export requirement not met");
    process.exit(1);
  }
}
