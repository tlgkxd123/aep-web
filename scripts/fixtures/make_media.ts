// Generates the small test media of the footage fixture suite into refs/media/.
// PNGs are written directly; JPEG, TIFF, BMP, GIF and the H.264 clip go through
// ffmpeg (needed only to regenerate the committed files).
//
//   node scripts/fixtures/make_media.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePng } from "../lib/png.ts";
import { ROOT } from "../lib/suites.ts";

const MEDIA = join(ROOT, "media");
type Pixel = [number, number, number, number];

function image(width: number, height: number, pixel: (x: number, y: number) => Pixel): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.set(pixel(x, y).map((v) => Math.max(0, Math.min(255, Math.round(v)))), (y * width + x) * 4);
  }
  return out;
}

function hue(h: number): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return 255 * (1 - Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return [f(5), f(3), f(1)];
}

/** Bit `k` of `n` as a white or black square in a row of code squares. */
function code(n: number, x: number, y: number, size: number, top: number, bits: number): number | undefined {
  if (y < top || y >= top + size) return undefined;
  const k = Math.floor(x / size);
  if (k >= bits) return undefined;
  return (n >> (bits - 1 - k)) & 1 ? 255 : 0;
}

function png(name: string, width: number, height: number, pixel: (x: number, y: number) => Pixel): void {
  writeFileSync(join(MEDIA, name), encodePng(width, height, image(width, height, pixel)));
}

/** Uncompressed little-endian RGBA TIFF; `extraSamples` 1 = associated (premultiplied) alpha, 2 = unassociated. */
function tiff(name: string, width: number, height: number, extraSamples: number, pixel: (x: number, y: number) => Pixel): void {
  const pixels = image(width, height, pixel);
  const entries: [number, number, number, number][] = [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 4, 0],
    [259, 3, 1, 1],
    [262, 3, 1, 2],
    [273, 4, 1, 0],
    [277, 3, 1, 4],
    [278, 4, 1, height],
    [279, 4, 1, pixels.length],
    [284, 3, 1, 1],
    [338, 3, 1, extraSamples],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const bitsAt = 8 + ifdSize;
  const dataAt = bitsAt + 8;
  const out = Buffer.alloc(dataAt + pixels.length);
  out.write("II", 0, "ascii");
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  out.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, count, value], i) => {
    const e = 10 + i * 12;
    out.writeUInt16LE(tag, e);
    out.writeUInt16LE(type, e + 2);
    out.writeUInt32LE(count, e + 4);
    if (tag === 258) out.writeUInt32LE(bitsAt, e + 8);
    else if (tag === 273) out.writeUInt32LE(dataAt, e + 8);
    else if (type === 3) out.writeUInt16LE(value, e + 8);
    else out.writeUInt32LE(value, e + 8);
  });
  for (let c = 0; c < 4; c++) out.writeUInt16LE(8, bitsAt + c * 2);
  out.set(pixels, dataAt);
  writeFileSync(join(MEDIA, name), out);
}

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
}

rmSync(MEDIA, { recursive: true, force: true });
mkdirSync(join(MEDIA, "seq"), { recursive: true });
mkdirSync(join(MEDIA, "clip"), { recursive: true });

// Straight alpha: colour ramps, an alpha ramp, a transparent band whose colour only shows when alpha is ignored.
png("straight.png", 96, 72, (x, y) => {
  const alpha = y < 8 ? 0 : x < 16 ? 255 : Math.min(255, ((x - 16) / 64) * 255);
  return [(x / 95) * 255, (y / 71) * 255, 255 - (x / 95) * 200, alpha];
});

// Premultiplied over the matte colour (64, 128, 255): C = c*a + M*(1 - a).
const MATTE = [64, 128, 255];
png("premul.png", 96, 72, (x, y) => {
  const a = Math.min(1, Math.max(0, (y - 6) / 60));
  const c = [(x / 95) * 255, 200 - (x / 95) * 150, (y / 71) * 255];
  return [...c.map((v, i) => v * a + MATTE[i] * (1 - a)), a * 255] as Pixel;
});

// Opaque, larger than the 160x120 comps: quadrants plus smooth ramps.
png("big.png", 240, 180, (x, y) => {
  const q = (x < 120 ? 0 : 1) + (y < 90 ? 0 : 2);
  const base = [[230, 60, 40], [40, 200, 90], [50, 90, 230], [240, 220, 60]][q];
  const t = ((x % 120) / 119) * 0.5 + ((y % 90) / 89) * 0.5;
  return [base[0] * (0.5 + t / 2), base[1] * (0.5 + t / 2), base[2] * (0.5 + t / 2), 255];
});

