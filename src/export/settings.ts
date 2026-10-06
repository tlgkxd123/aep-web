import type { CompItem } from "../aep/model.ts";
import { scaledSize } from "../render/renderer.ts";

export type TimeSpan = "workArea" | "comp" | "custom";
/** Render resolution as AE's divisor: 1 Full, 2 Half, 3 Third, 4 Quarter. */
export type Resolution = 1 | 2 | 3 | 4;
export type Format = "h264" | "vp9" | "png";
export type Channels = "rgb" | "rgba";

export interface RenderSettings {
  resolution: Resolution;
  timeSpan: TimeSpan;
  /** Custom span start and duration in comp seconds; used when `timeSpan` is "custom". */
  customStart: number;
  customDuration: number;
  /** Output frames per second; null renders at the comp's frame rate. */
  frameRate: number | null;
}

export interface OutputModule {
  format: Format;
  channels: Channels;
  /** Target video bitrate in bits per second; null picks one from the frame size and rate. */
  bitrate: number | null;
}

export interface FormatInfo {
  label: string;
  extension: string;
  mime: string;
  alpha: boolean;
}

export const FORMATS: Record<Format, FormatInfo> = {
  h264: { label: "H.264", extension: "mp4", mime: "video/mp4", alpha: false },
  vp9: { label: "WebM (VP9)", extension: "webm", mime: "video/webm", alpha: true },
  png: { label: "PNG Sequence", extension: "zip", mime: "application/zip", alpha: true },
};

export const RESOLUTION_LABELS: Record<Resolution, string> = { 1: "Full", 2: "Half", 3: "Third", 4: "Quarter" };

export function defaultRenderSettings(comp: CompItem): RenderSettings {
  return { resolution: 1, timeSpan: "workArea", customStart: comp.workAreaStart, customDuration: comp.workAreaDuration, frameRate: null };
}

export function defaultOutputModule(): OutputModule {
  return { format: "h264", channels: "rgb", bitrate: null };
}

export interface FramePlan {
  start: number;
  duration: number;
  fps: number;
  frames: number;
  width: number;
  height: number;
  /** Render scale handed to the renderer. */
  scale: number;
  /** Comp time of output frame `index`. */
  time(index: number): number;
}

/** The frames a render produces: span, rate, count and pixel size before any codec cropping. */
export function framePlan(comp: CompItem, settings: RenderSettings): FramePlan {
  const span =
    settings.timeSpan === "comp"
      ? { start: 0, duration: comp.duration }
      : settings.timeSpan === "custom"
        ? { start: settings.customStart, duration: settings.customDuration }
        : { start: comp.workAreaStart, duration: comp.workAreaDuration };
  const fps = settings.frameRate && settings.frameRate > 0 ? settings.frameRate : comp.frameRate;
  const step = fps === comp.frameRate && comp.frameDuration > 0 ? comp.frameDuration : 1 / fps;
  const frames = Math.max(1, Math.round(span.duration / step - 1e-6));
  const scale = 1 / settings.resolution;
  return {
    start: span.start,
    duration: frames * step,
    fps,
    frames,
    width: scaledSize(comp.width, scale),
    height: scaledSize(comp.height, scale),
    scale,
    time: (index) => span.start + index * step,
  };
}

/** Output pixel size for a format: 4:2:0 H.264 needs even dimensions, so the last odd row/column is dropped. */
export function outputSize(plan: FramePlan, format: Format): { width: number; height: number } {
  if (format !== "h264") return { width: plan.width, height: plan.height };
  return { width: Math.max(2, plan.width & ~1), height: Math.max(2, plan.height & ~1) };
}

export function outputChannels(output: OutputModule): Channels {
  return FORMATS[output.format].alpha ? output.channels : "rgb";
}

/** A bitrate that keeps flat motion graphics and gradients clean: about 0.2 bits per pixel, 1 to 80 Mbps. */
export function autoBitrate(width: number, height: number, fps: number): number {
  return Math.round(Math.min(80e6, Math.max(1e6, width * height * fps * 0.2)));
}

export function defaultFileName(comp: CompItem, format: Format): string {
  const base = comp.name.replace(/[\\/:*?"<>|]+/g, "_").trim() || "Comp";
  return `${base}.${FORMATS[format].extension}`;
}

export function withExtension(fileName: string, format: Format): string {
  const ext = FORMATS[format].extension;
  const stem = fileName.replace(/\.(mp4|webm|zip)$/i, "");
  return `${stem}.${ext}`;
}
