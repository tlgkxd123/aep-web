// H.264 encoded in WebAssembly (minih264 through h264-mp4-encoder, MIT / public domain / MPL 1.1 libmp4v2), for
// browsers whose WebCodecs has no H.264 encoder, such as Android's WebView. The encoder writes an MP4 of its own;
// its samples are read back so the export's muxer writes them with the audio track and the colour signalling.
import type { H264MP4Encoder } from "h264-mp4-encoder";
import type { Quality } from "./settings.ts";
import type { EncodedFrame, PictureEncoder } from "./video.ts";
import { BT709, type I420 } from "./yuv.ts";

type Hme = { createH264MP4Encoder(): Promise<H264MP4Encoder> };
let loaded: Promise<Hme> | undefined;

/** The web build only declares a global `HME`; as a module it exports it instead of touching the page's globals. */
function loadEncoder(): Promise<Hme> {
  loaded ??= (async () => {
    const { default: encoderSource } = await import("h264-mp4-encoder/embuild/dist/h264-mp4-encoder.web.js?raw");
    const url = URL.createObjectURL(new Blob([`${encoderSource}\nexport default HME;`], { type: "text/javascript" }));
    try {
      return (await import(/* @vite-ignore */ url)).default as Hme;
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  return loaded;
}

export const softwareH264Supported = (): boolean => typeof WebAssembly !== "undefined";

const SPEED: Record<Quality, number> = { fast: 10, good: 5, high: 0 };

interface Box {
  type: string;
  body: number;
  end: number;
}

function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Box[] = [];
  for (let p = start; p + 8 <= end; ) {
    let size = view.getUint32(p);
    let body = p + 8;
    if (size === 1) {
      size = Number(view.getBigUint64(p + 8));
      body += 8;
    } else if (size === 0) size = end - p;
    if (size < 8 || p + size > end) break;
    out.push({ type: String.fromCharCode(...bytes.subarray(p + 4, p + 8)), body, end: p + size });
    p += size;
  }
  return out;
}

function child(bytes: Uint8Array, parent: Box | undefined, path: string[]): Box | undefined {
  let at = parent;
  for (const type of path) at = at && boxes(bytes, at.body, at.end).find((b) => b.type === type);
  return at;
}

/** The video samples and the avcC of a single-track MP4. */
export function readMp4Video(bytes: Uint8Array): { description: Uint8Array; samples: Uint8Array[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = boxes(bytes, 0, bytes.length).find((b) => b.type === "moov");
  const stbl = child(bytes, moov, ["trak", "mdia", "minf", "stbl"]);
  const stsd = child(bytes, stbl, ["stsd"]);
  const stsz = child(bytes, stbl, ["stsz"]);
  const stsc = child(bytes, stbl, ["stsc"]);
  const stco = child(bytes, stbl, ["stco"]) ?? child(bytes, stbl, ["co64"]);
  if (!stsd || !stsz || !stsc || !stco) throw new Error("The H.264 encoder wrote an MP4 without a sample table.");
  // stsd: version/flags, entry count, then the avc1 entry whose children follow its 78 bytes of fields.
  const avc1 = boxes(bytes, stsd.body + 8, stsd.end)[0];
  const avcC = avc1 && boxes(bytes, avc1.body + 78, avc1.end).find((b) => b.type === "avcC");
  if (!avcC) throw new Error("The H.264 encoder wrote no avcC.");
  const fixed = view.getUint32(stsz.body + 4);
  const count = view.getUint32(stsz.body + 8);
  const sizes = Array.from({ length: count }, (_, i) => fixed || view.getUint32(stsz.body + 12 + i * 4));
  const chunks = view.getUint32(stco.body + 4);
  const offsets = Array.from({ length: chunks }, (_, i) =>
    stco.type === "co64" ? Number(view.getBigUint64(stco.body + 8 + i * 8)) : view.getUint32(stco.body + 8 + i * 4),
  );
  const runs = Array.from({ length: view.getUint32(stsc.body + 4) }, (_, i) => ({
    first: view.getUint32(stsc.body + 8 + i * 12) - 1,
    perChunk: view.getUint32(stsc.body + 12 + i * 12),
  }));
  const samples: Uint8Array[] = [];
  for (let c = 0, s = 0; c < chunks && s < count; c++) {
    const run = runs.filter((r) => r.first <= c).pop();
    let p = offsets[c];
    for (let k = 0; k < (run?.perChunk ?? 1) && s < count; k++, s++) {
      samples.push(bytes.subarray(p, p + sizes[s]));
      p += sizes[s];
    }
  }
  return { description: bytes.slice(avcC.body, avcC.end), samples };
}

/** Whether a sample of 4-byte length-prefixed NAL units holds an IDR slice (the encoder's MP4 marks every sample sync). */
function isIdr(sample: Uint8Array): boolean {
  const view = new DataView(sample.buffer, sample.byteOffset, sample.byteLength);
  for (let p = 0; p + 4 < sample.length; p += 4 + view.getUint32(p)) if ((sample[p + 4] & 31) === 5) return true;
  return false;
}

const hex = (n: number) => n.toString(16).padStart(2, "0");

export class SoftwareH264 implements PictureEncoder {
  readonly frames: EncodedFrame[] = [];
  private readonly times: { timestamp: number; duration: number }[] = [];
  private encoder: H264MP4Encoder | null;
  private readonly width: number;
  private readonly height: number;

  private constructor(encoder: H264MP4Encoder, width: number, height: number) {
    this.encoder = encoder;
    this.width = width;
    this.height = height;
  }

  static async create(width: number, height: number, fps: number, bitrate: number, keyInterval: number, quality: Quality): Promise<SoftwareH264> {
    const encoder = await (await loadEncoder()).createH264MP4Encoder();
    encoder.width = width;
    encoder.height = height;
    encoder.frameRate = Math.max(1, Math.round(fps));
    encoder.kbps = Math.max(1, Math.round(bitrate / 1000));
    encoder.speed = SPEED[quality];
    encoder.groupOfPictures = keyInterval;
    encoder.outputFilename = "export.mp4";
    encoder.initialize();
    return new SoftwareH264(encoder, width, height);
  }

  async encode(picture: I420, timestamp: number, duration: number): Promise<void> {
    if (!this.encoder) throw new Error("The H.264 encoder is closed.");
    this.encoder.addFrameYuv(picture.data);
    this.times.push({ timestamp, duration });
  }

  async flush(): Promise<void> {
    const encoder = this.encoder;
    if (!encoder) return;
    encoder.finalize();
    const mp4 = encoder.FS.readFile(encoder.outputFilename);
    encoder.FS.unlink(encoder.outputFilename);
    this.close();
    const { description, samples } = readMp4Video(mp4);
    const codec = `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;
    samples.forEach((data, i) => {
      const time = this.times[i] ?? { timestamp: 0, duration: 0 };
      this.frames.push({
        data,
        type: i === 0 || isIdr(data) ? "key" : "delta",
        ...time,
        meta: i === 0 ? { decoderConfig: { codec, codedWidth: this.width, codedHeight: this.height, description, colorSpace: { ...BT709 } } } : undefined,
      });
    });
  }

  close(): void {
    this.encoder?.delete();
    this.encoder = null;
  }
}
