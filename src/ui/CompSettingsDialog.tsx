import { useMemo, useRef, useState, type FormEvent } from "react";
import { validateCompSettings, type CompSettings } from "../edit/project.ts";
import { colorCss, timecode } from "./format.ts";
import { Icon } from "./icons.tsx";
import { Dialog } from "./Dialog.tsx";

const ntsc = (n: number) => (n * 1000) / 1001;

interface Preset {
  name: string;
  width: number;
  height: number;
  pixelAspect: number;
  frameRate: number;
}

/** AE 2025's composition presets (frame size, pixel aspect and rate). */
const PRESETS: Preset[] = [
  { name: "Social Media Portrait HD · 1080x1920 · 30 fps", width: 1080, height: 1920, pixelAspect: 1, frameRate: 30 },
  { name: "Social Media Square HD · 1080x1080 · 30 fps", width: 1080, height: 1080, pixelAspect: 1, frameRate: 30 },
  { name: "Social Media Landscape HD · 1920x1080 · 30 fps", width: 1920, height: 1080, pixelAspect: 1, frameRate: 30 },
  { name: "HD · 1280x720 · 25 fps", width: 1280, height: 720, pixelAspect: 1, frameRate: 25 },
  { name: "HD · 1280x720 · 29.97 fps", width: 1280, height: 720, pixelAspect: 1, frameRate: ntsc(30) },
  { name: "HD · 1280x720 · 59.94 fps", width: 1280, height: 720, pixelAspect: 1, frameRate: ntsc(60) },
  { name: "HD · 1920x1080 · 23.976 fps", width: 1920, height: 1080, pixelAspect: 1, frameRate: ntsc(24) },
  { name: "HD · 1920x1080 · 24 fps", width: 1920, height: 1080, pixelAspect: 1, frameRate: 24 },
  { name: "HD · 1920x1080 · 25 fps", width: 1920, height: 1080, pixelAspect: 1, frameRate: 25 },
  { name: "HD · 1920x1080 · 29.97 fps", width: 1920, height: 1080, pixelAspect: 1, frameRate: ntsc(30) },
  { name: "HD · 1920x1080 · 50 fps", width: 1920, height: 1080, pixelAspect: 1, frameRate: 50 },
  { name: "HD · 1920x1080 · 59.94 fps", width: 1920, height: 1080, pixelAspect: 1, frameRate: ntsc(60) },
  { name: "UHD · 3840x2160 · 23.976 fps", width: 3840, height: 2160, pixelAspect: 1, frameRate: ntsc(24) },
  { name: "UHD · 3840x2160 · 24 fps", width: 3840, height: 2160, pixelAspect: 1, frameRate: 24 },
  { name: "UHD · 3840x2160 · 25 fps", width: 3840, height: 2160, pixelAspect: 1, frameRate: 25 },
  { name: "UHD · 3840x2160 · 29.97 fps", width: 3840, height: 2160, pixelAspect: 1, frameRate: ntsc(30) },
  { name: "UHD · 3840x2160 · 59.94 fps", width: 3840, height: 2160, pixelAspect: 1, frameRate: ntsc(60) },
  { name: "UHD 8K · 7680x4320 · 23.976 fps", width: 7680, height: 4320, pixelAspect: 1, frameRate: ntsc(24) },
  { name: "NTSC DV", width: 720, height: 480, pixelAspect: 10 / 11, frameRate: ntsc(30) },
  { name: "NTSC DV Widescreen", width: 720, height: 480, pixelAspect: 40 / 33, frameRate: ntsc(30) },
  { name: "PAL D1/DV", width: 720, height: 576, pixelAspect: 59 / 54, frameRate: 25 },
  { name: "PAL D1/DV Widescreen", width: 720, height: 576, pixelAspect: 118 / 81, frameRate: 25 },
  { name: "Cineon Half", width: 1828, height: 1332, pixelAspect: 1, frameRate: 24 },
  { name: "Cineon Full", width: 3656, height: 2664, pixelAspect: 1, frameRate: 24 },
  { name: "Film (2K)", width: 2048, height: 1556, pixelAspect: 1, frameRate: 24 },
  { name: "Film (4K)", width: 4096, height: 3112, pixelAspect: 1, frameRate: 24 },
];

