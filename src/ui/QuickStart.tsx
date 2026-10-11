// Quick Start: the template cards of the Home screen and the window that asks for the song,
// background and logo a template is built around (src/quickstart/).
import { useId, useRef, useState, type FormEvent } from "react";
import { QUICK_START_TEMPLATES, type QuickStartId, type QuickStartTemplate } from "../quickstart/catalog.ts";
import { PICTURE_ACCEPT, SONG_ACCEPT, type QuickStartFiles } from "../quickstart/create.ts";
import { Dialog } from "./Dialog.tsx";
import { Icon } from "./icons.tsx";
import "./quickStart.css";

const css = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;

/** The bar heights of a made-up spectrum, loud in the bass at the bottom of the ring and quieter towards the top. */
function bars(count: number, seed: number): number[] {
  return Array.from({ length: count }, (_, k) => {
    const t = k / (count - 1);
    const wobble = Math.abs(Math.sin(k * 1.7 + seed) * Math.cos(k * 0.45 + seed * 2));
    return (0.25 + 0.75 * wobble) * (1 - 0.6 * t);
  });
}

/** A drawing of what the template looks like, in its colours. */
export function QuickStartPreview({ template }: { template: QuickStartTemplate }) {
  const id = useId().replace(/:/g, "");
  const { palette } = template;
  const smooth = template.id === "trap-nation-2020";
  const [cx, cy, r] = [80, 45, 15];
  const count = smooth ? 48 : 30;
  // Half a ring from the bottom round the left to the top, mirrored to the right.
  const at = (k: number, radius: number, side: 1 | -1) => {
    const a = Math.PI / 2 + (side * Math.PI * k) / (count - 1);
    return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)];
  };
  const layers = palette.spectra.map((color, i) => {
    const reach = 1.35 - (0.35 * i) / Math.max(1, palette.spectra.length - 1);
    const heights = bars(count, i * 0.4 + (smooth ? 1 : 0)).map((h) => 2 + h * 16 * reach);
    if (smooth) {
      const outline = [1, -1].flatMap((side) => {
        const half = heights.map((h, k) => at(k, r + h, side as 1 | -1));
        return side === 1 ? half : half.reverse();
      });
      return <polygon key={i} points={outline.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")} fill={css(color)} />;
    }
    return (
      <g key={i} stroke={css(color)} strokeWidth={1.6} strokeLinecap="round">
        {[1, -1].flatMap((side) =>
          heights.map((h, k) => {
            const [x1, y1] = at(k, r + 0.5, side as 1 | -1);
            const [x2, y2] = at(k, r + h, side as 1 | -1);
            return <line key={`${side}-${k}`} x1={x1} y1={y1} x2={x2} y2={y2} />;
          }),
        )}
      </g>
    );
  });
  const dots = Array.from({ length: 22 }, (_, k) => [(k * 53.3) % 160, (k * 31.7 + 7) % 90, 0.4 + ((k * 7) % 5) / 6]);
  return (
    <svg className="qs-preview" viewBox="0 0 160 90" aria-hidden="true">
      <defs>
        <radialGradient id={`${id}-bg`}>
          <stop offset="0" stopColor={css(palette.background[0])} />
          <stop offset="1" stopColor={css(palette.background[1])} />
        </radialGradient>
        <radialGradient id={`${id}-logo`}>
          <stop offset="0" stopColor={css(palette.logo[0])} />
          <stop offset="1" stopColor={css(palette.logo[1])} />
        </radialGradient>
        <filter id={`${id}-glow`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width="160" height="90" fill={`url(#${id}-bg)`} />
      {dots.map(([x, y, s], k) => (
        <circle key={k} cx={x} cy={y} r={s} fill={css(palette.particles)} opacity={0.55} />
      ))}
      <g filter={smooth ? `url(#${id}-glow)` : undefined}>{layers}</g>
      <circle cx={cx} cy={cy} r={r} fill={`url(#${id}-logo)`} />
    </svg>
  );
}

/** The Home screen's Quick Start section: a card per template. */
export function QuickStartCards({ onChoose }: { onChoose: (id: QuickStartId) => void }) {
  return (
    <section className="home-quick-start" aria-label="Quick Start">
      <h2>Quick Start</h2>
      <p className="home-quick-start-lede">A music visualizer built around your song, ready to edit and to open in After Effects.</p>
      <ul>
        {QUICK_START_TEMPLATES.map((t) => (
          <li key={t.id}>
            <button type="button" className="qs-card" onClick={() => onChoose(t.id)}>
              <QuickStartPreview template={t} />
              <span className="qs-card-name">{t.name}</span>
              <span className="qs-card-summary">{t.summary}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FilePick({
  label,
  hint,
  accept,
  file,
  disabled,
  onFile,
}: {
  label: string;
  hint: string;
  accept: string;
  file: File | undefined;
  disabled: boolean;
  onFile: (file: File | undefined) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="qs-file">
      <span className="qs-file-label">{label}</span>
      <button type="button" className="ae-secondary" disabled={disabled} onClick={() => input.current?.click()}>
        Choose…
      </button>
      <span className={`qs-file-name ${file ? "" : "empty"}`}>{file?.name ?? hint}</span>
      {file && !disabled && (
        <button type="button" className="qs-file-clear" aria-label={`Clear ${label.toLowerCase()}`} onClick={() => onFile(undefined)}>
          <Icon name="close" size={9} />
        </button>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept={accept}
        aria-label={`${label} file`}
        onChange={(e) => {
          const picked = e.target.files?.[0];
          if (picked) onFile(picked);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** File > New > New Project from Template: the files the template is built around. */
export function QuickStartDialog({
  template,
  onCreate,
  onCancel,
}: {
  template: QuickStartTemplate;
  /** Builds and opens the project; rejects, saying why, when it cannot. */
  onCreate: (files: QuickStartFiles, particles: boolean) => Promise<void>;
  onCancel: () => void;
}) {
  const [song, setSong] = useState<File>();
  const [background, setBackground] = useState<File>();
  const [logo, setLogo] = useState<File>();
  const [particles, setParticles] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!song || working) return;
    setWorking(true);
    setError(undefined);
    try {
      await onCreate({ song, background, logo }, particles);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };
  const pick = (set: (file: File | undefined) => void) => (file: File | undefined) => {
    set(file);
    setError(undefined);
  };

  return (
    <Dialog title="New Project from Template" className="quick-start" onCancel={() => !working && onCancel()}>
      <form onSubmit={(e) => void submit(e)}>
        <div className="qs-head">
          <QuickStartPreview template={template} />
          <div>
            <h3>{template.name}</h3>
            <p>{template.summary}</p>
          </div>
        </div>
        <FilePick label="Song" hint="An MP3 or WAV file, or a movie with sound" accept={SONG_ACCEPT} file={song} disabled={working} onFile={pick(setSong)} />
        <FilePick label="Background" hint="Optional: a picture; a gradient otherwise" accept={PICTURE_ACCEPT} file={background} disabled={working} onFile={pick(setBackground)} />
        <FilePick label="Logo" hint="Optional: shown in the circle; the background otherwise" accept={PICTURE_ACCEPT} file={logo} disabled={working} onFile={pick(setLogo)} />
        <label className="qs-check">
          <input type="checkbox" checked={particles} disabled={working} onChange={(e) => setParticles(e.target.checked)} />
          Particles (Trapcode Particular in After Effects)
        </label>
        <p className="qs-hint">The ring, the bounce and the shake follow the song's bass, keyed on the Controls layer's Bass slider.</p>
        {error && (
          <p className="dialog-error" role="alert">
            <Icon name="warning" size={12} /> {error}
          </p>
        )}
        <div className="dialog-actions">
          {working && (
            <span className="qs-status" role="status">
              Building the project…
            </span>
          )}
          <span className="dialog-spacer" />
          <button type="button" className="ae-secondary" disabled={working} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="ae-primary" disabled={!song || working}>
            Create
          </button>
        </div>
      </form>
    </Dialog>
  );
}