// Opaque source for the lossy and palette formats.
png("opaque_src.png", 96, 72, (x, y) => [40 + x * 2, 30 + y * 3, 220 - x - y, 255]);
ffmpeg(["-i", join(MEDIA, "opaque_src.png"), "-q:v", "1", "-pix_fmt", "yuvj444p", join(MEDIA, "photo.jpg")]);
ffmpeg(["-i", join(MEDIA, "opaque_src.png"), "-pix_fmt", "bgr24", join(MEDIA, "still.bmp")]);

// Straight-alpha TIFF, LZW.
png("tiff_src.png", 80, 60, (x, y) => [(x / 79) * 255, 128, (y / 59) * 255, x < 10 ? 255 : 255 - (x - 10) * 3]);
ffmpeg(["-i", join(MEDIA, "tiff_src.png"), "-pix_fmt", "rgba", "-compression_algo", "lzw", join(MEDIA, "alpha.tif")]);
rmSync(join(MEDIA, "opaque_src.png"));
rmSync(join(MEDIA, "tiff_src.png"));
// The same pattern uncompressed, with unassociated and with associated (premultiplied) alpha.
const tiffPixel = (x: number, y: number): Pixel => [(x / 79) * 255, 128, (y / 59) * 255, x < 10 ? 255 : 255 - (x - 10) * 3];
tiff("alpha_raw.tif", 80, 60, 2, tiffPixel);
tiff("alpha_assoc.tif", 80, 60, 1, (x, y) => {
  const [r, g, b, a] = tiffPixel(x, y);
  return [(r * a) / 255, (g * a) / 255, (b * a) / 255, a];
});

// Image sequence seq_0001..seq_0012: one hue per frame plus the frame number in binary.
for (let n = 1; n <= 12; n++) {
  png(`seq/seq_${String(n).padStart(4, "0")}.png`, 64, 48, (x, y) => {
    const bit = code(n, x, y, 16, 32, 4);
    if (bit !== undefined) return [bit, bit, bit, 255];
    return [...hue(n * 30), 255] as Pixel;
  });
}

// 30 fps H.264 clip of 30 frames: a hue per frame, the frame number in binary, and neutral and colour ramps.
for (let n = 0; n < 30; n++) {
  png(`clip/f_${String(n).padStart(3, "0")}.png`, 96, 64, (x, y) => {
    const bit = code(n, x, y, 16, 48, 5);
    if (bit !== undefined) return [bit, bit, bit, 255];
    if (y < 16) return [...hue(n * 12), 255] as Pixel;
    if (y < 32) return [16 + x * 2.3, 16 + x * 2.3, 16 + x * 2.3, 255];
    return [x * 2.6, 255 - x * 2.6, 128 + (y - 32) * 6, 255];
  });
}
ffmpeg([
  "-framerate", "30", "-i", join(MEDIA, "clip", "f_%03d.png"),
  "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", "8",
  "-x264-params", "keyint=10:min-keyint=10:bframes=2:scenecut=0",
  "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
  "-movflags", "+faststart", join(MEDIA, "clip.mp4"),
]);
rmSync(join(MEDIA, "clip"), { recursive: true });

// A 1280x720 clip (6 frames) whose top-left corner holds the same pattern: HD sizes may pick another YUV matrix.
mkdirSync(join(MEDIA, "hd"), { recursive: true });
for (let n = 0; n < 6; n++) {
  png(`hd/f_${String(n).padStart(3, "0")}.png`, 1280, 720, (x, y) => {
    if (x >= 96 || y >= 64) return [128, 128, 128, 255];
    const bit = code(n, x, y, 16, 48, 5);
    if (bit !== undefined) return [bit, bit, bit, 255];
    if (y < 16) return [...hue(n * 40 + x * 3), 255] as Pixel;
    if (y < 32) return [16 + x * 2.3, 16 + x * 2.3, 16 + x * 2.3, 255];
    return [x * 2.6, 255 - x * 2.6, 128 + (y - 32) * 6, 255];
  });
}
ffmpeg([
  "-framerate", "30", "-i", join(MEDIA, "hd", "f_%03d.png"),
  "-c:v", "libx264", "-profile:v", "high", "-pix_fmt", "yuv420p", "-crf", "8",
  "-x264-params", "keyint=3:min-keyint=3:bframes=1:scenecut=0",
  "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
  "-movflags", "+faststart", join(MEDIA, "hd.mp4"),
]);
rmSync(join(MEDIA, "hd"), { recursive: true });
console.log(`media written to ${MEDIA}`);
