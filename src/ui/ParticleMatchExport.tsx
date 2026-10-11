// Export to Particular, the Particle Match window's last step: the learned model as Trapcode Particular
// layers, added to a composition of the open project or saved as a new After Effects project together with
// the soundtrack their Physics Time Factor follows (src/extra/pmatch/particularExport.ts).
import { useEffect, useId, useRef, useState } from "react";
import type { CompItem, Project } from "../aep/model.ts";
import type { Editor } from "../edit/editor.ts";
import { DEFAULT_COMP_SETTINGS, validateCompSettings, type FootageFile } from "../edit/project.ts";
import type { ParticleWorldModel } from "../extra/pmatch/model.ts";
import { particularSettings, type ParticularSettings, type ParticularTarget } from "../extra/pmatch/particular.ts";
import { addParticularLayers, compTarget, layerSound, particularProject, soundLayers } from "../extra/pmatch/particularExport.ts";
import { fileSound, type Sound } from "../extra/pmatch/soundtrack.ts";
import { identifyLocal } from "../media/localFootage.ts";
import { probeMedia } from "../media/probe.ts";
import { Icon } from "./icons.tsx";
import { saveFileBytes } from "./projectFiles.ts";

/** The open project, which the export can add layers to. */
export interface ParticleMatchProject {
  editor: Editor;
  project: Project;
  activeCompId?: number;
  /** Shows the layers the export added; the window closes after it. */
  onAdded(compId: number, layerIds: number[]): void;
}

/** A sound being read, read, or absent (null: none the browser can decode). */
export type SoundState = Sound | null | "reading";

/** The reference video as the export uses it. */
export interface ExportReference {
  file: File;
  width: number;
  height: number;
  frameRate: number;
  duration: number;
  sound: SoundState;
}

/** The export's choices, kept with the window's session for the next export. */
export interface ExportChoices {
  destination: "comp" | "file";
  compId?: number;
  /** "layer:<id>", "reference", "file" or "none". */
  sound: string;
  /** An audio file chosen to drive a new project. */
  audio?: { file: File; sound: SoundState };
  includeSoundtrack: boolean;
  name: string;
  width: string;
  height: string;
  frameRate: string;
  duration: string;
  /** Whether the duration still follows the chosen sound's length. */
  durationAuto: boolean;
}

/** Seconds of a new project's comp without a sound to take its length from. */
const DEFAULT_DURATION = 30;
/** How long saving waits for a soundtrack's path on disk before recording its name for After Effects to ask about. */
const LOCATE_WAIT_MS = 4000;

const located = new WeakMap<File, Promise<string | null>>();

/** Where a picked file is on this machine (the dev server's footage service), looked up once per file. */
export function locateFile(file: File): Promise<string | null> {
  let path = located.get(file);
  if (!path) located.set(file, (path = identifyLocal([file]).then(([p]) => p ?? null, () => null)));
  return path;
}
const AUDIO_ACCEPT = ".mp3,.wav,.mp4,.m4v,.mov,audio/mpeg,audio/wav,video/mp4,video/quicktime";
const NTSC = [24000 / 1001, 30000 / 1001, 48000 / 1001, 60000 / 1001];

const baseName = (name: string) => name.replace(/\.[^./\\]+$/, "");
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const rateText = (fps: number) => String(Math.round(fps * 100) / 100);
/** A typed frame rate, exact for the NTSC rates (29.97 is 30000/1001). */
const parseRate = (text: string) => {
  const fps = Number(text);
  return NTSC.find((r) => Math.abs(r - fps) < 0.006) ?? fps;
};
const soundOf = (state: SoundState | undefined) => (state && state !== "reading" ? state : null);

