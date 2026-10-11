import type { Format, Quality } from "./settings.ts";

/** H.264 levels as [level_idc, max frame size in macroblocks, max macroblocks per second]. */
const AVC_LEVELS: [number, number, number][] = [
  [30, 1620, 40500],
  [31, 3600, 108000],
  [32, 5120, 216000],
  [40, 8192, 245760],
  [42, 8704, 522240],
  [50, 22080, 589824],
  [51, 36864, 983040],
  [52, 36864, 2073600],
  [60, 139264, 4177920],
  [61, 139264, 8355840],
  [62, 139264, 16711680],
];

/** VP9 levels as [level, max picture size in samples, max samples per second]. */
const VP9_LEVELS: [number, number, number][] = [
  [10, 36864, 829440],
  [11, 73728, 2764800],
  [20, 122880, 4608000],
  [21, 245760, 9216000],
  [30, 552960, 20736000],
  [31, 983040, 36864000],
  [40, 2228224, 83558400],
  [41, 2228224, 160432128],
  [50, 8912896, 311951360],
  [51, 8912896, 588251136],
  [52, 8912896, 1176502272],
  [60, 35651584, 1176502272],
  [61, 35651584, 2353004544],
  [62, 35651584, 4706009088],
];

const hex = (n: number) => n.toString(16).padStart(2, "0");

/** Codec strings to try for a format, best first. */
export function codecCandidates(format: Exclude<Format, "png">, width: number, height: number, fps: number): string[] {
  if (format === "h264") {
    const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
    const fitting = AVC_LEVELS.filter(([, fs, mbps]) => mbs <= fs && mbs * fps <= mbps).map(([level]) => level);
    const levels = fitting.length ? fitting.slice(0, 2) : [62];
    // High, then Main, then Constrained Baseline.
    return ["6400", "4d00", "42e0"].flatMap((profile) => levels.map((level) => `avc1.${profile}${hex(level)}`));
  }
  const samples = width * height;
  const level = VP9_LEVELS.find(([, size, rate]) => samples <= size && samples * fps <= rate)?.[0] ?? 62;
  return [`vp09.00.${String(level).padStart(2, "0")}.08`, "vp09.00.10.08"];
}

export interface EncoderChoice {
  config: VideoEncoderConfig;
  /** Why no configuration was found, when `config` is missing. */
  error?: string;
}

/** The first encoder configuration the browser accepts for the format, or the reason none works. */
export async function chooseEncoder(
  format: Exclude<Format, "png">,
  width: number,
  height: number,
  fps: number,
  bitrate: number,
  quality: Quality = "good",
): Promise<{ config?: VideoEncoderConfig; error?: string }> {
  if (typeof VideoEncoder === "undefined") return { error: "This browser has no WebCodecs video encoder (it needs a secure context)." };
  // Ultra fast asks for the GPU's encoder in real-time mode; the others let the browser pick its best, then ask for the
  // GPU's (Android has no software H.264 encoder), whose rate control may only be constant.
  const accelerations = quality === "fast" ? (["prefer-hardware", "no-preference", "prefer-software"] as const) : (["no-preference", "prefer-software", "prefer-hardware"] as const);
  for (const codec of codecCandidates(format, width, height, fps)) {
    for (const [hardwareAcceleration, bitrateMode] of accelerations.flatMap((a) => [[a, "variable"], [a, "constant"]] as const)) {
      const config: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate,
        bitrateMode,
        framerate: fps,
        hardwareAcceleration,
        latencyMode: quality === "fast" ? "realtime" : "quality",
        ...(format === "h264" ? { avc: { format: "avc" } } : {}),
      } as VideoEncoderConfig;
      try {
        const support = await VideoEncoder.isConfigSupported(config);
        if (support.supported) return { config };
      } catch {
        // An invalid config for this browser; try the next one.
      }
    }
  }
  const name = format === "h264" ? "H.264" : "VP9";
  return { error: `This browser cannot encode ${name} at ${width} x ${height}, ${Math.round(fps * 100) / 100} fps.` };
}

export interface FormatSupport {
  format: Format;
  supported: boolean;
  codec?: string;
  note?: string;
}

/** Which output formats this browser can write at the given size, for the Output Module dialog. */
export async function probeFormats(width: number, height: number, fps: number): Promise<Record<Format, FormatSupport>> {
  const result: Record<Format, FormatSupport> = {
    png: { format: "png", supported: true },
    h264: { format: "h264", supported: false },
    vp9: { format: "vp9", supported: false },
  };
  for (const format of ["h264", "vp9"] as const) {
    const w = format === "h264" ? Math.max(2, width & ~1) : width;
    const h = format === "h264" ? Math.max(2, height & ~1) : height;
    const choice = await chooseEncoder(format, w, h, fps, 4e6);
    result[format] = choice.config ? { format, supported: true, codec: choice.config.codec } : { format, supported: false, note: choice.error };
  }
  return result;
}