const PIXEL_ASPECTS: { name: string; value: number }[] = [
  { name: "Square Pixels", value: 1 },
  { name: "D1/DV NTSC (0.91)", value: 10 / 11 },
  { name: "D1/DV NTSC Widescreen (1.21)", value: 40 / 33 },
  { name: "D1/DV PAL (1.09)", value: 59 / 54 },
  { name: "D1/DV PAL Widescreen (1.46)", value: 118 / 81 },
  { name: "HDV 1080/DVCPRO HD 720 (1.33)", value: 4 / 3 },
  { name: "DVCPRO HD 1080 (1.5)", value: 1.5 },
  { name: "Anamorphic 2:1 (2)", value: 2 },
];

const FRAME_RATES = ["8", "10", "12", "12.5", "15", "23.976", "24", "25", "29.97", "30", "48", "50", "59.94", "60", "120"];

const RESOLUTIONS: { name: string; factor: number }[] = [
  { name: "Full", factor: 1 },
  { name: "Half", factor: 2 },
  { name: "Third", factor: 3 },
  { name: "Quarter", factor: 4 },
];

const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

/** "29.97" → 30000/1001, like AE's frame-rate field. */
export function parseFrameRate(text: string): number | undefined {
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value <= 0) return undefined;
  for (const base of [24, 30, 48, 60, 120]) if (near(value, ntsc(base), 0.0015)) return ntsc(base);
  return value;
}

export const frameRateText = (fps: number) => String(Number(fps.toFixed(3)));

/**
 * A timecode typed into the dialog, in frames: `0:00:10:00`, or digits that fill
 * the fields from the right like AE (`1000` is 0:00:10:00).
 */