export function defaultChoices(model: ParticleWorldModel, reference: ExportReference | undefined, project: ParticleMatchProject | undefined): ExportChoices {
  const comps = project ? [...project.project.items.values()].filter((i): i is CompItem => i.kind === "comp") : [];
  const source = reference ?? model.source;
  return {
    destination: comps.length ? "comp" : "file",
    compId: comps.find((c) => c.id === project?.activeCompId)?.id ?? comps[0]?.id,
    sound: "",
    includeSoundtrack: true,
    name: "Particle Match",
    width: String(source.width),
    height: String(source.height),
    frameRate: rateText(NTSC.find((r) => Math.abs(r - source.frameRate) < 0.006) ?? source.frameRate),
    duration: "",
    durationAuto: true,
  };
}

interface SoundOption {
  value: string;
  label: string;
}

type Status = { kind: "idle" } | { kind: "working"; text: string } | { kind: "done"; text: string; note?: string } | { kind: "error"; text: string };

function Summary({ settings, soundLabel }: { settings: ParticularSettings; soundLabel: string }) {
  const n = settings.layers.length;
  const factor = settings.timeFactor;
  const classes = settings.layers.map((l) => `${/\((\w+)\)/.exec(l.name)?.[1] ?? l.name} ${Math.round(l.share * 100)} %`);
  return (
    <ul className="pm-creates">
      <li>
        {plural(n, "Particular layer")}
        {n > 1 && <span className="dim"> · by speed: {classes.join(", ")} of the particles</span>}
      </li>
      {settings.mirror && <li>A Mirror on each at x = {Math.round(settings.mirror[0])}, as the reference is mirrored</li>}
      <li>
        {Array.isArray(factor) ? (
          <>
            Physics Time Factor keyed {plural(factor.length, "time")} from {soundLabel}
          </>
        ) : (
          <>Physics Time Factor {factor} (a constant speed)</>
        )}
      </li>
    </ul>
  );
}

