import type { PropertyValue, Shape } from "../aep/model.ts";

const BLENDING_MODE_NAMES: Record<number, string> = {
  5212: "Normal", 5213: "Dissolve", 5214: "Dancing Dissolve", 5215: "Darken", 5216: "Multiply",
  5217: "Linear Burn", 5218: "Color Burn", 5219: "Classic Color Burn", 5220: "Add", 5221: "Lighten",
  5222: "Screen", 5223: "Linear Dodge", 5224: "Color Dodge", 5225: "Classic Color Dodge", 5226: "Overlay",
  5227: "Soft Light", 5228: "Hard Light", 5229: "Linear Light", 5230: "Vivid Light", 5231: "Pin Light",
  5232: "Hard Mix", 5233: "Difference", 5234: "Classic Difference", 5235: "Exclusion", 5236: "Hue",
  5237: "Saturation", 5238: "Color", 5239: "Luminosity", 5240: "Stencil Alpha", 5241: "Stencil Luma",
  5242: "Silhouette Alpha", 5243: "Silhouette Luma", 5244: "Alpha Add", 5245: "Luminescent Premul",
  5246: "Lighter Color", 5247: "Darker Color", 5248: "Subtract", 5249: "Divide",
};

const TRACK_MATTE_NAMES: Record<number, string> = {
  5012: "", 5013: "Alpha", 5014: "Alpha Inverted", 5015: "Luma", 5016: "Luma Inverted",
};

const INTERPOLATION_NAMES: Record<number, string> = { 6612: "linear", 6613: "bezier", 6614: "hold" };

const CONTROL_TYPE_NAMES: Record<number, string> = {
  0: "Layer", 1: "Integer", 2: "Slider", 3: "Angle", 4: "Checkbox", 5: "Color", 6: "Point",
  7: "Popup", 9: "No data", 10: "Float slider", 11: "Custom data", 12: "Mask", 13: "Group",
  14: "Group end", 15: "Button", 18: "3D point",
};

export const blendingModeName = (mode: number) => BLENDING_MODE_NAMES[mode] ?? `#${mode}`;
export const trackMatteName = (type: number) => TRACK_MATTE_NAMES[type] ?? `#${type}`;
export const interpolationName = (type: number) => INTERPOLATION_NAMES[type] ?? `#${type}`;
export const controlTypeName = (type: number | undefined) =>
  type === undefined ? "" : (CONTROL_TYPE_NAMES[type] ?? `type ${type}`);

export function num(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const rounded = Math.round(n * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

export function isShape(value: PropertyValue): value is Shape {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function formatValue(value: PropertyValue): string {
  if (value === null) return "";
  if (typeof value === "number") return num(value);
  if (Array.isArray(value)) return value.map(num).join(", ");
  if (isShape(value)) return `${value.closed ? "closed" : "open"} path, ${value.vertices.length} vertices`;
  return "";
}

/** Seconds as `0:00:01:12` timecode at the given frame rate. */
export function timecode(seconds: number, frameRate: number): string {
  const fps = Math.round(frameRate) || 1;
  const totalFrames = Math.round(seconds * frameRate);
  const sign = totalFrames < 0 ? "-" : "";
  const abs = Math.abs(totalFrames);
  const frames = abs % fps;
  const totalSeconds = Math.floor(abs / fps);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sign}${Math.floor(totalSeconds / 3600)}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}:${pad(frames)}`;
}

export function colorCss(rgb: number[]): string {
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgb(${c(rgb[0])}, ${c(rgb[1])}, ${c(rgb[2])})`;
}

export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