export function parseTimecodeFrames(text: string, frameRate: number): number | undefined {
  const base = Math.round(frameRate) || 1;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let parts: number[];
  if (/^\d+$/.test(trimmed)) {
    const digits = trimmed.padStart(8, "0");
    const n = digits.length;
    parts = [digits.slice(0, n - 6), digits.slice(n - 6, n - 4), digits.slice(n - 4, n - 2), digits.slice(n - 2)].map(Number);
  } else {
    const fields = trimmed.split(/[:;.]/);
    if (fields.length > 4 || fields.some((f) => !/^\d+$/.test(f))) return undefined;
    parts = fields.map(Number);
    while (parts.length < 4) parts.unshift(0);
  }
  const [h, m, s, f] = parts;
  return ((h * 60 + m) * 60 + s) * base + f;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

function aspectLabel(width: number, height: number): string {
  if (!(width > 0 && height > 0)) return "";
  const w = Math.round(width);
  const h = Math.round(height);
  const d = gcd(w, h);
  const ratio = (width / height).toFixed(2);
  return w / d <= 64 && h / d <= 64 ? `${w / d}:${h / d} (${ratio})` : ratio;
}

const hex = (rgb: [number, number, number]) => `#${rgb.map((c) => Math.round(c * 255).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (value: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as [number, number, number];
const colorName = (rgb: [number, number, number]) => (rgb.every((c) => c === 0) ? "Black" : rgb.every((c) => c === 1) ? "White" : "");

/** Composition > New Composition / Composition Settings: AE's Basic tab. */
export function CompSettingsDialog({
  initial,
  bitsPerChannel,
  onOK,
  onCancel,
}: {
  initial: CompSettings;
  bitsPerChannel: number;
  onOK: (settings: CompSettings) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [width, setWidth] = useState(String(initial.width));
  const [height, setHeight] = useState(String(initial.height));
  const [lock, setLock] = useState(true);
  const [pixelAspect, setPixelAspect] = useState(initial.pixelAspect);
  const [fps, setFps] = useState(frameRateText(initial.frameRate));
  const [resolution, setResolution] = useState(initial.resolutionFactor);
  const rate = parseFrameRate(fps) ?? initial.frameRate;
  const [start, setStart] = useState(timecode(initial.displayStartTime, initial.frameRate));
  const [duration, setDuration] = useState(timecode(initial.duration, initial.frameRate));
  const [bg, setBg] = useState(initial.bgColor);
  const [error, setError] = useState<string>();
  const colorInput = useRef<HTMLInputElement>(null);
  /** The frame size whose aspect ratio the lock keeps. */
  const locked = useRef([initial.width, initial.height]);

  const w = Number(width);
  const h = Number(height);
  const [lw, lh] = lock ? locked.current : [w, h];
  const preset = PRESETS.find((p) => p.width === w && p.height === h && near(p.pixelAspect, pixelAspect) && near(p.frameRate, rate))?.name ?? "Custom";
  const pixelAspects = PIXEL_ASPECTS.some((p) => near(p.value, pixelAspect))
    ? PIXEL_ASPECTS
    : [...PIXEL_ASPECTS, { name: `Custom (${pixelAspect.toFixed(2)})`, value: pixelAspect }];
  const resolutionName = resolution[0] === resolution[1] ? (RESOLUTIONS.find((r) => r.factor === resolution[0])?.name ?? "Custom") : "Custom";
  const base = Math.round(rate) || 1;
  const startFrames = parseTimecodeFrames(start, rate);
  const durationFrames = parseTimecodeFrames(duration, rate);
  const memory = useMemo(() => {
    if (!(w > 0 && h > 0)) return "";
    const rw = Math.ceil(w / resolution[0]);
    const rh = Math.ceil(h / resolution[1]);
    const bytes = rw * rh * 4 * (bitsPerChannel / 8);
    return `${rw} x ${rh}, ${(bytes / 1024 / 1024).toFixed(1)} MB per ${bitsPerChannel}bpc frame`;
  }, [w, h, resolution, bitsPerChannel]);

  const changeWidth = (value: string) => {
    setWidth(value);
    const n = Number(value);
    if (lock && n > 0) setHeight(String(Math.max(1, Math.round((n * lh) / lw))));
  };
  const changeHeight = (value: string) => {
    setHeight(value);
    const n = Number(value);
    if (lock && n > 0) setWidth(String(Math.max(1, Math.round((n * lw) / lh))));
  };
  const toggleLock = (on: boolean) => {
    setLock(on);
    if (w > 0 && h > 0) locked.current = [w, h];
  };
  const choosePreset = (presetName: string) => {
    const p = PRESETS.find((x) => x.name === presetName);
    if (!p) return;
    setWidth(String(p.width));
    setHeight(String(p.height));
    locked.current = [p.width, p.height];
    setPixelAspect(p.pixelAspect);
    setFps(frameRateText(p.frameRate));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const frameRate = parseFrameRate(fps);
    if (frameRate === undefined) return setError("Frame rate must be a number of frames per second");
    if (startFrames === undefined) return setError("Start Timecode is not a timecode");
    if (durationFrames === undefined) return setError("Duration is not a timecode");
    const settings: CompSettings = {
      name: name.trim(),
      width: Number(width),
      height: Number(height),
      pixelAspect,
      frameRate,
      duration: durationFrames / frameRate,
      bgColor: bg,
      resolutionFactor: resolution,
      displayStartTime: startFrames / frameRate,
    };
    try {
      validateCompSettings(settings);
    } catch (err) {
      return setError((err as Error).message);
    }
    onOK(settings);
  };

  return (
    <Dialog title="Composition Settings" className="comp-settings" onCancel={onCancel}>
      <form onSubmit={submit}>
        <div className="cs-name">
          <label htmlFor="cs-name">Composition Name:</label>
          <input id="cs-name" className="ae-field" value={name} autoFocus onFocus={(e) => e.target.select()} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="cs-tabs" role="tablist">
          <button type="button" role="tab" aria-selected="true" className="cs-tab front">
            Basic
          </button>
          <button type="button" role="tab" aria-selected="false" className="cs-tab" disabled title="Not available in this editor yet">
            Advanced
          </button>
          <button type="button" role="tab" aria-selected="false" className="cs-tab" disabled title="Not available in this editor yet">
            3D Renderer
          </button>
        </div>
        <div className="cs-body">
          <div className="cs-row">
            <label htmlFor="cs-preset">Preset:</label>
            <select id="cs-preset" className="ae-field cs-preset" value={preset} onChange={(e) => choosePreset(e.target.value)}>
              <option value="Custom">Custom</option>
              {PRESETS.map((p) => (
                <option key={p.name}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="cs-size">
            <div className="cs-row">
              <label htmlFor="cs-width">Width:</label>
              <input id="cs-width" className="ae-field cs-num" inputMode="numeric" value={width} onChange={(e) => changeWidth(e.target.value)} />
              <span className="dim">px</span>
            </div>
            <label className="cs-lock">
              <input type="checkbox" checked={lock} onChange={(e) => toggleLock(e.target.checked)} />
              Lock Aspect Ratio to {aspectLabel(lw, lh)}
            </label>
            <div className="cs-row">
              <label htmlFor="cs-height">Height:</label>
              <input id="cs-height" className="ae-field cs-num" inputMode="numeric" value={height} onChange={(e) => changeHeight(e.target.value)} />
              <span className="dim">px</span>
            </div>
          </div>
          <div className="cs-row">
            <label htmlFor="cs-par">Pixel Aspect Ratio:</label>
            <select id="cs-par" className="ae-field" value={pixelAspects.findIndex((p) => near(p.value, pixelAspect))} onChange={(e) => setPixelAspect(pixelAspects[Number(e.target.value)].value)}>
              {pixelAspects.map((p, i) => (
                <option key={p.name} value={i}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="cs-aside">
              <span className="dim">Frame Aspect Ratio:</span> {aspectLabel(w * pixelAspect, h)}
            </span>
          </div>
          <div className="cs-row">
            <label htmlFor="cs-fps">Frame Rate:</label>
            <input id="cs-fps" className="ae-field cs-num" list="cs-fps-list" value={fps} onChange={(e) => setFps(e.target.value)} />
            <datalist id="cs-fps-list">
              {FRAME_RATES.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
            <span className="dim">frames per second</span>
          </div>
          <div className="cs-row">
            <label htmlFor="cs-res">Resolution:</label>
            <select
              id="cs-res"
              className="ae-field"
              value={resolutionName}
              onChange={(e) => {
                const r = RESOLUTIONS.find((x) => x.name === e.target.value);
                if (r) setResolution([r.factor, r.factor]);
              }}
            >
              {RESOLUTIONS.map((r) => (
                <option key={r.name}>{r.name}</option>
              ))}
              {resolutionName === "Custom" && <option>Custom</option>}
            </select>
            <span className="dim">{memory}</span>
          </div>
          <div className="cs-sep" />
          <div className="cs-row">
            <label htmlFor="cs-start">Start Timecode:</label>
            <input id="cs-start" className="ae-field cs-tc" value={start} onChange={(e) => setStart(e.target.value)} />
            <span className="dim">
              {startFrames !== undefined && `is ${timecode(startFrames / rate, rate)}`} Base {base}
            </span>
          </div>
          <div className="cs-row">
            <label htmlFor="cs-duration">Duration:</label>
            <input id="cs-duration" className="ae-field cs-tc" value={duration} onChange={(e) => setDuration(e.target.value)} />
            <span className="dim">
              {durationFrames !== undefined && `is ${timecode(durationFrames / rate, rate)}`} Base {base}
            </span>
          </div>
          <div className="cs-sep" />
          <div className="cs-row">
            <span className="cs-label" id="cs-bg-label">
              Background Color:
            </span>
            <button
              type="button"
              className="cs-swatch"
              aria-labelledby="cs-bg-label"
              style={{ background: colorCss(bg) }}
              onClick={() => colorInput.current?.click()}
            />
            <input ref={colorInput} type="color" className="cs-color" aria-label="Background color value" value={hex(bg)} onChange={(e) => setBg(fromHex(e.target.value))} tabIndex={-1} />
            <span className="cs-eyedropper" aria-hidden="true">
              <Icon name="eyedropper" size={14} />
            </span>
            <span>{colorName(bg)}</span>
          </div>
        </div>
        {error && (
          <p className="dialog-error" role="alert">
            <Icon name="warning" size={12} /> {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="ae-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="ae-primary">
            OK
          </button>
        </div>
      </form>
    </Dialog>
  );
}