export function ParticleMatchExport({
  model,
  reference,
  project,
  choices,
  onChoices,
  onBack,
  onDone,
}: {
  model: ParticleWorldModel;
  reference: ExportReference | undefined;
  project: ParticleMatchProject | undefined;
  choices: ExportChoices;
  onChoices: (choices: ExportChoices) => void;
  onBack: () => void;
  /** After layers were added to a comp. */
  onDone: () => void;
}) {
  const id = useId();
  const audioInputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  // Set on every mount: StrictMode mounts, unmounts and mounts again.
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [layerSounds, setLayerSounds] = useState<ReadonlyMap<string, SoundState>>(new Map());
  const [preview, setPreview] = useState<{ key: string; settings: ParticularSettings } | { key: string; error: string }>();
  const set = (patch: Partial<ExportChoices>) => {
    onChoices({ ...choices, ...patch });
    if (status.kind !== "working") setStatus({ kind: "idle" });
  };

  const comps = project ? [...project.project.items.values()].filter((i): i is CompItem => i.kind === "comp") : [];
  const comp = comps.find((c) => c.id === choices.compId) ?? comps[0];
  const toComp = choices.destination === "comp" && !!project && !!comp;
  const destination = toComp ? "comp" : "file";
  const referenceSound = soundOf(reference?.sound);
  const audio = choices.audio;

  const options: SoundOption[] = [];
  if (toComp) {
    if (comp && project) for (const l of soundLayers(project.project, comp)) options.push({ value: `layer:${l.id}`, label: `Layer ${l.index}: ${l.name}` });
    if (referenceSound) options.push({ value: "reference", label: "The reference video's sound, from 0:00" });
  } else {
    if (referenceSound) options.push({ value: "reference", label: "The reference video's sound" });
    options.push({ value: "file", label: audio ? `Audio file: ${audio.file.name}` : "An audio file…" });
  }
  options.push({ value: "none", label: "Nothing: a constant speed" });
  const sound = options.some((o) => o.value === choices.sound) ? choices.sound : options[0].value;
  const soundLayer = sound.startsWith("layer:") && comp ? comp.layers.find((l) => l.id === Number(sound.slice(6))) : undefined;
  const layerKey = soundLayer && comp ? `${comp.id}:${soundLayer.id}:${comp.duration}` : "";

  // A layer's sound is read once it is chosen.
  useEffect(() => {
    if (!soundLayer || !comp || !project || layerSounds.has(layerKey)) return;
    setLayerSounds((m) => new Map(m).set(layerKey, "reading"));
    const done = (state: SoundState) => mounted.current && setLayerSounds((m) => new Map(m).set(layerKey, state));
    layerSound(project.project, soundLayer, comp.duration).then(done, () => done(null));
  }, [layerKey, soundLayer, comp, project, layerSounds]);

  const soundState: SoundState | undefined =
    sound === "reference" ? reference?.sound : sound === "file" ? audio?.sound : soundLayer ? layerSounds.get(layerKey) : undefined;
  const soundLabel = sound === "reference" ? "the reference video's sound" : sound === "file" ? `“${audio?.file.name ?? ""}”` : soundLayer ? `“${soundLayer.name}”` : "";
  const features = soundOf(soundState)?.features ?? null;
  const soundProblem =
    sound === "none"
      ? null
      : soundState === "reading"
        ? `Reading ${soundLabel}…`
        : sound === "file" && !audio
          ? "Choose the audio file the particles follow."
          : soundState === null || soundState === undefined
            ? `${soundLabel.charAt(0).toUpperCase()}${soundLabel.slice(1)} has no sound this browser can read${soundLayer ? " (is its footage missing?)" : ""}.`
            : null;

  // A new project's comp; its duration follows the sound until edited.
  const autoDuration = soundOf(soundState)?.duration ?? reference?.duration ?? DEFAULT_DURATION;
  const duration = choices.durationAuto ? autoDuration : Number(choices.duration);
  const compSettings = {
    ...DEFAULT_COMP_SETTINGS,
    name: choices.name,
    width: Number(choices.width),
    height: Number(choices.height),
    frameRate: parseRate(choices.frameRate),
    duration,
  };
  let settingsError: string | null = null;
  if (!toComp) {
    try {
      validateCompSettings(compSettings);
    } catch (e) {
      settingsError = (e as Error).message;
    }
  }

  const target: ParticularTarget | null = toComp
    ? compTarget(comp)
    : settingsError
      ? null
      : { width: compSettings.width, height: compSettings.height, frameRate: compSettings.frameRate, duration: compSettings.duration, zoom: compSettings.width / 0.72 };
  const targetKey = target ? `${target.width}x${target.height}@${target.frameRate}:${target.duration}:${target.zoom}` : "";
  const previewKey = `${targetKey}|${sound}|${features ? "sound" : "none"}`;
  const ready = !!target && !soundProblem;

  // The settings are worked out off the keystroke: the first one runs the audio network over the whole sound.
  useEffect(() => {
    if (!target || soundProblem) return;
    const timer = setTimeout(() => {
      try {
        setPreview({ key: previewKey, settings: particularSettings(model, target, features) });
      } catch (e) {
        setPreview({ key: previewKey, error: (e as Error).message });
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [model, previewKey, features]);
  const shown = preview?.key === previewKey ? preview : undefined;

  const pickAudio = (file: File) => {
    const next = { ...choices, sound: "file", audio: { file, sound: "reading" as SoundState } };
    onChoices(next);
    void locateFile(file);
    void fileSound(file).then(
      (s) => mounted.current && onChoices({ ...next, audio: { file, sound: s } }),
      () => mounted.current && onChoices({ ...next, audio: { file, sound: null } }),
    );
  };

  const fail = (what: string, e: unknown) => setStatus({ kind: "error", text: `${what}: ${e instanceof Error ? e.message : String(e)}` });

  const add = async () => {
    if (!project || !comp) return;
    const live = project.editor.project.items.get(comp.id);
    if (live?.kind !== "comp") return setStatus({ kind: "error", text: `The composition “${comp.name}” is no longer in the project.` });
    setStatus({ kind: "working", text: `Adding the layers to “${live.name}”…` });
    try {
      const { ids } = await addParticularLayers(project.editor, live, model, features);
      project.onAdded(live.id, ids);
      onDone();
    } catch (e) {
      fail("The layers could not be added", e);
    }
  };

  const soundtrackFile = !choices.includeSoundtrack ? null : sound === "reference" ? (reference?.file ?? null) : sound === "file" ? (audio?.file ?? null) : null;

  const save = async () => {
    setStatus({ kind: "working", text: "Building the project…" });
    try {
      let soundtrack: FootageFile | null = null;
      let unlocated = false;
      if (soundtrackFile) {
        setStatus({ kind: "working", text: `Finding “${soundtrackFile.name}” on this computer…` });
        const path = await Promise.race([locateFile(soundtrackFile), new Promise<null>((resolve) => setTimeout(() => resolve(null), LOCATE_WAIT_MS))]);
        setStatus({ kind: "working", text: "Building the project…" });
        soundtrack = { path: path ?? soundtrackFile.name, info: await probeMedia(soundtrackFile, soundtrackFile.name) };
        unlocated = !path;
      }
      const { bytes } = await particularProject(model, { comp: compSettings, soundtrack, features });
      const name = `${baseName(reference?.file.name ?? model.source.name).slice(0, 80) || "Particle Match"} - Particular`;
      const saved = await saveFileBytes(bytes, name, "After Effects Project", ".aep");
      if (!mounted.current) return;
      if (!saved) return setStatus({ kind: "idle" });
      setStatus({
        kind: "done",
        text: `Saved “${saved}”. Open it in After Effects with Trapcode Particular installed.`,
        note: unlocated && soundtrackFile ? `After Effects will ask where “${soundtrackFile.name}” is when it opens the project.` : undefined,
      });
    } catch (e) {
      if (mounted.current) fail("The project could not be saved", e);
    }
  };

  const working = status.kind === "working";
  const layerCount = shown && "settings" in shown ? shown.settings.layers.length : 0;
  const disabled = working || !ready || !shown || "error" in shown;
  const field = (key: "name" | "width" | "height" | "frameRate", label: string, className = "") => (
    <input id={`${id}-${key}`} className={`ae-field ${className}`} aria-label={label} value={choices[key]} onChange={(e) => set({ [key]: e.target.value } as Partial<ExportChoices>)} />
  );

  return (
    <>
      <div className="pm-side-body pm-export">
        <button type="button" className="pm-back" onClick={onBack} disabled={working}>
          <Icon name="back" size={12} /> Back to the result
        </button>
        <h3>Export to Trapcode Particular</h3>
        <p className="dim">One Particular layer per speed class, set up to reproduce the learned particles.</p>

        <fieldset className="pm-section" disabled={working}>
          <legend>Destination</legend>
          <label className={`pm-choice ${!project || !comps.length ? "unavailable" : ""}`}>
            <input
              type="radio"
              name={`${id}-dest`}
              checked={destination === "comp"}
              disabled={!project || !comps.length}
              onChange={() => set({ destination: "comp" })}
            />
            <span>Add to a composition</span>
          </label>
          {destination === "comp" && (
            <select className="ae-field pm-indent" aria-label="Composition" value={comp.id} onChange={(e) => set({ compId: Number(e.target.value) })}>
              {comps.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.width} × {c.height})
                </option>
              ))}
            </select>
          )}
          {(!project || !comps.length) && (
            <p className="pm-hint pm-indent">{project ? "This project has no composition yet." : "Open or create a project to add the layers to one of its compositions."}</p>
          )}
          <label className="pm-choice">
            <input type="radio" name={`${id}-dest`} checked={destination === "file"} onChange={() => set({ destination: "file" })} />
            <span>Save as a new project (.aep)</span>
          </label>
        </fieldset>

        {destination === "file" && (
          <fieldset className="pm-section pm-form" disabled={working}>
            <legend>Composition</legend>
            <label htmlFor={`${id}-name`}>Name</label>
            {field("name", "Composition name")}
            <label htmlFor={`${id}-width`}>Size</label>
            <span className="pm-pair">
              {field("width", "Width", "pm-num")}
              <span className="dim">×</span>
              {field("height", "Height", "pm-num")}
              <span className="dim">px</span>
            </span>
            <label htmlFor={`${id}-frameRate`}>Frame rate</label>
            <span className="pm-pair">
              {field("frameRate", "Frame rate", "pm-num")}
              <span className="dim">fps</span>
            </span>
            <label htmlFor={`${id}-duration`}>Duration</label>
            <span className="pm-pair">
              <input
                id={`${id}-duration`}
                className="ae-field pm-num"
                aria-label="Duration (seconds)"
                value={choices.durationAuto ? String(Math.round(autoDuration * 100) / 100) : choices.duration}
                onChange={(e) => set({ duration: e.target.value, durationAuto: false })}
              />
              <span className="dim">s</span>
              {!choices.durationAuto && (
                <button type="button" className="pm-link" onClick={() => set({ duration: "", durationAuto: true })}>
                  Match the sound
                </button>
              )}
            </span>
            {settingsError && <p className="pm-field-error">{settingsError}</p>}
          </fieldset>
        )}

        <fieldset className="pm-section" disabled={working}>
          <legend>Speed follows</legend>
          <select
            className="ae-field"
            aria-label="Speed follows"
            value={sound}
            onChange={(e) => {
              if (e.target.value === "file" && !audio) audioInputRef.current?.click();
              set({ sound: e.target.value });
            }}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {sound === "file" && (
            <button type="button" className="pm-link" onClick={() => audioInputRef.current?.click()}>
              {audio ? "Choose another audio file…" : "Choose an audio file…"}
            </button>
          )}
          <input
            ref={audioInputRef}
            type="file"
            accept={AUDIO_ACCEPT}
            aria-label="Audio file"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) pickAudio(file);
              e.target.value = "";
            }}
          />
          <p className="pm-hint">Physics Time Factor is keyed so the particles speed up and slow down with this sound, as they did in the reference.</p>
          {destination === "file" && (sound === "reference" || sound === "file") && (
            <label className="pm-check">
              <input type="checkbox" checked={choices.includeSoundtrack} onChange={(e) => set({ includeSoundtrack: e.target.checked })} />
              <span>{sound === "reference" ? "Include the reference video (hidden, with its sound)" : "Include the audio file as a layer"}</span>
            </label>
          )}
        </fieldset>

        <section className="pm-section" aria-live="polite">
          <h4>Creates</h4>
          {soundProblem ? (
            <p className={soundState === "reading" ? "pm-hint" : "pm-field-error"}>{soundProblem}</p>
          ) : settingsError ? (
            <p className="pm-hint">Fix the composition settings to see what the export creates.</p>
          ) : shown && "settings" in shown ? (
            <Summary settings={shown.settings} soundLabel={soundLabel} />
          ) : shown ? (
            <p className="pm-field-error">{shown.error}</p>
          ) : (
            <p className="pm-hint">Working out the settings…</p>
          )}
          <p className="pm-hint">The layers need Trapcode Particular in After Effects.</p>
        </section>
      </div>

      <div className="pm-side-foot">
        {status.kind === "error" && (
          <p className="pm-error" role="alert">
            <Icon name="warning" size={14} /> {status.text}
          </p>
        )}
        {status.kind === "done" && (
          <p className="pm-done" role="status">
            <Icon name="check" size={14} /> {status.text}
            {status.note && <span className="dim"> {status.note}</span>}
          </p>
        )}
        {status.kind === "working" && (
          <p className="pm-hint" role="status">
            {status.text}
          </p>
        )}
        <div className="pm-actions">
          {toComp ? (
            <button type="button" className="ae-primary" disabled={disabled} onClick={() => void add()}>
              {layerCount ? `Add ${plural(layerCount, "Layer")}` : "Add Layers"}
            </button>
          ) : (
            <button type="button" className="ae-primary" disabled={disabled} onClick={() => void save()}>
              Save .aep…
            </button>
          )}
        </div>
      </div>
    </>
  );
}
