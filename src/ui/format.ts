import { isGradientValue, isShapeValue, type PropertyValue, type Shape } from "../aep/model.ts";

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

const MASK_MODE_NAMES: Record<number, string> = {
  6812: "None", 6813: "Add", 6814: "Subtract", 6815: "Intersect", 6816: "Lighten", 6817: "Darken", 6818: "Difference",
};

const INTERPOLATION_NAMES: Record<number, string> = { 6612: "Linear", 6613: "Bezier", 6614: "Hold" };

const CONTROL_TYPE_NAMES: Record<number, string> = {
  0: "Layer", 1: "Integer", 2: "Slider", 3: "Angle", 4: "Checkbox", 5: "Color", 6: "Point",
  7: "Popup", 9: "No data", 10: "Float slider", 11: "Custom data", 12: "Mask", 13: "Group",
  14: "Group end", 15: "Button", 18: "3D point",
};

export const blendingModeName = (mode: number) => BLENDING_MODE_NAMES[mode] ?? `#${mode}`;
export const trackMatteName = (type: number) => TRACK_MATTE_NAMES[type] ?? `#${type}`;
export const maskModeName = (mode: number) => MASK_MODE_NAMES[mode] ?? `#${mode}`;
export const interpolationName = (type: number) => INTERPOLATION_NAMES[type] ?? `#${type}`;
export const controlTypeName = (type: number | undefined) =>
  type === undefined ? "" : (CONTROL_TYPE_NAMES[type] ?? `type ${type}`);

/** After Effects label colours, indexed by the 0-16 label value stored on items and layers. */
export const LABEL_COLORS: readonly string[] = [
  "#7b7b7b", "#b53838", "#e4d84c", "#a9cbc7", "#e5bcc9", "#a9a9ca", "#e7c19e", "#b3c7b3", "#677de0",
  "#4aa44c", "#8e2c9a", "#e8920d", "#7f452a", "#f46dd6", "#3da2a5", "#a89677", "#1e401e",
];

export const LABEL_NAMES: readonly string[] = [
  "None", "Red", "Yellow", "Aqua", "Pink", "Lavender", "Peach", "Sea Foam", "Blue", "Green", "Purple",
  "Orange", "Brown", "Fuchsia", "Cyan", "Sandstone", "Dark Green",
];

export const labelColor = (label: number) => LABEL_COLORS[label] ?? LABEL_COLORS[0];
export const labelName = (label: number) => LABEL_NAMES[label] ?? LABEL_NAMES[0];

/** The project header stores colour depth as 0/1/2 for 8/16/32 bits per channel. */
export function bitsPerChannel(raw: number): number {
  return raw === 0 ? 8 : raw === 1 ? 16 : raw === 2 ? 32 : raw;
}

export function num(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const rounded = Math.round(n * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** Fixed decimals without a negative zero, the way AE prints hot-text numbers. */
export function fixed(n: number, digits = 1): string {
  const text = n.toFixed(digits);
  return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
}

/** Degrees as AE's revolutions-plus-degrees form, e.g. `1x+45.0°`. */
export function rotationLabel(degrees: number): string {
  const turns = Math.trunc(degrees / 360);
  const rest = degrees - turns * 360;
  return `${turns}x${rest < 0 ? "-" : "+"}${fixed(Math.abs(rest))}°`;
}

/** Frame rate with two decimals, as in `24.00 fps`. */
export const fpsLabel = (frameRate: number) => frameRate.toFixed(2);

/** Frame rate for a table column: `24`, `29.97`. */
export const fpsShort = (frameRate: number) => (frameRate ? String(Number(frameRate.toFixed(2))) : "");

export function isShape(value: PropertyValue): value is Shape {
  return isShapeValue(value);
}

export function formatValue(value: PropertyValue): string {
  if (value === null) return "";
  if (typeof value === "number") return num(value);
  if (Array.isArray(value)) return value.map(num).join(", ");
  if (isShape(value)) return `${value.closed ? "closed" : "open"} path, ${value.vertices.length} vertices`;
  if (isGradientValue(value)) return `gradient, ${value.colorStops.length} color stops`;
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

/** Frame number padded like AE's sub-label under the current time, e.g. `00042`. */
export function frameLabel(seconds: number, frameRate: number): string {
  const frames = Math.round(seconds * frameRate);
  return `${frames < 0 ? "-" : ""}${String(Math.abs(frames)).padStart(5, "0")}`;
}

/**
 * Parses what a user types into a time field: `0:00:01:12`, `1:12`, `;`-separated drop-frame style,
 * or a bare frame count. Returns seconds, or undefined when the text is not a time.
 */
export function parseTimecode(text: string, frameRate: number): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const fps = Math.round(frameRate) || 1;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed) / frameRate;
  const parts = trimmed.split(/[:;.]/);
  if (parts.some((p) => !/^\d+$/.test(p)) || parts.length > 4) return undefined;
  const [frames = 0, secs = 0, mins = 0, hours = 0] = parts.map(Number).reverse();
  return ((hours * 3600 + mins * 60 + secs) * fps + frames) / frameRate;
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
