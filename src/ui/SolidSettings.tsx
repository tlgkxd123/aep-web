import { useState, type FormEvent } from "react";
import type { CompItem, Project } from "../aep/model.ts";
import { autoName, solidColorName } from "../edit/layers.ts";
import { Dialog } from "./Dialog.tsx";
import { colorCss } from "./format.ts";
import { Icon } from "./icons.tsx";

export interface SolidSpec {
  name: string;
  width: number;
  height: number;
  pixelAspect: number;
  color: [number, number, number];
}

/** AE's pixel aspect ratio presets, as the Solid Settings popup lists them. */
const PIXEL_ASPECTS: [string, number][] = [
  ["Square Pixels", 1],
  ["D1/DV NTSC (0.91)", 0.9091],
  ["D1/DV NTSC Widescreen (1.21)", 1.2121],
  ["D1/DV PAL (1.09)", 1.0940],
  ["D1/DV PAL Widescreen (1.46)", 1.4587],
  ["Anamorphic 2:1 (2)", 2],
  ["HDV 1080/DVCPRO HD 720 (1.33)", 1.3333],
  ["DVCPRO HD 1080 (1.5)", 1.5],
];

const MAX_SIZE = 30000;

/** Remembered across dialogs, as AE keeps the last solid colour. */
let lastColor: [number, number, number] = [0.5, 0.5, 0.5];

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** "16:9 (1.78)", AE's frame aspect ratio readout. */
export function frameAspectText(width: number, height: number, pixelAspect: number): string {
  if (!(width > 0 && height > 0)) return "";
  const w = Math.round(width * pixelAspect);
  const d = gcd(w, height) || 1;
  return `${w / d}:${height / d} (${((width * pixelAspect) / height).toFixed(2)})`;
}

const hex = (c: [number, number, number]) => `#${c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
const fromHex = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];

const presetFor = (par: number) => PIXEL_ASPECTS.find(([, v]) => Math.abs(v - par) < 0.001);

/** Layer > New > Solid: AE's Solid Settings dialog, defaulting to the comp's size. */
export function SolidSettings({
  project,
  comp,
  onOk,
  onCancel,
}: {
  project: Project;
  comp: CompItem;
  onOk: (solid: SolidSpec) => void;
  onCancel: () => void;
}) {
  const [color, setColor] = useState(lastColor);
  const [typedName, setTypedName] = useState<string>();
  const [width, setWidth] = useState(String(comp.width));
  const [height, setHeight] = useState(String(comp.height));
  const [pixelAspect, setPixelAspect] = useState(presetFor(comp.pixelAspect)?.[1] ?? comp.pixelAspect);
  const [lock, setLock] = useState(false);
  const names = [...project.items.values()].map((i) => i.name);
  const name = typedName ?? autoName(solidColorName(color), names);
  const w = Number(width);
  const h = Number(height);
  const valid = Number.isInteger(w) && Number.isInteger(h) && w >= 1 && h >= 1 && w <= MAX_SIZE && h <= MAX_SIZE && name.trim() !== "";
  const ratio = frameAspectText(w, h, pixelAspect);
  const percent = (v: number, of: number) => (v > 0 && of > 0 ? `${((v / of) * 100).toFixed(1)}%` : "");

  const setSize = (axis: "w" | "h", text: string) => {
    const value = Number(text);
    if (axis === "w") {
      setWidth(text);
      if (lock && w > 0 && h > 0 && value > 0) setHeight(String(Math.max(1, Math.round((value * h) / w))));
    } else {
      setHeight(text);
      if (lock && w > 0 && h > 0 && value > 0) setWidth(String(Math.max(1, Math.round((value * w) / h))));
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    lastColor = color;
    onOk({ name: name.trim(), width: w, height: h, pixelAspect, color });
  };

  return (
    <Dialog title="Solid Settings" className="solid-dialog" onCancel={onCancel}>
      <form className="sd-form" onSubmit={submit}>
        <label className="sd-row sd-name">
          <span>Name:</span>
          <input className="ae-field" value={name} autoFocus onFocus={(e) => e.currentTarget.select()} onChange={(e) => setTypedName(e.target.value)} />
        </label>
        <fieldset className="sd-group">
          <legend>Size</legend>
          <div className="sd-size">
            <div className="sd-dims">
              <label className="sd-row">
                <span>Width:</span>
                <input className="ae-field sd-num" inputMode="numeric" value={width} aria-label="Width" onChange={(e) => setSize("w", e.target.value)} />
                <span className="dim">px</span>
              </label>
              <label className="sd-row">
                <span>Height:</span>
                <input className="ae-field sd-num" inputMode="numeric" value={height} aria-label="Height" onChange={(e) => setSize("h", e.target.value)} />
                <span className="dim">px</span>
              </label>
            </div>
            <label className="sd-lock">
              <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} />
              <span className="ae-check-box" aria-hidden="true">
                {lock && <Icon name="check" size={10} />}
              </span>
              Lock Aspect Ratio to {ratio}
            </label>
          </div>
          <label className="sd-row">
            <span>Units:</span>
            <select className="ae-field" value="pixels" aria-label="Units" onChange={() => {}}>
              <option value="pixels">pixels</option>
            </select>
          </label>
          <label className="sd-row">
            <span>Pixel Aspect Ratio:</span>
            <select
              className="ae-field"
              aria-label="Pixel Aspect Ratio"
              value={String(pixelAspect)}
              onChange={(e) => setPixelAspect(Number(e.target.value))}
            >
              {!presetFor(pixelAspect) && <option value={String(pixelAspect)}>{`Custom (${pixelAspect.toFixed(2)})`}</option>}
              {PIXEL_ASPECTS.map(([label, value]) => (
                <option key={label} value={String(value)}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <dl className="sd-readout">
            <dt>Width:</dt>
            <dd>{percent(w, comp.width)} of comp</dd>
            <dt>Height:</dt>
            <dd>{percent(h, comp.height)} of comp</dd>
            <dt>Frame Aspect Ratio:</dt>
            <dd>{ratio}</dd>
          </dl>
          <button
            type="button"
            className="ae-secondary sd-comp-size"
            onClick={() => {
              setWidth(String(comp.width));
              setHeight(String(comp.height));
              setPixelAspect(presetFor(comp.pixelAspect)?.[1] ?? comp.pixelAspect);
            }}
          >
            Make Comp Size
          </button>
        </fieldset>
        <fieldset className="sd-group">
          <legend>Color</legend>
          <label className="sd-color">
            <input type="color" aria-label="Solid color" value={hex(color)} onChange={(e) => setColor(fromHex(e.target.value))} />
            <span className="sd-swatch" style={{ background: colorCss(color) }} />
            <Icon name="eyedropper" size={14} className="dim" />
          </label>
        </fieldset>
        <div className="dialog-actions sd-actions">
          <button type="button" className="ae-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="ae-primary" disabled={!valid}>
            OK
          </button>
        </div>
      </form>
    </Dialog>
  );
}
